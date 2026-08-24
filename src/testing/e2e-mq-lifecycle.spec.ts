import { NestFactory } from "@nestjs/core";
import {
  ConnectorError,
  createYandexHandler,
  type ClosableYandexCloudFunctionHandler,
} from "../index";
import {
  FanOutQueueAppModule,
  PayloadAgnosticQueueAppModule,
  auditHandlerRounds,
  lastSingletonInstanceId,
  makeQueueDelivery,
  makeRuntimeContext,
  mirrorHandlerRounds,
  payloadAgnosticRounds,
  resetLifecycleObservations,
  type QueueRoundObservation,
} from "./e2e-test-apps";

/**
 * End-to-end Message Queue lifecycle coverage through the public connector
 * API (issue #14): a Yandex MQ trigger event enters
 * `createYandexHandler()`, every message fans out to real NestJS providers,
 * and the batch result leaves in the queue envelope shape.
 *
 * Transport-level suites already cover normalization, per-message DI scopes
 * and fail-fast mechanics in isolation. This file proves those behaviors
 * COOPERATE over one warm application through the full public path: fan-out
 * discovery order across two consumers, one shared DI sub-tree per message
 * spanning different providers, memoized payloads shared between fan-out
 * handlers, lazy deserialization at the boundary, failure propagation, and
 * cold/warm lifecycle semantics.
 */

function expectBatchEnvelope(result: unknown): {
  messages: { messageId?: string }[];
  raw: unknown;
} {
  const envelope = result as {
    messages?: unknown;
    raw?: unknown;
    statusCode?: unknown;
    body?: unknown;
    isBase64Encoded?: unknown;
  };
  expect(Array.isArray(envelope.messages)).toBe(true);
  // A queue invocation must never be mistaken for an HTTP response envelope.
  expect("statusCode" in envelope).toBe(false);
  expect("body" in envelope).toBe(false);
  expect("isBase64Encoded" in envelope).toBe(false);
  return envelope as { messages: { messageId?: string }[]; raw: unknown };
}

