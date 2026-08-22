import { AsyncLocalStorage } from "node:async_hooks";
import type { YandexExecutionContext } from "./yandex-execution-context";

/**
 * Per-invocation state shared with everything that runs inside one handler
 * execution (issue #4).
 *
 * Deliberately minimal and extensible: transports add their normalized
 * models on top without changing how application code reads the context.
 */
export interface InvocationScopeState {
  readonly executionContext: YandexExecutionContext;
}

/**
 * Invocation-scoped propagation mechanism.
 *
 * AsyncLocalStorage keeps the state attached to the asynchronous execution
 * chain of exactly ONE handler invocation: concurrent invocations get isolated
 * stores, sequential invocations never observe each other's data, and nothing
 * survives after the invocation completes (AGENTS.md section 11). This is not
 * singleton state holding `currentEvent`/`currentContext` — it is the
 * sanctioned isolation boundary those rules require.
 */
const invocationStorage = new AsyncLocalStorage<InvocationScopeState>();

/**
 * Runs `operation` inside the scope of one invocation. The core wraps every
 * transport dispatch with this call, making the normalized context reachable
 * from any depth of user code (guards, services, handlers) regardless of
 * which transport claimed the event.
 */
export function runInInvocationScope<TResult>(
  state: InvocationScopeState,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  return invocationStorage.run(state, operation);
}

/** Current invocation state when called inside one; otherwise `undefined`. */
export function getInvocationScopeState(): InvocationScopeState | undefined {
  return invocationStorage.getStore();
}

/**
 * Resolves the current invocation's normalized execution context.
 *
 * Transport dispatch uses this to fill `@YandexContext()` parameters.
 * Resolution outside any invocation scope is a programming error and fails
 * loudly instead of returning an undefined context typed as present.
 */
export function resolveInvocationExecutionContext(): YandexExecutionContext {
  const state = invocationStorage.getStore();
  if (!state) {
    throw new Error(
      "@YandexContext() can only be resolved while handling a Yandex Cloud Function invocation",
    );
  }
  return state.executionContext;
}
