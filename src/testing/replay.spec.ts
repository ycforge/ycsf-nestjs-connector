import { All, Controller, HttpException, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import * as publicApi from "../index";
import {
  resolveInvocationExecutionContext,
  resolveInvocationHttpRequest,
} from "../context/invocation-scope";
import type { YandexExecutionContext } from "../context/yandex-execution-context";
import { ConnectorError } from "../core/connector-error";
import type { NormalizedHttpRequest } from "../http/normalized-request";
import type { YandexFunctionHttpResponse } from "../http/response";
import type { QueueBatch } from "../mq/message";
import { QueueHandler } from "../mq/queue-handler.decorator";
// Merged export: decorator factory plus the normalized message type it injects.
import { QueueMessage } from "../mq/queue-message.decorator";
import {
  listHttpFixtureNames,
  listQueueFixtureNames,
  loadHttpFixture,
  loadQueueFixture,
  type HttpInvocationFixture,
  type QueueInvocationFixture,
} from "./invocation-fixtures";
import {
  captureReplayOutcome,
  createReplaySession,
  replayHttpFixture,
  replayQueueFixture,
  type FixtureReplayOutcome,
  type ReplaySession,
} from "./replay";
import { ReplayAppModule } from "./replay-app";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Local invocation and replay tooling (issue #12): proves that every
 * sanitized reconstructed fixture can be replayed locally through the SAME
 * public `createYandexHandler()` entry point production uses — no transport
 * adapter is ever driven directly and no second dispatch path exists.
 *
 * This suite pins the replay contract itself: production reuse (public
 * factory, warm application, detection boundary), untouched failure
 * semantics per transport (issue #10), concurrent isolation (AGENTS.md
 * section 11) and fixture immutability during replay.
 */

// ---------------------------------------------------------------------------
// Recording applications: prove which invocation observed which data, so
// isolation assertions come from production's own scoping mechanism.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  readonly normalizedRequest: NormalizedHttpRequest;
  readonly executionContext: YandexExecutionContext;
}

const CAPTURED_REQUESTS = new Map<string, CapturedRequest>();

class RecordingProbeController {
  probe(rest: string): object {
    const captured = {
      normalizedRequest: resolveInvocationHttpRequest(),
      executionContext: resolveInvocationExecutionContext(),
    };
    CAPTURED_REQUESTS.set(captured.executionContext.awsRequestId, captured);
    return { rest };
  }
}

Controller()(RecordingProbeController);

const probeDescriptor = Object.getOwnPropertyDescriptor(
  RecordingProbeController.prototype,
  "probe",
);
if (!probeDescriptor) {
  throw new Error("missing descriptor for RecordingProbeController.probe");
}
All("*rest")(RecordingProbeController.prototype, "probe", probeDescriptor);

interface CapturedRound {
  readonly messageId: string;
  readonly executionContext: YandexExecutionContext;
}

const CAPTURED_ROUNDS = new Map<string, CapturedRound>();

class RecordingConsumer {
  record(message: { messageId: string }): void {
    CAPTURED_ROUNDS.set(message.messageId, {
      messageId: message.messageId,
      executionContext: resolveInvocationExecutionContext(),
    });
  }
}

QueueHandler()(
  RecordingConsumer.prototype,
  "record",
  Object.getOwnPropertyDescriptor(RecordingConsumer.prototype, "record")!,
);
QueueMessage()(RecordingConsumer.prototype, "record", 0);

/** Serves BOTH transports like one deployed function would. */
class MixedRecordingModule {}

Module({
  controllers: [RecordingProbeController],
  providers: [RecordingConsumer],
})(MixedRecordingModule);

class RecordingHttpOnlyModule {}

Module({ controllers: [RecordingProbeController] })(RecordingHttpOnlyModule);

class RecordingQueueOnlyModule {}

Module({ providers: [RecordingConsumer] })(RecordingQueueOnlyModule);

// ---------------------------------------------------------------------------
// Failure-scripted applications for semantics-preservation assertions.
// ---------------------------------------------------------------------------

class FailingProbeController {
  forbidden(): never {
    throw new HttpException({ reason: "forbidden-fixture-reason" }, 403);
  }

  boom(): never {
    throw new Error("unexpected-controller-boom");
  }
}

Controller("replay-fail")(FailingProbeController);

function failingDescriptor(name: string): TypedPropertyDescriptor<unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(FailingProbeController.prototype, name);
  if (!descriptor) {
    throw new Error(`missing descriptor for FailingProbeController.${name}`);
  }
  return descriptor;
}
All("forbidden")(FailingProbeController.prototype, "forbidden", failingDescriptor("forbidden"));
All("boom")(FailingProbeController.prototype, "boom", failingDescriptor("boom"));

