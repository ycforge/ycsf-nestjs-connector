import { Module, type Type } from "@nestjs/common";
import {
  createYandexHandler,
  type ClosableYandexCloudFunctionHandler,
} from "../core/create-yandex-handler";
import { resolveInvocationQueueBatch } from "../context/invocation-scope";
import { YandexContext } from "../context/yandex-context.decorator";
import type { YandexExecutionContext } from "../context/yandex-execution-context";
import type { QueueBatch } from "./message";
import { QueueHandler } from "./queue-handler.decorator";
// Merged export: the decorator factory plus the normalized message type.
import { QueueMessage } from "./queue-message.decorator";
import type { RawQueueEvent, RawQueueMessageEvent } from "./raw-event";

/**
 * Integration specs for Message Queue handler dispatch through the public
 * connector API (issue #8): real NestJS bootstraps, real dependency
 * injection, real invocation scopes — covering exactly the behaviors the
 * transport-level specs cannot observe from inside user code.
 *
 * Fixtures mirror the sanitized captured trigger shape (DATA-ANALYSE.md
 * section C) — placeholder ids only, no captured credentials or payload data.
 */

const QUEUE_ID = "yrn:yc:ymq:ru-central1:b1g00000000000000000:f-test";
const EVENT_ID = "7f3a-c91d2e4b6a83405fb1d09c7-52d4e8";

const RUNTIME_CONTEXT = {
  awsRequestId: "f18fed85-7096-4f0e-a6db-e2c5e37e925f",
  functionName: "fn-mq-dispatch-integration",
  functionVersion: "$LATEST",
  functionFolderId: "folder-fixture",
  memoryLimitInMB: "1024",
  deadlineMs: 1787328996791,
  logGroupName: "",
};

function makeMessageEnvelope(messageId: string = EVENT_ID): RawQueueMessageEvent {
  return {
    event_metadata: {
      event_id: messageId,
      event_type: "yandex.cloud.events.messagequeue.QueueMessage",
      created_at: "2026-08-21T21:44:34.266Z",
      tracing_context: null,
      cloud_id: "a1b2c3d4000000000000",
      folder_id: "e5f6a7b8000000000000",
    },
    details: {
      queue_id: QUEUE_ID,
      message: {
        message_id: messageId,
        md5_of_body: "9e107d9d372bb6826bd81d3542a419d6",
        body: '{"orderId":"order-fixture","items":3}',
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "1787328274187",
        },
        message_attributes: {},
        md5_of_message_attributes: "",
      },
    },
  };
}

function makeQueueDelivery(...messageIds: string[]): RawQueueEvent {
  return {
    messages: (messageIds.length > 0 ? messageIds : [EVENT_ID]).map((id) =>
      makeMessageEnvelope(id),
    ),
  };
}

interface ObservedRound {
  messageId?: string;
  requestId?: string;
  rawMessageIdentity?: unknown;
  scopedBatchRawIdentity?: unknown;
}

/**
 * Records every handler round. Statics keep assertions independent of how
 * Nest scopes the instances; they are reset before every spec.
 */
class RecordingConsumer {
  static readonly rounds: ObservedRound[] = [];

  handle(message: QueueMessage, executionContext: YandexExecutionContext): void {
    RecordingConsumer.rounds.push({
      messageId: message?.messageId,
      requestId: executionContext?.awsRequestId,
      rawMessageIdentity: message?.raw,
      scopedBatchRawIdentity: resolveInvocationQueueBatch().raw,
    });
  }
}

const RECORDING_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  RecordingConsumer.prototype,
  "handle",
)!;
QueueHandler()(RecordingConsumer.prototype, "handle", RECORDING_DESCRIPTOR);
QueueMessage()(RecordingConsumer.prototype, "handle", 0);
YandexContext()(RecordingConsumer.prototype, "handle", 1);

class FailingConsumer {
  handle(message: QueueMessage): void {
    throw new Error(`fixture handler rejected ${String(message.messageId)}`);
  }
}

const FAILING_DESCRIPTOR = Object.getOwnPropertyDescriptor(FailingConsumer.prototype, "handle")!;
QueueHandler()(FailingConsumer.prototype, "handle", FAILING_DESCRIPTOR);
QueueMessage()(FailingConsumer.prototype, "handle", 0);

class RecordingModule {}
Module({ providers: [RecordingConsumer] })(RecordingModule);

class FailingModule {}
Module({ providers: [FailingConsumer] })(FailingModule);