describe("Message Queue end-to-end lifecycle through the public connector", () => {
  let runtime: ClosableYandexCloudFunctionHandler;

  beforeEach(() => {
    resetLifecycleObservations();
    runtime = createYandexHandler(FanOutQueueAppModule);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("fans every message out to both consumers in declaration order with per-message contexts", async () => {
    const delivery = makeQueueDelivery(
      { messageId: "fan-m-1", body: JSON.stringify({ orderId: "order-1", items: 3 }) },
      { messageId: "fan-m-2", body: JSON.stringify({ orderId: "order-2", items: 7 }) },
    );

    const result = (await runtime(delivery, makeRuntimeContext("mq-fanout-1"))) as {
      messages: { messageId?: string }[];
      raw: unknown;
    };
    const envelope = expectBatchEnvelope(result);

    // The batch result preserves delivery identity and message order.
    expect(envelope.raw).toBe(delivery);
    expect(envelope.messages.map((message) => message.messageId)).toEqual(["fan-m-1", "fan-m-2"]);

    // Discovery order (providers declared audit before mirror): for each
    // message, audit runs first, then mirror — interleaved across messages.
    expect(auditHandlerRounds.map((round) => round.messageId)).toEqual(["fan-m-1", "fan-m-2"]);
    expect(mirrorHandlerRounds.map((round) => round.messageId)).toEqual(["fan-m-1", "fan-m-2"]);

    // Each handler observed ITS OWN message's execution context.
    const allRounds = [...auditHandlerRounds, ...mirrorHandlerRounds];
    expect(allRounds).toHaveLength(4);
    for (const round of allRounds) {
      expect(round.awsRequestId).toBe("mq-fanout-1");
    }
  });

  it("serves all fan-out handlers of one message from one fresh DI sub-tree", async () => {
    const delivery = makeQueueDelivery(
      { messageId: "di-m-1", body: "{}" },
      { messageId: "di-m-2", body: "{}" },
      { messageId: "di-m-3", body: "{}" },
    );
    await runtime(delivery, makeRuntimeContext("mq-di-1"));

    // REQUEST-scoped collaborators are equal BETWEEN different providers of
    // the same message and different ACROSS messages: exactly one sub-tree
    // per message (issue #8 semantics, proven across handler types here).
    const clockByMessage = new Map<string, Set<number>>();
    for (const round of [...auditHandlerRounds, ...mirrorHandlerRounds]) {
      const seenClocks = clockByMessage.get(round.messageId!) ?? new Set<number>();
      seenClocks.add(round.clockInstanceId!);
      clockByMessage.set(round.messageId!, seenClocks);
    }
    expect(clockByMessage.size).toBe(3);
    for (const clocks of clockByMessage.values()) {
      expect(clocks.size).toBe(1);
    }
    expect(new Set([...clockByMessage.values()].map((clocks) => [...clocks][0]!)).size).toBe(3);

    // The DEFAULT-scoped singleton is one instance for the whole warm
    // application — identical in every round of every consumer.
    const singletonIds = new Set(
      [...auditHandlerRounds, ...mirrorHandlerRounds].map((round) => round.singletonInstanceId),
    );
    expect([...singletonIds]).toHaveLength(1);
  });

  it("shares one memoized payload object between both fan-out handlers", async () => {
    const delivery = makeQueueDelivery({
      messageId: "memo-m-1",
      body: JSON.stringify({ orderId: "order-memo", items: [1, 2, 3] }),
    });
    await runtime(delivery, makeRuntimeContext("mq-memo-1"));

    const [auditRound, mirrorRound] = [auditHandlerRounds[0], mirrorHandlerRounds[0]];
    expect(auditRound?.payloadReference).toEqual({ orderId: "order-memo", items: [1, 2, 3] });
    // Memoization contract (issue #8): the same deserialized object instance
    // is handed to every consumer of the message, not a fresh parse each time.
    expect(mirrorRound?.payloadReference).toBe(auditRound?.payloadReference);
  });

  it("propagates payload deserialization failures and records no handler rounds", async () => {
    const delivery = makeQueueDelivery({ messageId: "bad-m-1", body: "not-json-at-all" });

    // The audit consumer eagerly reads `message.payload`; its failure must
    // fail the whole invocation so the trigger's retry/dead-letter policy
    // applies (AGENTS.md §8.2).
    const failure = await runtime(delivery, makeRuntimeContext("mq-bad-1")).catch(
      (caught: unknown) => caught,
    );

    expect(failure).toBeInstanceOf(ConnectorError);
    expect((failure as ConnectorError).code).toBe("QUEUE_BODY_DESERIALIZATION_FAILED");
    expect(JSON.stringify(failure)).not.toContain("not-json-at-all");
    expect(auditHandlerRounds).toHaveLength(0);
    expect(mirrorHandlerRounds).toHaveLength(0);

    // The failed invocation leaves the environment healthy: the next warm
    // delivery processes normally.
    const recovery = await runtime(
      makeQueueDelivery({ messageId: "ok-m-2", body: '{"recovered":true}' }),
      makeRuntimeContext("mq-bad-2"),
    );
    expectBatchEnvelope(recovery);
    expect(auditHandlerRounds.map((round) => round.messageId)).toEqual(["ok-m-2"]);
  });
});

describe("Message Queue laziness at the transport boundary", () => {
  let runtime: ClosableYandexCloudFunctionHandler;

  beforeEach(() => {
    resetLifecycleObservations();
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.close();
    }
  });

  it("delivers opaque non-JSON bodies when no handler ever reads the payload", async () => {
    runtime = createYandexHandler(PayloadAgnosticQueueAppModule);

    // Plain-text bodies are valid MQ traffic; deserialization must not run
    // unless application code opts into `message.payload` (issue #8).
    const delivery = makeQueueDelivery({ messageId: "lazy-m-1", body: "plain text ping" });
    const envelope = expectBatchEnvelope(await runtime(delivery, makeRuntimeContext("mq-lazy-1")));

    expect(envelope.messages.map((message) => message.messageId)).toEqual(["lazy-m-1"]);
    expect(payloadAgnosticRounds).toEqual([{ messageId: "lazy-m-1", awsRequestId: "mq-lazy-1" }]);
  });
});

describe("Message Queue cold start lifecycle through the public connector", () => {
  let createSpy: jest.SpyInstance;

  beforeEach(() => {
    resetLifecycleObservations();
    createSpy = jest.spyOn(NestFactory, "create");
  });

  afterEach(() => {
    createSpy.mockRestore();
  });

  it("bootstraps once, reuses the warm application, and re-bootstraps after close()", async () => {
    let runtime = createYandexHandler(FanOutQueueAppModule);

    const firstSingletonBefore = lastSingletonInstanceId();
    await runtime(
      makeQueueDelivery({ messageId: "life-m-1", body: "{}" }),
      makeRuntimeContext("mq-life-1"),
    );
    expect(createSpy).toHaveBeenCalledTimes(1);
    const warmSingletonId = auditHandlerRounds[0]?.singletonInstanceId;
    expect(warmSingletonId).toBe(firstSingletonBefore + 1);

    // Warm reuse: same singleton instance on the second invocation.
    await runtime(
      makeQueueDelivery({ messageId: "life-m-2", body: "{}" }),
      makeRuntimeContext("mq-life-2"),
    );
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(mirrorHandlerRounds.at(-1)?.singletonInstanceId).toBe(warmSingletonId);

    // close() releases the cached application; the next invocation performs
    // a genuinely fresh cold start with a brand-new DI graph.
    await runtime.close();
    runtime = createYandexHandler(FanOutQueueAppModule);
    await runtime(
      makeQueueDelivery({ messageId: "life-m-3", body: "{}" }),
      makeRuntimeContext("mq-life-3"),
    );

    expect(createSpy).toHaveBeenCalledTimes(2);
    const afterCloseSingletonId = auditHandlerRounds.find(
      (round) => round.messageId === "life-m-3",
    )?.singletonInstanceId;
    expect(afterCloseSingletonId).not.toBe(warmSingletonId);
    await runtime.close();
  });

  it("keeps concurrent multi-message deliveries isolated from each other", async () => {
    const runtime = createYandexHandler(FanOutQueueAppModule);

    const deliveries = [
      makeQueueDelivery(
        { messageId: "cc-m-a1", body: '{"side":"a"}' },
        { messageId: "cc-m-a2", body: '{"side":"a"}' },
      ),
      makeQueueDelivery(
        { messageId: "cc-m-b1", body: '{"side":"b"}' },
        { messageId: "cc-m-b2", body: '{"side":"b"}' },
      ),
    ];

    const results = (await Promise.all([
      runtime(deliveries[0], makeRuntimeContext("mq-cc-1")),
      runtime(deliveries[1], makeRuntimeContext("mq-cc-2")),
    ])) as { messages: { messageId?: string }[] }[];

    // Each invocation returns exactly its own messages.
    expect(results[0]?.messages.map((message) => message.messageId)).toEqual([
      "cc-m-a1",
      "cc-m-a2",
    ]);
    expect(results[1]?.messages.map((message) => message.messageId)).toEqual([
      "cc-m-b1",
      "cc-m-b2",
    ]);

    // Every round observed the execution context of its own invocation:
    // build the bijection messageId -> awsRequestId across BOTH deliveries.
    const roundsById = new Map<string, QueueRoundObservation[]>();
    for (const round of [...auditHandlerRounds, ...mirrorHandlerRounds]) {
      const bucket = roundsById.get(round.messageId!) ?? [];
      bucket.push(round);
      roundsById.set(round.messageId!, bucket);
    }
    expect(roundsById.size).toBe(4);
    const expectedInvocation = new Map([
      ["cc-m-a1", "mq-cc-1"],
      ["cc-m-a2", "mq-cc-1"],
      ["cc-m-b1", "mq-cc-2"],
      ["cc-m-b2", "mq-cc-2"],
    ]);
    for (const [messageId, requestId] of expectedInvocation) {
      for (const round of roundsById.get(messageId) ?? []) {
        expect(round.awsRequestId).toBe(requestId);
      }
    }

    // Four distinct messages raced each other: four distinct REQUEST-scoped
    // sub-trees, while the DEFAULT-scoped singleton stayed shared.
    const clockIds = new Set(
      [...auditHandlerRounds, ...mirrorHandlerRounds].map((round) => round.clockInstanceId),
    );
    expect(clockIds.size).toBe(4);
    const singletonIds = new Set(
      [...auditHandlerRounds, ...mirrorHandlerRounds].map((round) => round.singletonInstanceId),
    );
    expect(singletonIds.size).toBe(1);

    await runtime.close();
  });
});
