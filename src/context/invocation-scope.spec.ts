import {
  getInvocationScopeState,
  resolveInvocationExecutionContext,
  runInInvocationScope,
  type InvocationScopeState,
} from "./invocation-scope";
import { buildYandexExecutionContext } from "./build-yandex-execution-context";

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
