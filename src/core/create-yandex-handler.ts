import type { INestApplicationContext, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { detectTransport } from "./detect-transport";
import type {
  InjectableToken,
  InvocationContainer,
  TransportAdapter,
  TransportInvocation,
  YandexCloudFunctionHandler,
} from "./transport";
import { BUILTIN_TRANSPORTS } from "./transports";

/**
 * Handler returned by {@link createYandexHandler}: the exact
 * `YandexCloudFunctionHandler` signature the Yandex Cloud Functions runtime
 * invokes (docs/ARCHITECTURE.md section 3.1), plus an explicit teardown hook.
 */
export interface ClosableYandexCloudFunctionHandler extends YandexCloudFunctionHandler {
  /**
   * Releases the cached NestJS application.
   *
   * Shutdown behavior of the connector: Yandex Cloud Functions freezes or
   * reclaims execution environments without guaranteed teardown signals, so
   * no automatic hooks are registered and the application is intentionally
   * kept alive for warm invocations until the environment dies with it.
   * Environments where graceful teardown is required (custom runtimes, tests)
   * call `close()` explicitly; the next invocation then performs a fresh cold
   * start. `close()` is idempotent, safe before any invocation, and awaits an
   * in-flight initialization before releasing it.
   */
  close(): Promise<void>;
}

/**
 * Public entry point: turns a NestJS application module into a handler for
 * the Yandex Cloud Functions runtime (docs/ARCHITECTURE.md section 3).
 *
 * The Nest application is bootstrapped lazily on the first invocation and
 * cached for reuse by every later warm invocation; concurrent cold starts
 * share one initialization promise instead of building duplicate
 * applications (AGENTS.md section 10). All per-invocation data travels
 * through the transport invocation object — nothing invocation-scoped is
 * retained between calls (AGENTS.md section 11).
 */
export function createYandexHandler(appModule: Type<unknown>): ClosableYandexCloudFunctionHandler {
  return createInvocationRuntime(appModule, BUILTIN_TRANSPORTS);
}

/**
 * Internal runtime seam allowing tests (and future internal wiring) to drive
 * the full lifecycle against explicit transports without touching the public
 * API surface.
 */
export function createInvocationRuntime(
  appModule: Type<unknown>,
  transports: readonly TransportAdapter[],
): ClosableYandexCloudFunctionHandler {
  // Shared initialization promise in the factory closure: one cache per
  // created handler, never global state shared between unrelated handlers
  // (AGENTS.md sections 10.3 and 11).
  let applicationPromise: Promise<INestApplicationContext> | null = null;

  const getApplication = (): Promise<INestApplicationContext> => {
    if (!applicationPromise) {
      // Standalone application context: full dependency graph, no HTTP
      // listener, no platform peer dependencies beyond @nestjs/core itself
      // (`NestFactory.create` would require @nestjs/platform-express).
      applicationPromise = NestFactory.createApplicationContext(appModule).catch((error) => {
        // A failed cold start must not poison the environment forever:
        // clear the promise so the next invocation retries initialization.
        applicationPromise = null;
        throw error;
      });
    }
    return applicationPromise;
  };

  const handler: YandexCloudFunctionHandler = async (rawEvent, rawContext) => {
    // Detection runs once, before any initialization cost, so events nobody
    // claims fail fast and predictably (docs/ARCHITECTURE.md section 4).
    const transport = detectTransport(transports, rawEvent);

    const application = await getApplication();

    // Fresh per-invocation record: transports receive the untouched raw
    // event/context plus a container view over the warm application. Errors
    // from `invoke` propagate verbatim — HTTP and Message Queue own their
    // different failure semantics above this boundary.
    const invocation: TransportInvocation = {
      rawEvent,
      rawContext,
      container: createInvocationContainer(application),
    };
    return transport.invoke(invocation);
  };

  return Object.assign(handler, {
    close: async (): Promise<void> => {
      const pending = applicationPromise;
      applicationPromise = null;
      if (!pending) {
        return;
      }
      const application = await pending;
      await application.close();
    },
  });
}

function createInvocationContainer(application: INestApplicationContext): InvocationContainer {
  return {
    resolve<T>(token: InjectableToken<T>): Promise<T> {
      // `resolve` covers DEFAULT, REQUEST and TRANSIENT scopes alike; for
      // singletons it returns the shared instance (verified against
      // NestJS 11), keeping one resolution path for all provider scopes.
      return application.resolve<T>(token);
    },
  };
}