class FailingHttpModule {}

Module({ controllers: [FailingProbeController] })(FailingHttpModule);

let seededQueueFailure: Error = new Error("unconfigured queue failure");

class ScriptedFailingConsumer {
  handle(): void {
    throw seededQueueFailure;
  }
}

QueueHandler()(
  ScriptedFailingConsumer.prototype,
  "handle",
  Object.getOwnPropertyDescriptor(ScriptedFailingConsumer.prototype, "handle")!,
);
QueueMessage()(ScriptedFailingConsumer.prototype, "handle", 0);

class ScriptedFailingQueueModule {}

Module({ providers: [ScriptedFailingConsumer] })(ScriptedFailingQueueModule);

class PayloadTouchingConsumer {
  handle(message: { payload: unknown }): void {
    // First access performs the decode under the default strict-JSON policy.
    void message.payload;
  }
}

QueueHandler()(
  PayloadTouchingConsumer.prototype,
  "handle",
  Object.getOwnPropertyDescriptor(PayloadTouchingConsumer.prototype, "handle")!,
);
QueueMessage()(PayloadTouchingConsumer.prototype, "handle", 0);

class PayloadTouchingQueueModule {}

Module({ providers: [PayloadTouchingConsumer] })(PayloadTouchingQueueModule);

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

async function replayHttpNamed(
  session: ReplaySession,
  name: string,
): Promise<{ fixture: HttpInvocationFixture; outcome: FixtureReplayOutcome }> {
  const fixture = await loadHttpFixture(name);
  const outcome = await session.replay({
    fixtureName: name,
    event: fixture.event,
    context: fixture.context,
  });
  return { fixture, outcome };
}

async function replayQueueNamed(
  session: ReplaySession,
  name: string,
): Promise<{ fixture: QueueInvocationFixture; outcome: FixtureReplayOutcome }> {
  const fixture = await loadQueueFixture(name);
  const outcome = await session.replay({
    fixtureName: name,
    event: fixture.event,
    context: fixture.context,
  });
  return { fixture, outcome };
}

function expectEnvelope(result: unknown): asserts result is YandexFunctionHttpResponse {
  if (
    typeof result !== "object" ||
    result === null ||
    !("statusCode" in result) ||
    !("body" in result)
  ) {
    throw new Error("expected an HTTP response envelope");
  }
}

