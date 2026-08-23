import { createHash } from "node:crypto";
import { Module } from "@nestjs/common";
import {
  resolveInvocationExecutionContext,
  resolveInvocationQueueBatch,
} from "../context/invocation-scope";
import type { YandexExecutionContext } from "../context/yandex-execution-context";
import { ConnectorError } from "../core/connector-error";
import { createYandexHandler } from "../core/create-yandex-handler";
import type { QueueBatch } from "./message";
import { QueueHandler } from "./queue-handler.decorator";
// Merged export: decorator factory plus the normalized message type it injects.
import { QueueMessage } from "./queue-message.decorator";
import { loadQueueFixture, type QueueInvocationFixture } from "../testing/invocation-fixtures";

/**
 * Conformance suite against sanitized captured Message Queue trigger
 * invocations (issue #11).
 *
 * Every JSON file under `fixtures/mq/` is a full warm-invocation dump of a
 * real queue trigger delivery (provenance and sanitization:
 * fixtures/README.md), replayed through the PUBLIC runtime exactly as Yandex
 * calls it. The tests pin the observed trigger contract end to end: metadata
 * relations (`event_id === message_id`, ISO `created_at` equal to the epoch-ms
 * `SentTimestamp` attribute), string-typed system attributes, user message
 * attribute normalization without value coercion, checksums over UTF-8 bytes,
 * opaque bodies with opt-in strict-JSON payloads, and batch-capable
 * normalization even though the trigger currently delivers one message at a
 * time (AGENTS.md section 4.6).
 *
 * Failure propagation semantics are pinned separately by
 * `mq-failure-propagation.spec.ts` (issue #10); this suite only records them
 * where a fixture's body shape demands it (plain-text payload access).
 */

interface CapturedRound {
  readonly message: QueueMessage;
  readonly executionContext: YandexExecutionContext;
}

const ROUNDS: CapturedRound[] = [];

class RecordingConsumer {
  record(message: QueueMessage): void {
    ROUNDS.push({
      message,
      // Resolved inside the invocation scope so isolation comes from the same
      // mechanism production uses, not from test bookkeeping.
      executionContext: resolveInvocationExecutionContext(),
    });
    // Touching the batch through the scope proves both models are published
    // together for every round.
    resolveInvocationQueueBatch();
  }
}

QueueHandler()(
  RecordingConsumer.prototype,
  "record",
  Object.getOwnPropertyDescriptor(RecordingConsumer.prototype, "record")!,
);
QueueMessage()(RecordingConsumer.prototype, "record", 0);

class ConsumeModule {}

Module({ providers: [RecordingConsumer] })(ConsumeModule);

const PAYLOAD_FAILURES: unknown[] = [];
const PAYLOAD_RAW_BODIES: string[] = [];
const PAYLOAD_MESSAGE_IDS: string[] = [];

/**
 * Deliberately swallows the payload error AFTER recording it: this probe pins
 * lazy payload evaluation semantics (which error class surfaces, raw body
 * preserved); invocation-failing propagation is covered by issue #10's suite.
 */
class PayloadProbeConsumer {
  probe(message: QueueMessage): void {
    PAYLOAD_MESSAGE_IDS.push(message.messageId);
    try {
      void message.payload;
    } catch (error) {
      PAYLOAD_FAILURES.push(error);
    }
    PAYLOAD_RAW_BODIES.push(message.body);
    // Recorded so the shared replay helper can locate this round uniformly.
    ROUNDS.push({ message, executionContext: resolveInvocationExecutionContext() });
  }
}

QueueHandler()(
  PayloadProbeConsumer.prototype,
  "probe",
  Object.getOwnPropertyDescriptor(PayloadProbeConsumer.prototype, "probe")!,
);
QueueMessage()(PayloadProbeConsumer.prototype, "probe", 0);

class ProbeModule {}

Module({ providers: [PayloadProbeConsumer] })(ProbeModule);

interface ReplayResult {
  readonly fixture: QueueInvocationFixture;
  readonly captured: CapturedRound;
  readonly resolved: unknown;
  readonly close: () => Promise<void>;
}

async function replay(
  name: string,
  module: typeof ConsumeModule = ConsumeModule,
): Promise<ReplayResult> {
  const fixture = await loadQueueFixture(name);
  const handler = createYandexHandler(module);
  const resolved = await handler(fixture.event, fixture.context);
  const captured = ROUNDS[ROUNDS.length - 1];
  if (!captured) {
    throw new Error(`fixture "${name}" produced no handler round`);
  }
  return {
    fixture,
    captured,
    resolved,
    close: () => handler.close(),
  };
}

