import type { Type } from "@nestjs/common";
import {
  createYandexHandler,
  type ClosableYandexCloudFunctionHandler,
  type CreateYandexHandlerOptions,
} from "../index";
import type { InvocationFixture } from "./invocation-fixtures";
import {
  loadHttpFixture,
  loadQueueFixture,
  type FixtureSourceOptions,
} from "./invocation-fixtures";

/**
 * Local invocation and replay infrastructure (NOT part of the published
 * package, issue #12): replays the sanitized reconstructed fixtures from
 * `fixtures/` through the SAME public runtime entry point production uses —
 * `createYandexHandler()` — with no Yandex Cloud connectivity, credentials or
 * network access.
 *
 * This module deliberately contains no second runtime and no alternate
 * dispatch path: everything below only loads fixture data and calls the
 * public factory exactly like the Yandex Cloud Functions runtime would.
 * Transport detection, warm application reuse, invocation scoping and
 * failure semantics are therefore production behavior by construction.
 *
 * Fixture provenance: every file under `fixtures/` is a sanitized
 * reconstruction distilled from captured evidence (DATA-ANALYSE.md), never a
 * literal capture; see `fixtures/README.md`.
 */

/**
 * Transport-shaped outcome of one replay attempt. Exactly one of `result`
 * (the invocation resolved: HTTP response envelope or normalized queue
 * batch) or `error` (the invocation rejected, or the fixture failed to load)
 * is meaningful; `ok` discriminates. Semantics are untouched: HTTP
 * exceptions that the framework mapped onto an error envelope still count as
 * resolved invocations (`ok: true`, issue #10), while Message Queue handler
 * failures propagate as rejections (`ok: false`) so retry/dead-letter
 * behavior stays observable.
 */
export interface FixtureReplayOutcome {
  /** Fixture name or specifier the outcome belongs to. */
  readonly fixtureName: string;
  /** `true` when the invocation completed with a transport-shaped result. */
  readonly ok: boolean;
  /** Resolved transport result on success; `undefined` on failure. */
  readonly result?: unknown;
  /** Rejection reason on failure: loader error, ConnectorError or application error, verbatim. */
  readonly error?: unknown;
}

/** Outcome of a one-shot replay that also loaded the fixture itself. */
export interface LoadedFixtureReplayOutcome extends FixtureReplayOutcome {
  /**
   * The loaded fixture when loading succeeded (the event/context passed to
   * the handler are its exact references); `undefined` when the failure was
   * the load itself.
   */
  readonly fixture?: InvocationFixture<unknown>;
}

/** One prepared invocation: a name plus the exact event/context to pass through. */
export interface ReplayTarget {
  readonly fixtureName: string;
  /** Raw event handed to the handler verbatim — no cloning, no metadata injection. */
  readonly event: unknown;
  /** Raw runtime context handed to the handler verbatim. */
  readonly context: unknown;
}

/**
 * Wraps one invocation promise into a {@link FixtureReplayOutcome}: a
 * resolved call becomes `ok: true` with the transport result, a rejected
 * call becomes `ok: false` carrying the original error object unchanged.
 */
export async function captureReplayOutcome(
  fixtureName: string,
  invoke: () => Promise<unknown>,
): Promise<FixtureReplayOutcome> {
  try {
    return { fixtureName, ok: true, result: await invoke() };
  } catch (error) {
    return { fixtureName, ok: false, error };
  }
}

/**
 * A replay session over ONE handler instance created through the public
 * {@link createYandexHandler} factory: sequential and concurrent replays
 * share the warm application exactly like concurrent invocations of one
 * deployed function share it, including per-invocation isolation (AGENTS.md
 * section 11). `close()` releases the cached application; the next replay
 * after closing performs a fresh cold start.
 */
export interface ReplaySession {
  /**
   * The underlying production handler. Exposed so tooling can assert against
   * the very callable Yandex would invoke — never for bypassing it.
   */
  readonly handler: ClosableYandexCloudFunctionHandler;
  /** Replays one prepared event/context pair through the shared handler. */
  replay(target: ReplayTarget): Promise<FixtureReplayOutcome>;
  /** Releases the cached NestJS application (idempotent). */
  close(): Promise<void>;
}

/**
 * Creates a replay session backed by a fresh public-runtime handler. This is
 * the single place local tooling obtains a runtime: there is deliberately no
 * other construction path.
 */
export function createReplaySession(
  appModule: Type<unknown>,
  options?: CreateYandexHandlerOptions,
): ReplaySession {
  const handler = createYandexHandler(appModule, options);
  return {
    handler,
    replay: (target: ReplayTarget) =>
      captureReplayOutcome(target.fixtureName, () => handler(target.event, target.context)),
    close: (): Promise<void> => handler.close(),
  };
}

/**
 * One-shot HTTP replay: loads the named fixture from `fixtures/http/`,
 * replays it through a dedicated public handler, then closes that handler.
 * A fixture load failure becomes a failed outcome without ever creating a
 * runtime.
 */
export async function replayHttpFixture(
  appModule: Type<unknown>,
  fixtureName: string,
  options?: FixtureSourceOptions,
): Promise<LoadedFixtureReplayOutcome> {
  return replayLoadedFixture(appModule, fixtureName, () => loadHttpFixture(fixtureName, options));
}

/**
 * One-shot Message Queue replay: loads the named fixture from `fixtures/mq/`,
 * replays it through a dedicated public handler, then closes that handler.
 * A fixture load failure becomes a failed outcome without ever creating a
 * runtime.
 */
export async function replayQueueFixture(
  appModule: Type<unknown>,
  fixtureName: string,
  options?: FixtureSourceOptions,
): Promise<LoadedFixtureReplayOutcome> {
  return replayLoadedFixture(appModule, fixtureName, () => loadQueueFixture(fixtureName, options));
}

async function replayLoadedFixture(
  appModule: Type<unknown>,
  fixtureName: string,
  load: () => Promise<InvocationFixture<unknown>>,
): Promise<LoadedFixtureReplayOutcome> {
  let fixture: InvocationFixture<unknown>;
  try {
    fixture = await load();
  } catch (error) {
    return { fixtureName, ok: false, error };
  }

  // The event/context travel to the handler as the EXACT references loaded
  // from the fixture file: no replay metadata is injected and nothing is
  // cloned, so raw/reference semantics match a real invocation.
  const session = createReplaySession(appModule);
  try {
    const outcome = await session.replay({
      fixtureName,
      event: fixture.event,
      context: fixture.context,
    });
    return { ...outcome, fixture };
  } finally {
    await session.close();
  }
}