function expectBatch(result: unknown): asserts result is QueueBatch {
  if (typeof result !== "object" || result === null || !("messages" in result)) {
    throw new Error("expected a normalized queue batch");
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, PropertyKey>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe("local fixture replay through the public runtime (issue #12)", () => {
  beforeEach(() => {
    CAPTURED_REQUESTS.clear();
    CAPTURED_ROUNDS.clear();
    seededQueueFailure = new Error("unconfigured queue failure");
  });

  afterEach(async () => {
    jest.restoreAllMocks();
  });

  it("routes every replay through the public createYandexHandler entry point", async () => {
    // Direct proof at the seam: the helper must obtain its runtime from the
    // public barrel exactly like a deployed function does — never by calling
    // transport adapters or an internal runtime seam.
    const factorySpy = jest.spyOn(publicApi, "createYandexHandler");
    const session = createReplaySession(MixedRecordingModule);
    expect(factorySpy).toHaveBeenCalledTimes(1);
    await session.close();
  });

  it("engages the production detection boundary for events no transport claims", async () => {
    const session = createReplaySession(RecordingHttpOnlyModule);
    try {
      const outcome = await session.replay({
        fixtureName: "synthetic-unknown",
        event: { neitherHttpNorQueue: true },
        context: {},
      });
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBeInstanceOf(ConnectorError);
      expect((outcome.error as ConnectorError).code).toBe("UNKNOWN_INVOCATION_EVENT");
    } finally {
      await session.close();
    }
  });

  it("replays every committed HTTP fixture through one shared warm handler", async () => {
    const names = await listHttpFixtureNames();
    expect(names.length).toBeGreaterThanOrEqual(11);

    const session = createReplaySession(RecordingHttpOnlyModule);
    try {
      const outcomes = await Promise.all(names.map((name) => replayHttpNamed(session, name)));

      // Every fixture resolves with the wire envelope produced by the probe
      // controller: routing reached the application for every committed path.
      for (const { outcome } of outcomes) {
        expect(outcome.ok).toBe(true);
        expectEnvelope(outcome.result);
        expect(outcome.result.statusCode).toBe(200);
        expect(typeof outcome.result.body).toBe("string");
        expect(typeof outcome.result.isBase64Encoded).toBe("boolean");
      }
      // Per-invocation correlation: each replay observed exactly its own
      // fixture's context, and nothing extra was captured (AGENTS.md 11).
      expect(CAPTURED_REQUESTS.size).toBe(names.length);
      for (const { fixture } of outcomes) {
        const requestId = String(fixture.context.awsRequestId);
        const captured = CAPTURED_REQUESTS.get(requestId);
        expect(captured).toBeDefined();
        expect(captured!.normalizedRequest.rawQueryString).toBe(fixture.event.rawQueryString);
      }
    } finally {
      await session.close();
    }
  });

  it("replays every committed Message Queue fixture resolving to batches, never envelopes", async () => {
    const names = await listQueueFixtureNames();
    expect(names.length).toBeGreaterThanOrEqual(5);

    const session = createReplaySession(RecordingQueueOnlyModule);
    try {
      const outcomes = await Promise.all(names.map((name) => replayQueueNamed(session, name)));

      for (const { outcome } of outcomes) {
        expect(outcome.ok).toBe(true);
        expectBatch(outcome.result);
        expect(outcome.result.messages).toHaveLength(1);
        // A successful queue delivery has no HTTP-style envelope fields
        // (docs/ARCHITECTURE.md section 6.2) — replay changes nothing.
        expect(outcome.result).not.toHaveProperty("statusCode");
        expect(outcome.result).not.toHaveProperty("body");
        expect(outcome.result).not.toHaveProperty("isBase64Encoded");
      }
      // Concurrent queue rounds stay isolated per message/request id.
      expect(CAPTURED_ROUNDS.size).toBe(names.length);
      for (const { fixture } of outcomes) {
        const messageId = fixture.event.messages[0]!.details.message.message_id;
        expect(CAPTURED_ROUNDS.get(messageId)?.executionContext.awsRequestId).toBe(
          String(fixture.context.awsRequestId),
        );
      }
    } finally {
      await session.close();
    }
  });

  it("isolates mixed HTTP and Message Queue replays running concurrently", async () => {
    const httpNames = (await listHttpFixtureNames()).slice(0, 4);
    const mqNames = await listQueueFixtureNames();

    // One session, both transports interleaved concurrently: the production
    // AsyncLocalStorage scope must keep every request/message with its own
    // invocation context even while sharing the warm application.
    const session = createReplaySession(MixedRecordingModule);
    try {
      const httpPlanned = await Promise.all(httpNames.map((name) => loadHttpFixture(name)));
      const mqPlanned = await Promise.all(mqNames.map((name) => loadQueueFixture(name)));

      const outcomes = await Promise.all([
        ...httpPlanned.map((fixture, index) =>
          session.replay({
            fixtureName: httpNames[index]!,
            event: fixture.event,
            context: fixture.context,
          }),
        ),
        ...mqPlanned.map((fixture, index) =>
          session.replay({
            fixtureName: mqNames[index]!,
            event: fixture.event,
            context: fixture.context,
          }),
        ),
      ]);

      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      expect(CAPTURED_REQUESTS.size).toBe(httpNames.length);
      expect(CAPTURED_ROUNDS.size).toBe(mqNames.length);
      for (const fixture of httpPlanned) {
        const requestId = String(fixture.context.awsRequestId);
        expect(CAPTURED_REQUESTS.get(requestId)?.normalizedRequest.path).toBe(
          fixture.event.rawPath,
        );
      }
      for (const fixture of mqPlanned) {
        const messageId = fixture.event.messages[0]!.details.message.message_id;
        expect(CAPTURED_ROUNDS.get(messageId)?.executionContext.awsRequestId).toBe(
          String(fixture.context.awsRequestId),
        );
      }
    } finally {
      await session.close();
    }
  });

  it("reuses one cold start across sequential replays and cold-starts again after close", async () => {
    const createSpy = jest.spyOn(NestFactory, "create");
    const names = ["get-without-query", "repeated-query-parameters", "binary-body-base64"];

    const session = createReplaySession(RecordingHttpOnlyModule);
    for (const name of names) {
      const { outcome } = await replayHttpNamed(session, name);
      expect(outcome.ok).toBe(true);
    }
    // Warm discipline (AGENTS.md 10.2): many replays, exactly one bootstrap.
    expect(createSpy).toHaveBeenCalledTimes(1);

    await session.close();
    const reopened = createReplaySession(RecordingHttpOnlyModule);
    try {
      const { outcome } = await replayHttpNamed(reopened, names[0]!);
      expect(outcome.ok).toBe(true);
      // close() released the cached application; the next replay cold-starts
      // fresh instead of resurrecting it (docs/ARCHITECTURE.md section 3.4).
      expect(createSpy).toHaveBeenCalledTimes(2);
    } finally {
      await reopened.close();
    }
  });

  it("leaves loaded fixtures byte-identical and frozen-safe during replay", async () => {
    const session = createReplaySession(MixedRecordingModule);
    try {
      for (const [kind, name] of [
        ["http", "binary-body-base64"],
        ["mq", "json-body-message"],
      ] as const) {
        const { fixture, outcome } =
          kind === "http"
            ? await replayHttpNamed(session, name)
            : await replayQueueNamed(session, name);
        expect(outcome.ok).toBe(true);

        const snapshot = structuredClone(fixture);
        // Freezing turns any mutation attempt inside the runtime into a hard
        // TypeError under strict mode — stronger than post-hoc comparison.
        deepFreeze(fixture.event);
        deepFreeze(fixture.context);

        const frozenOutcome = await session.replay({
          fixtureName: `${name}-frozen`,
          event: fixture.event,
          context: fixture.context,
        });
        expect(frozenOutcome.ok).toBe(true);
        expect(fixture.event).toEqual(snapshot.event);
        expect(fixture.context).toEqual(snapshot.context);
      }
    } finally {
      await session.close();
    }
  });

  it("reports malformed fixtures as failed outcomes without creating a runtime", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ycsf-replay-malformed-"));
    try {
      // The loader resolves names inside <root>/<kind>/<name>.json.
      mkdirSync(path.join(root, "http"), { recursive: true });
      mkdirSync(path.join(root, "mq"), { recursive: true });
      const write = (kind: string, name: string, content: string): void => {
        writeFileSync(path.join(root, kind, `${name}.json`), content);
      };
      write(
        "http",
        "no-provenance",
        JSON.stringify({ timestamp: "", node: "", event: {}, context: {} }),
      );
      write(
        "http",
        "wrong-http-version",
        JSON.stringify({
          timestamp: "",
          node: "",
          provenance: { kind: "reconstructed", evidence: "DATA-ANALYSE.md" },
          event: { version: "1.0", rawPath: "/", rawQueryString: "" },
          context: {},
        }),
      );
      write(
        "mq",
        "no-messages",
        JSON.stringify({
          timestamp: "",
          node: "",
          provenance: { kind: "reconstructed", evidence: "DATA-ANALYSE.md" },
          event: {},
          context: {},
        }),
      );

      // One-shot helpers surface load failures as failed outcomes; no handler
      // is created (and none needs closing) when loading already failed.
      const missingProvenance = await replayHttpFixture(RecordingHttpOnlyModule, "no-provenance", {
        root,
      });
      expect(missingProvenance.ok).toBe(false);
      expect(missingProvenance.fixture).toBeUndefined();
      expect(String(missingProvenance.error)).toContain("provenance");

      const wrongVersion = await replayHttpFixture(RecordingHttpOnlyModule, "wrong-http-version", {
        root,
      });
      expect(wrongVersion.ok).toBe(false);
      expect(String(wrongVersion.error)).toContain('"2.0"');

      const missingMessages = await replayQueueFixture(RecordingHttpOnlyModule, "no-messages", {
        root,
      });
      expect(missingMessages.ok).toBe(false);
      expect(String(missingMessages.error)).toContain("messages");

      const missingFile = await replayHttpFixture(RecordingHttpOnlyModule, "does-not-exist", {
        root,
      });
      expect(missingFile.ok).toBe(false);
      expect((missingFile.error as NodeJS.ErrnoException).code).toBe("ENOENT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps HTTP exception semantics intact: mapped statuses resolve, unexpected failures stay opaque", async () => {
    const session = createReplaySession(FailingHttpModule);
    const baseEvent = {
      version: "2.0" as const,
      headers: {},
      queryStringParameters: {},
      requestContext: {
        authorizer: {},
        http: { method: "GET", path: "/", sourceIp: "203.0.113.10", userAgent: "replay-spec/1.0" },
        requestId: "f18fed85-7096-4f0e-a6db-e2c5e37e925f",
        time: "21/Aug/2026:16:16:30 +0000",
        timeEpoch: 1787328990,
      },
      body: "",
      isBase64Encoded: true,
      pathParameters: {},
      parameters: {},
      multiValueParameters: {},
      operationId: "41cf33042e33".padEnd(64, "0"),
    };
    const target = (
      rawPath: string,
    ): { fixtureName: string; event: unknown; context: unknown } => ({
      fixtureName: rawPath,
      event: { ...baseEvent, rawPath, rawQueryString: "" },
      context: {
        awsRequestId: `request-${rawPath.replace(/\W/g, "-")}`,
        functionName: "fn-replay-spec",
        functionVersion: "$LATEST",
        functionFolderId: "folder-fixture",
        memoryLimitInMB: "1024",
        deadlineMs: 1787328996791,
        logGroupName: "",
      },
    });

    try {
      // An HttpException is a transport-shaped SUCCESS (issue #10): replay
      // exposes exactly the envelope the framework produced.
      const forbidden = await session.replay(target("/replay-fail/forbidden"));
      expect(forbidden.ok).toBe(true);
      expectEnvelope(forbidden.result);
      expect(forbidden.result.statusCode).toBe(403);
      expect(forbidden.result.body).toContain("forbidden-fixture-reason");

      // An unexpected application failure maps to the static opaque 500 —
      // neither the error message nor stack frames reach the envelope.
      const boom = await session.replay(target("/replay-fail/boom"));
      expect(boom.ok).toBe(true);
      expectEnvelope(boom.result);
      expect(boom.result.statusCode).toBe(500);
      expect(boom.result.body).not.toContain("unexpected-controller-boom");
    } finally {
      await session.close();
    }
  });

  it("propagates Message Queue handler failures verbatim out of the replay", async () => {
    const session = createReplaySession(ScriptedFailingQueueModule);
    try {
      seededQueueFailure = new Error("consumer-replay-boom");
      const { outcome } = await replayQueueNamed(session, "json-body-message");
      // Verbatim identity: unwrapped, unconverted — retry/dead-letter
      // semantics remain observable through the replayed invocation.
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBe(seededQueueFailure);
      expect(outcome.error).not.toBeInstanceOf(ConnectorError);
    } finally {
      await session.close();
    }
  });

  it("surfaces lazy payload deserialization failures as ConnectorError rejections", async () => {
    // A delivery whose body is plain text must fail the consuming round with
    // QUEUE_BODY_DESERIALIZATION_FAILED when the handler decodes it — replay
    // preserves issue #9/#10 semantics end to end.
    const session = createReplaySession(PayloadTouchingQueueModule);
    try {
      const { outcome } = await replayQueueNamed(session, "simple-text-message");
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBeInstanceOf(ConnectorError);
      expect((outcome.error as ConnectorError).code).toBe("QUEUE_BODY_DESERIALIZATION_FAILED");
    } finally {
      await session.close();
    }
  });

  it("fails deliveries without any registered queue handler with NO_QUEUE_HANDLER", async () => {
    class EmptyModule {}
    Module({})(EmptyModule);
    const session = createReplaySession(EmptyModule);
    try {
      const { outcome } = await replayQueueNamed(session, "simple-text-message");
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toBeInstanceOf(ConnectorError);
      expect((outcome.error as ConnectorError).code).toBe("NO_QUEUE_HANDLER");
    } finally {
      await session.close();
    }
  });

  it("exposes one-shot helpers returning the loaded fixture alongside the outcome", async () => {
    const http = await replayHttpFixture(ReplayAppModule, "url-encoded-query-values");
    expect(http.ok).toBe(true);
    expect(http.fixture).toBeDefined();
    expectEnvelope(http.result);
    expect(http.result.statusCode).toBe(200);

    const mq = await replayQueueFixture(ReplayAppModule, "custom-message-attributes");
    expect(mq.ok).toBe(true);
    expect(mq.fixture).toBeDefined();
    expectBatch(mq.result);
    expect(mq.result.messages[0]).toBeDefined();

    expect(await captureReplayOutcome("x", async () => "ok")).toEqual({
      fixtureName: "x",
      ok: true,
      result: "ok",
    });
    const failure = new Error("nope");
    expect(await captureReplayOutcome("y", async () => Promise.reject(failure))).toEqual({
      fixtureName: "y",
      ok: false,
      error: failure,
    });
  });
});
