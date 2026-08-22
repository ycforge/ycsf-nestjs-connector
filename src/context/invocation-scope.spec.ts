import {
  extendInvocationScope,
  getInvocationScopeState,
  resolveInvocationExecutionContext,
  resolveInvocationHttpRequest,
  resolveInvocationQueueBatch,
  runInInvocationScope,
  type InvocationScopeState,
} from "./invocation-scope";
import { buildYandexExecutionContext } from "./build-yandex-execution-context";
import type { NormalizedHttpRequest } from "../http/normalized-request";
import type { RawHttpApiGatewayV2Event } from "../http/raw-event";
import type { QueueBatch } from "../mq/message";

/**
 * Specs for invocation-scoped context propagation (issue #4). AsyncLocalStorage
 * must isolate every handler execution: concurrent invocations never see each
 * other's state and nothing survives an invocation (AGENTS.md section 11).
 */

const OBSERVED_CONTEXT: Record<string, unknown> = {
  awsRequestId: "f18fed85-7096-4f0e-a6db-e2c5e37e925f",
  functionName: "fn-fixture",
  functionVersion: "$LATEST",
  functionFolderId: "folder-fixture",
  memoryLimitInMB: "1024",
  deadlineMs: 1787328996791,
  logGroupName: "",
};

function stateFor(awsRequestId: string): InvocationScopeState {
  return {
    executionContext: buildYandexExecutionContext({}, { ...OBSERVED_CONTEXT, awsRequestId }),
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("invocation scope", () => {
  it("keeps the normalized context reachable across async boundaries inside one invocation", async () => {
    const state = stateFor("inv-async");

    await runInInvocationScope(state, async () => {
      await delay(1);
      // After awaiting, the async chain still belongs to this invocation.
      expect(resolveInvocationExecutionContext()).toBe(state.executionContext);
    });
  });

  it("resolves the exact execution context object of the current invocation", async () => {
    const state = stateFor("inv-identity");

    await expect(
      runInInvocationScope(state, () => Promise.resolve(resolveInvocationExecutionContext())),
    ).resolves.toBe(state.executionContext);
  });

  it("leaks nothing between sequential invocations", async () => {
    const first = stateFor("inv-1");
    const second = stateFor("inv-2");

    const observedIds: (string | undefined)[] = [];

    await runInInvocationScope(first, async () => {
      observedIds.push(resolveInvocationExecutionContext().awsRequestId);
    });
    // Between invocations there is no ambient state at all.
    observedIds.push(getInvocationScopeState()?.executionContext.awsRequestId);
    await runInInvocationScope(second, async () => {
      observedIds.push(resolveInvocationExecutionContext().awsRequestId);
    });

    expect(observedIds).toEqual(["inv-1", undefined, "inv-2"]);
  });

  it("isolates concurrent invocations interleaving on the same event loop", async () => {
    const slow = stateFor("inv-slow");
    const fast = stateFor("inv-fast");
    const observedDuringSlow: string[] = [];

    const slowRun = runInInvocationScope(slow, async () => {
      await delay(20);
      observedDuringSlow.push(resolveInvocationExecutionContext().awsRequestId);
    });
    const fastRun = runInInvocationScope(fast, async () => {
      await delay(1);
      observedDuringSlow.push(resolveInvocationExecutionContext().awsRequestId);
    });

    await Promise.all([slowRun, fastRun]);

    // The fast invocation completed while the slow one was suspended; the
    // slow invocation must still observe only its own context afterwards.
    expect(observedDuringSlow).toEqual(["inv-fast", "inv-slow"]);
  });

  it("exposes no state once the invocation has completed", async () => {
    await runInInvocationScope(stateFor("inv-done"), () => Promise.resolve());

    expect(getInvocationScopeState()).toBeUndefined();
  });

  it("fails resolution outside any invocation with an actionable diagnostic", () => {
    expect(() => resolveInvocationExecutionContext()).toThrow(
      /@YandexContext\(\) can only be resolved while handling a Yandex Cloud Function invocation/,
    );
  });

  it("propagates operation failures without swallowing them", async () => {
    const failure = new Error("handler-boom");

    await expect(
      runInInvocationScope(stateFor("inv-fail"), () => Promise.reject(failure)),
    ).rejects.toBe(failure);
  });
});

describe("invocation scope transport extension", () => {
  const HTTP_REQUEST: NormalizedHttpRequest = Object.freeze({
    raw: {} as RawHttpApiGatewayV2Event,
    httpVersion: "2.0",
    method: "GET",
    path: "/fixture",
    rawQueryString: "",
    searchParams: new URLSearchParams(),
    queryStringParameters: Object.freeze({}),
    multiValueParameters: Object.freeze({}),
    pathParameters: Object.freeze({}),
    parameters: Object.freeze({}),
    headers: Object.freeze({}),
    sourceIp: "203.0.113.10",
    userAgent: "fixture-agent/1.0",
    body: null,
    requestId: "req-fixture",
  });

  it("merges the extension while keeping the execution context identity", async () => {
    const state = stateFor("inv-extend");

    await runInInvocationScope(state, async () => {
      await extendInvocationScope({ httpRequest: HTTP_REQUEST }, async () => {
        expect(resolveInvocationHttpRequest()).toBe(HTTP_REQUEST);
        // The context must survive the extension untouched and by reference.
        expect(resolveInvocationExecutionContext()).toBe(state.executionContext);
      });
    });
  });

  it("keeps the extended request reachable across async boundaries", async () => {
    await runInInvocationScope(stateFor("inv-async"), async () => {
      await extendInvocationScope({ httpRequest: HTTP_REQUEST }, async () => {
        await delay(1);
        expect(getInvocationScopeState()?.httpRequest).toBe(HTTP_REQUEST);
      });
    });
  });

  it("does not leak an extension into the outer invocation scope", async () => {
    await runInInvocationScope(stateFor("inv-nested"), async () => {
      await extendInvocationScope({ httpRequest: HTTP_REQUEST }, () => Promise.resolve());

      expect(getInvocationScopeState()?.httpRequest).toBeUndefined();
    });
  });

  it("isolates concurrent extensions interleaving on the same event loop", async () => {
    const slowRequest: NormalizedHttpRequest = { ...HTTP_REQUEST, requestId: "req-slow" };
    const fastRequest: NormalizedHttpRequest = { ...HTTP_REQUEST, requestId: "req-fast" };
    const observedDuringSlow: string[] = [];

    await runInInvocationScope(stateFor("inv-parent"), async () => {
      const slowRun = extendInvocationScope({ httpRequest: slowRequest }, async () => {
        await delay(20);
        observedDuringSlow.push(resolveInvocationHttpRequest().requestId);
      });
      const fastRun = extendInvocationScope({ httpRequest: fastRequest }, async () => {
        await delay(1);
        observedDuringSlow.push(resolveInvocationHttpRequest().requestId);
      });

      // The parent scope never observes either child's extension.
      expect(getInvocationScopeState()?.httpRequest).toBeUndefined();

      await Promise.all([slowRun, fastRun]);
    });

    expect(observedDuringSlow).toEqual(["req-fast", "req-slow"]);
  });

  it("fails to resolve the http request when no transport published one", async () => {
    await runInInvocationScope(stateFor("inv-no-http"), () => Promise.resolve());

    expect(() => resolveInvocationHttpRequest()).toThrow(/no HTTP request is associated/);
  });

  it("refuses to extend outside any invocation with an actionable diagnostic", () => {
    expect(() =>
      extendInvocationScope({ httpRequest: HTTP_REQUEST }, () => Promise.resolve()),
    ).toThrow(/can only be extended while handling a Yandex Cloud Function invocation/);
    expect(() => resolveInvocationHttpRequest()).toThrow(/no HTTP request is associated/);
  });
});

describe("invocation scope queue delivery extension", () => {
  const QUEUE_BATCH: QueueBatch = Object.freeze({
    raw: Object.freeze({ messages: [] }),
    messages: Object.freeze([]),
  });

  it("merges the queue delivery while keeping the execution context identity", async () => {
    const state = stateFor("inv-queue-extend");

    await runInInvocationScope(state, async () => {
      await extendInvocationScope({ queueBatch: QUEUE_BATCH }, async () => {
        expect(resolveInvocationQueueBatch()).toBe(QUEUE_BATCH);
        // The context must survive the extension untouched and by reference.
        expect(resolveInvocationExecutionContext()).toBe(state.executionContext);
      });
    });
  });

  it("does not leak a queue delivery into the outer invocation scope", async () => {
    await runInInvocationScope(stateFor("inv-queue-nested"), async () => {
      await extendInvocationScope({ queueBatch: QUEUE_BATCH }, () => Promise.resolve());

      expect(getInvocationScopeState()?.queueBatch).toBeUndefined();
    });
  });

  it("isolates concurrent queue deliveries interleaving on the same event loop", async () => {
    const slowBatch = { ...QUEUE_BATCH, messages: [], raw: { messages: [] } } as QueueBatch;
    const fastBatch = QUEUE_BATCH;
    const observedDuringSlow: string[] = [];

    await runInInvocationScope(stateFor("inv-queue-parent"), async () => {
      const slowRun = extendInvocationScope({ queueBatch: slowBatch }, async () => {
        await delay(20);
        observedDuringSlow.push(String(resolveInvocationQueueBatch() === slowBatch));
      });
      const fastRun = extendInvocationScope({ queueBatch: fastBatch }, async () => {
        await delay(1);
        observedDuringSlow.push(String(resolveInvocationQueueBatch() === fastBatch));
      });

      // The parent scope never observes either child's delivery.
      expect(getInvocationScopeState()?.queueBatch).toBeUndefined();

      await Promise.all([slowRun, fastRun]);
    });

    expect(observedDuringSlow).toEqual(["true", "true"]);
  });

  it("fails to resolve the queue delivery when no transport published one", async () => {
    await runInInvocationScope(stateFor("inv-no-queue"), () => Promise.resolve());

    expect(() => resolveInvocationQueueBatch()).toThrow(/no Message Queue delivery/);
  });

  it("refuses to resolve a queue delivery outside any invocation", () => {
    expect(() => resolveInvocationQueueBatch()).toThrow(
      /no Message Queue delivery is associated with the current invocation/,
    );
  });
});