describe("queue handler dispatch through the public runtime", () => {
  const runtimes: ClosableYandexCloudFunctionHandler[] = [];

  beforeEach(() => {
    RecordingConsumer.rounds.length = 0;
  });

  afterEach(async () => {
    while (runtimes.length > 0) {
      await runtimes.pop()?.close();
    }
  });

  function makeRuntime(
    appModule: Type<unknown> = RecordingModule,
  ): ClosableYandexCloudFunctionHandler {
    const runtime = createYandexHandler(appModule);
    runtimes.push(runtime);
    return runtime;
  }

  it("delivers every message of a multi-message batch to the handler in order", async () => {
    const runtime = makeRuntime();
    const delivery = makeQueueDelivery("m-one", "m-two", "m-three");

    const result = (await runtime(delivery, RUNTIME_CONTEXT)) as QueueBatch;

    // Sequential fan-out over the whole batch: one handler round per
    // message, in delivery order, regardless of the trigger's current
    // grouped-message limit of 1 (**observed**, DATA-ANALYSE.md section C).
    expect(RecordingConsumer.rounds.map((round) => round.messageId)).toEqual([
      "m-one",
      "m-two",
      "m-three",
    ]);
    expect(result.messages).toHaveLength(3);
    await runtime.close();
  });

  it("injects @QueueMessage() and @YandexContext() through real dependency injection", async () => {
    const runtime = makeRuntime();
    const delivery = makeQueueDelivery();

    await runtime(delivery, RUNTIME_CONTEXT);

    const round = RecordingConsumer.rounds[0];
    expect(round?.messageId).toBe(EVENT_ID);
    expect(round?.requestId).toBe(RUNTIME_CONTEXT.awsRequestId);
    await runtime.close();
  });

  it("hands the untouched raw references to user code", async () => {
    const runtime = makeRuntime();
    const delivery = makeQueueDelivery();

    await runtime(delivery, RUNTIME_CONTEXT);

    // The raw escape hatches survive all the way into handler parameters
    // (AGENTS.md section 36): the message keeps its exact raw envelope and
    // the invocation-scoped batch keeps the untouched delivery object.
    expect(RecordingConsumer.rounds[0]?.rawMessageIdentity).toBe(delivery.messages[0]);
    expect(RecordingConsumer.rounds[0]?.scopedBatchRawIdentity).toBe(delivery);
    await runtime.close();
  });

  it("keeps handler observations isolated across sequential invocations", async () => {
    const runtime = makeRuntime();

    await runtime(makeQueueDelivery("seq-first"), RUNTIME_CONTEXT);
    expect(RecordingConsumer.rounds.map((round) => round.messageId)).toEqual(["seq-first"]);

    await runtime(makeQueueDelivery("seq-second"), RUNTIME_CONTEXT);
    expect(RecordingConsumer.rounds.map((round) => round.messageId)).toEqual([
      "seq-first",
      "seq-second",
    ]);
    await runtime.close();
  });

  it("pairs each message with its own invocation context under concurrency", async () => {
    const runtime = makeRuntime();
    const ids = ["cc-first", "cc-second", "cc-third"];

    await Promise.all(
      ids.map(async (messageId, index) => {
        const context = {
          ...RUNTIME_CONTEXT,
          awsRequestId: `concurrent-request-${index}`,
        };
        await runtime(makeQueueDelivery(messageId), context);
      }),
    );

    // Warm-application concurrency: every recorded round pairs the message
    // of one invocation with THAT invocation's execution context — never a
    // sibling's (AGENTS.md section 11).
    expect(RecordingConsumer.rounds).toHaveLength(ids.length);
    for (const round of RecordingConsumer.rounds) {
      const index = ids.indexOf(round.messageId ?? "");
      expect(round.requestId).toBe(`concurrent-request-${index}`);
    }
    await runtime.close();
  });

  it("propagates handler failures as failed invocations", async () => {
    const runtime = makeRuntime(FailingModule);

    // Failures must stay failures so Yandex Message Queue retry/dead-letter
    // configuration observes them (AGENTS.md section 8.2) — the original
    // error surfaces unwrapped, not absorbed into a successful response.
    await expect(runtime(makeQueueDelivery("doomed-id"), RUNTIME_CONTEXT)).rejects.toThrow(
      "fixture handler rejected doomed-id",
    );
    await runtime.close();
  });

  it("resolves successful dispatch to the batch without HTTP response semantics", async () => {
    const runtime = makeRuntime();

    const result = (await runtime(makeQueueDelivery(), RUNTIME_CONTEXT)) as Record<string, unknown>;

    // A queue delivery has no response envelope: the result carries the
    // normalized batch only, never status codes or header maps.
    expect(Object.keys(result)).toEqual(expect.arrayContaining(["messages", "raw"]));
    expect(result).not.toHaveProperty("statusCode");
    expect(result).not.toHaveProperty("isBase64Encoded");
    expect(result).not.toHaveProperty("headers");
    await runtime.close();
  });
});