const ALL_QUEUE_FIXTURE_NAMES = [
  "simple-text-message",
  "json-body-message",
  "unicode-body-message",
  "custom-message-attributes",
  "complete-metadata-and-system-attributes",
] as const;

describe("Message Queue conformance fixtures (issue #11)", () => {
  beforeEach(() => {
    ROUNDS.length = 0;
    PAYLOAD_FAILURES.length = 0;
    PAYLOAD_RAW_BODIES.length = 0;
    PAYLOAD_MESSAGE_IDS.length = 0;
  });

  afterEach(async () => {
    // Nothing to close here: each replay closes its own handler eagerly so
    // warm-state assertions below are attributable to explicit sequences.
  });

  it("replays every committed MQ fixture as a successful normalized delivery", async () => {
    expect(ALL_QUEUE_FIXTURE_NAMES).toHaveLength(5);
    for (const name of ALL_QUEUE_FIXTURE_NAMES) {
      const { resolved, close } = await replay(name);
      await close();

      // Success resolves to the normalized batch — never an HTTP envelope.
      expect(resolved).not.toHaveProperty("statusCode");
      expect(resolved).not.toHaveProperty("body");
      expect(resolved).not.toHaveProperty("isBase64Encoded");
      const batch = resolved as QueueBatch;
      expect(batch.messages).toHaveLength(1);
    }
    expect(ROUNDS).toHaveLength(ALL_QUEUE_FIXTURE_NAMES.length);
  });

  it("preserves identity, checksums and opaque bodies of simple messages", async () => {
    const { fixture, captured, close } = await replay("simple-text-message");
    await close();

    const envelope = fixture.event.messages[0]!.details;
    const { message, executionContext } = captured;

    expect(message.messageId).toBe(envelope.message.message_id);
    expect(message.body).toBe("Hello from Yandex Message Queue!");
    expect(message.md5OfBody).toBe(envelope.message.md5_of_body);
    // event_id and message_id are observed identical on the real trigger.
    expect(fixture.event.messages[0]!.event_metadata.event_id).toBe(message.messageId);
    expect(executionContext.awsRequestId).toBe(fixture.context.awsRequestId);
    // The raw escape hatch exposes the untouched envelope.
    expect((message.raw as { details?: unknown }).details).toBe(envelope);
  });

  it("keeps system attributes string-typed and ties created_at to SentTimestamp", async () => {
    const { fixture, captured, close } = await replay("complete-metadata-and-system-attributes");
    await close();

    const metadata = fixture.event.messages[0]!.event_metadata;
    const { message } = captured;

    expect(Object.keys(message.attributes)).toEqual([
      "ApproximateFirstReceiveTimestamp",
      "ApproximateReceiveCount",
      "SenderId",
      "SentTimestamp",
    ]);
    for (const value of Object.values(message.attributes)) {
      expect(typeof value).toBe("string");
    }
    // Observed relation: ISO created_at equals the epoch-millisecond
    // SentTimestamp attribute; ApproximateReceiveCount starts at "1".
    expect(Number.parseInt(message.attributes.SentTimestamp!, 10)).toBe(
      Date.parse(metadata.created_at),
    );
    expect(message.attributes.ApproximateReceiveCount).toBe("1");
    expect(metadata.tracing_context).toBeNull();
    expect(message.eventMetadata.tracingContext).toBeNull();
    expect(message.eventMetadata.cloudId).toBe(metadata.cloud_id);
    expect(message.eventMetadata.folderId).toBe(metadata.folder_id);
    // No user attributes: the observed checksum placeholder is the empty string.
    expect(message.md5OfMessageAttributes).toBe("");
    expect(message.queueId).toBe(fixture.event.messages[0]!.details.queue_id);
    expect(message.payload).toEqual({});
  });

  it("deserializes json bodies strictly and keeps unicode bodies byte-faithful", async () => {
    const json = await replay("json-body-message");
    await json.close();
    expect(json.captured.message.body).toBe('{"orderId":"order-conf-1","items":3,"paid":true}');
    expect(json.captured.message.payload).toEqual({
      orderId: "order-conf-1",
      items: 3,
      paid: true,
    });

    const unicode = await replay("unicode-body-message");
    await unicode.close();
    const { message } = unicode.captured;
    expect(message.body).toBe('{"text":"привет мир 🌍","tags":["тест","😀"]}');
    expect(message.payload).toEqual({ text: "привет мир 🌍", tags: ["тест", "😀"] });
    // md5_of_body is computed over the UTF-8 encoding of the body.
    expect(createUtf8Md5(message.body)).toBe(message.md5OfBody);
  });

  it("normalizes custom message attributes without coercing their values", async () => {
    const { fixture, captured, close } = await replay("custom-message-attributes");
    await close();

    const wireAttributes = fixture.event.messages[0]!.details.message.message_attributes;
    const { message } = captured;

    expect(message.messageAttributes.Scenario).toEqual({
      dataType: "String",
      stringValue: "retry",
    });
    // Number-typed attributes keep their string_value verbatim ("1" stays "1").
    expect(message.messageAttributes.Attempt).toEqual({ dataType: "Number", stringValue: "1" });
    expect(message.messageAttributes.Attempt?.stringValue).not.toBe(1);
    expect(wireAttributes.Scenario).toEqual({
      data_type: "String",
      string_value: "retry",
    });
    // The committed checksum matches the SQS-compatible algorithm YMQ mirrors
    // (evidence level: inferred — see fixtures/README.md).
    expect(message.md5OfMessageAttributes).toBeTruthy();
  });

  it("reports QUEUE_BODY_DESERIALIZATION_FAILED lazily for non-json bodies", async () => {
    const { close } = await replay("simple-text-message", ProbeModule);
    await close();

    expect(PAYLOAD_MESSAGE_IDS).toHaveLength(1);
    const failure = PAYLOAD_FAILURES[0];
    expect(failure).toBeInstanceOf(ConnectorError);
    expect((failure as ConnectorError).code).toBe("QUEUE_BODY_DESERIALIZATION_FAILED");
    // The failing evaluation leaves the raw body intact for user code.
    expect(PAYLOAD_RAW_BODIES[0]).toBe("Hello from Yandex Message Queue!");
  });

  it("redacts the service-account token through context serialization", async () => {
    const { fixture, captured, close } = await replay("json-body-message");
    await close();

    expect(JSON.stringify(captured.executionContext)).not.toContain("[REDACTED]");
    expect(captured.executionContext.toJSON().token).toBe("REDACTED_TOKEN");
    // The undocumented _data mirror of the raw event stays reachable.
    expect((captured.executionContext.raw as { _data?: unknown })._data).toEqual(fixture.event);
  });

  it("isolates sequential replays across warm invocations", async () => {
    const first = await replay("simple-text-message");
    const second = await replay("unicode-body-message");
    first.close();
    second.close();

    const [firstRound, secondRound] = [ROUNDS[0], ROUNDS[1]];
    expect(firstRound!.executionContext.awsRequestId).not.toBe(
      secondRound!.executionContext.awsRequestId,
    );
    // Invocation N's data must not leak into invocation N+1 (AGENTS.md 11).
    expect(secondRound!.executionContext.awsRequestId).toBe(second.fixture.context.awsRequestId);
    expect(secondRound!.message.messageId).not.toBe(firstRound!.message.messageId);
  });

  it("isolates concurrent replays of all fixtures", async () => {
    const results = await Promise.all(ALL_QUEUE_FIXTURE_NAMES.map((name) => replay(name)));
    await Promise.all(results.map((result) => result.close()));

    // Concurrent rounds interleave, so correlate by message id instead of
    // push order: every round must pair its own fixture's request id.
    const requestIdByMessageId = new Map(
      results.map((result) => [
        result.fixture.event.messages[0]!.details.message.message_id,
        result.fixture.context.awsRequestId,
      ]),
    );
    expect(requestIdByMessageId.size).toBe(results.length);
    expect(ROUNDS).toHaveLength(results.length);
    for (const round of ROUNDS) {
      expect(round.executionContext.awsRequestId).toBe(
        requestIdByMessageId.get(round.message.messageId),
      );
    }
  });
});

function createUtf8Md5(input: string): string {
  // Local re-computation keeps the assertion independent of any crypto helper
  // the connector might grow; Node guarantees this API.
  return createHash("md5").update(Buffer.from(input, "utf8")).digest("hex");
}
