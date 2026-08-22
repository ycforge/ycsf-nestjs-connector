import { Injectable, Module, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ConnectorError } from "./connector-error";
import {
  createInvocationRuntime,
  createYandexHandler,
  type ClosableYandexCloudFunctionHandler,
} from "./create-yandex-handler";
import type { TransportAdapter, TransportId, TransportInvocation } from "./transport";

/**
 * Lifecycle specs for the central runtime (issue #3). They bootstrap real
 * NestJS standalone application contexts and drive the full
 * detect -> init -> dispatch flow through the same code path the public
 * factory uses, with fixture transports standing in for the HTTP (#5) and
 * Message Queue (#7) adapters.
 *
 * Nest decorators are applied imperatively (exactly what legacy decorator
 * desugaring does) so the suite stays independent of decorator compilation
 * settings of this repository.
 */

const STRING_TOKEN = "PROBE_STRING_TOKEN";

let probeInstanceCounter = 0;

class ProbeService {
  readonly instanceId = ++probeInstanceCounter;
}
Injectable()(ProbeService);

class RootModule {}
Module({
  providers: [ProbeService, { provide: STRING_TOKEN, useValue: "string-token-value" }],
})(RootModule);

interface FixtureEvent {
  readonly kind: string;
}

interface ProbeResolution {
  readonly probeInstanceId: number;
  readonly stringTokenValue: string;
}

interface CapturingTransport extends TransportAdapter<FixtureEvent, ProbeResolution> {
  readonly invocations: TransportInvocation<FixtureEvent>[];
}

/**
 * Resolves providers from the invocation container and records every
 * invocation it served; used by the warm-reuse and isolation specs.
 */
function createResolvingTransport(id: TransportId, claimedKind: string): CapturingTransport {
  const invocations: TransportInvocation<FixtureEvent>[] = [];

  return {
    id,
    invocations,
    supports(rawEvent): rawEvent is FixtureEvent {
      return (
        typeof rawEvent === "object" &&
        rawEvent !== null &&
        "kind" in rawEvent &&
        rawEvent.kind === claimedKind
      );
    },
    async invoke(invocation) {
      invocations.push(invocation);
      const [probe, stringTokenValue] = await Promise.all([
        invocation.container.resolve(ProbeService),
        invocation.container.resolve<string>(STRING_TOKEN),
      ]);
      return { probeInstanceId: probe.instanceId, stringTokenValue };
    },
  };
}

/** Returns a fixed payload without touching the container; used by routing specs. */
function createFixedTransport(
  id: TransportId,
  claimedKind: string,
  result: unknown,
): TransportAdapter<FixtureEvent, unknown> & {
  readonly invocations: TransportInvocation<FixtureEvent>[];
} {
  const invocations: TransportInvocation<FixtureEvent>[] = [];

  return {
    id,
    invocations,
    supports(rawEvent): rawEvent is FixtureEvent {
      return (
        typeof rawEvent === "object" &&
        rawEvent !== null &&
        "kind" in rawEvent &&
        rawEvent.kind === claimedKind
      );
    },
    async invoke(invocation) {
      invocations.push(invocation);
      return result;
    },
  };
}

const HTTP_EVENT: FixtureEvent = Object.freeze({ kind: "api-gateway-v2", rawPath: "/probe" });
const QUEUE_EVENT: FixtureEvent = Object.freeze({
  kind: "message-queue-trigger",
  messageId: "m1",
});

async function capturedRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the invocation to reject");
}

function expectConnectorErrorCode(error: unknown, code: string): void {
  if (!(error instanceof ConnectorError)) {
    throw new Error(`expected ConnectorError, received ${String(error)}`);
  }
  expect(error.code).toBe(code);
}

describe("core invocation runtime lifecycle", () => {
  let createSpy: jest.SpyInstance;
  const runtimes: ClosableYandexCloudFunctionHandler[] = [];

  function makeRuntime(
    transports: readonly TransportAdapter[],
  ): ClosableYandexCloudFunctionHandler {
    const runtime = createInvocationRuntime(RootModule, transports);
    runtimes.push(runtime);
    return runtime;
  }

  beforeEach(() => {
    probeInstanceCounter = 0;
    createSpy = jest.spyOn(NestFactory, "createApplicationContext");
  });

  afterEach(async () => {
    while (runtimes.length > 0) {
      await runtimes.pop()?.close();
    }
    createSpy.mockRestore();
  });

  it("bootstraps the Nest application exactly once across sequential warm invocations", async () => {
    const http = createResolvingTransport("http", "api-gateway-v2");
    const runtime = makeRuntime([http]);

    const first = await runtime(HTTP_EVENT, { requestId: "inv-1" });
    const second = await runtime(HTTP_EVENT, { requestId: "inv-2" });

    expect(createSpy).toHaveBeenCalledTimes(1);
    // Deep-equal resolutions imply the identical singleton probe instance was
    // resolved from the same cached container in both invocations (AGENTS.md
    // section 10.2).
    expect(second).toEqual({
      probeInstanceId: expect.any(Number),
      stringTokenValue: "string-token-value",
    });
    expect(second).toEqual(first);
  });

  it("shares a single cold start between concurrent first invocations", async () => {
    const http = createResolvingTransport("http", "api-gateway-v2");
    const runtime = makeRuntime([http]);

    // All five invocations race the cold start; the shared initialization
    // promise must yield one application instead of five duplicates
    // (AGENTS.md section 10.3).
    const resolutions = await Promise.all([
      runtime(HTTP_EVENT, {}),
      runtime(HTTP_EVENT, {}),
      runtime(HTTP_EVENT, {}),
      runtime(HTTP_EVENT, {}),
      runtime(HTTP_EVENT, {}),
    ]);

    expect(createSpy).toHaveBeenCalledTimes(1);
    const [first, ...rest] = resolutions;
    for (const resolution of rest) {
      expect(resolution).toEqual(first);
    }
  });

  it("propagates bootstrap failures to all concurrent cold invocations and retries afterwards", async () => {
    createSpy.mockRejectedValueOnce(new Error("cold-start-boom"));
    const http = createResolvingTransport("http", "api-gateway-v2");
    const runtime = makeRuntime([http]);

    const attempts = [runtime(HTTP_EVENT, {}), runtime(HTTP_EVENT, {}), runtime(HTTP_EVENT, {})];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toThrow("cold-start-boom");
    }

    // The failed cold start is not cached as a permanent failure: the next
    // invocation retries initialization from scratch.
    expect(createSpy).toHaveBeenCalledTimes(1);
    await expect(runtime(HTTP_EVENT, {})).resolves.toBeDefined();
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it("propagates transport failures verbatim without wrapping or swallowing them", async () => {
    const handlerFailure = new Error("handler-boom");
    const failing: TransportAdapter<FixtureEvent, never> = {
      id: "http",
      supports(rawEvent): rawEvent is FixtureEvent {
        return (
          typeof rawEvent === "object" &&
          rawEvent !== null &&
          "kind" in rawEvent &&
          rawEvent.kind === "api-gateway-v2"
        );
      },
      invoke: () => Promise.reject(handlerFailure),
    };
    const runtime = makeRuntime([failing]);

    await expect(runtime(HTTP_EVENT, {})).rejects.toBe(handlerFailure);
  });

  it("routes every invocation to the transport claiming its event shape", async () => {
    const http = createResolvingTransport("http", "api-gateway-v2");
    const queue = createFixedTransport("message-queue", "message-queue-trigger", {
      acknowledged: true,
    });
    const runtime = makeRuntime([http, queue]);

    await expect(runtime(HTTP_EVENT, {})).resolves.toEqual({
      probeInstanceId: expect.any(Number),
      stringTokenValue: "string-token-value",
    });
    await expect(runtime(QUEUE_EVENT, {})).resolves.toEqual({ acknowledged: true });
    await expect(runtime(HTTP_EVENT, {})).resolves.toBeDefined();

    expect(http.invocations).toHaveLength(2);
    expect(queue.invocations).toHaveLength(1);
    // Each transport received its own event, never the other's.
    expect(http.invocations[0]?.rawEvent).toBe(HTTP_EVENT);
    expect(http.invocations[1]?.rawEvent).toBe(HTTP_EVENT);
    expect(queue.invocations[0]?.rawEvent).toBe(QUEUE_EVENT);
  });

  it("hands untouched raw references to each invocation without state leaking between them", async () => {
    const http = createResolvingTransport("http", "api-gateway-v2");
    const runtime = makeRuntime([http]);

    const contextOne = { requestId: "inv-1" };
    const contextTwo = { requestId: "inv-2" };
    await runtime(HTTP_EVENT, contextOne);
    await runtime(HTTP_EVENT, contextTwo);

    expect(http.invocations).toHaveLength(2);
    // Raw event/context pass through verbatim, per invocation...
    expect(http.invocations[0]?.rawContext).toBe(contextOne);
    expect(http.invocations[0]?.rawEvent).toBe(HTTP_EVENT);
    // ...and nothing from invocation N survives into invocation N+1
    // (AGENTS.md section 11).
    expect(http.invocations[1]?.rawContext).toBe(contextTwo);
    expect(http.invocations[1]).not.toBe(http.invocations[0]);
    expect(http.invocations[1]?.container).not.toBe(http.invocations[0]?.container);
  });

  it("rejects events no transport claims before spending any cold-start effort", async () => {
    const http = createResolvingTransport("http", "api-gateway-v2");
    const runtime = makeRuntime([http]);

    const failure = await capturedRejection(runtime({ unrecognized: true }, {}));
    expectConnectorErrorCode(failure, "UNKNOWN_INVOCATION_EVENT");

    // Detection precedes initialization: garbage traffic never pays for a
    // Nest bootstrap.
    expect(createSpy).not.toHaveBeenCalled();
  });

  describe("close()", () => {
    it("releases the cached application so the next invocation performs a fresh cold start", async () => {
      const http = createResolvingTransport("http", "api-gateway-v2");
      const runtime = makeRuntime([http]);

      const warm = await runtime(HTTP_EVENT, {});
      await runtime.close();

      // A fresh application yields a new probe singleton, so the resolution
      // differs from the pre-close warm value.
      const afterClose = await runtime(HTTP_EVENT, {});
      expect(createSpy).toHaveBeenCalledTimes(2);
      expect(afterClose).not.toEqual(warm);
    });

    it("performs no bootstrap when closed before any invocation", async () => {
      const http = createResolvingTransport("http", "api-gateway-v2");
      const runtime = makeRuntime([http]);

      await expect(runtime.close()).resolves.toBeUndefined();

      expect(createSpy).not.toHaveBeenCalled();
    });

    it("is idempotent after releasing the application", async () => {
      const http = createResolvingTransport("http", "api-gateway-v2");
      const runtime = makeRuntime([http]);

      await runtime(HTTP_EVENT, {});
      await runtime.close();

      await expect(runtime.close()).resolves.toBeUndefined();
      await expect(runtime.close()).resolves.toBeUndefined();
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it("awaits an in-flight initialization before releasing the application", async () => {
      // A fixed-payload transport keeps the gated invocation independent of
      // the stub application's (absent) container.
      const http = createFixedTransport("http", "api-gateway-v2", { handled: true });
      const runtime = makeRuntime([http]);

      let releaseGate!: (application: INestApplicationContext) => void;
      const gate = new Promise<INestApplicationContext>((resolveGate) => {
        releaseGate = resolveGate;
      });
      createSpy.mockImplementationOnce(() => gate);

      // Only close()/initialization are exercised on this gated path; a stub
      // keeps the test independent of real bootstrap timing.
      const stubClose = jest.fn(() => Promise.resolve());
      const stubApplication = {
        close: stubClose,
        resolve: () => Promise.reject(new Error("stub application resolves nothing")),
      } as unknown as INestApplicationContext;

      const inFlightInvocation = runtime(HTTP_EVENT, {});
      const closing = runtime.close();
      releaseGate(stubApplication);

      // The invocation completes on the gated initialization, then close()
      // releases exactly that application.
      await expect(inFlightInvocation).resolves.toBeDefined();
      await closing;
      expect(stubClose).toHaveBeenCalledTimes(1);

      // The released environment cold-starts again on demand.
      await runtime(HTTP_EVENT, {});
      expect(createSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("createYandexHandler public entry point", () => {
    it("wires the built-in transport registry behind the stable handler signature", async () => {
      const handler = createYandexHandler(RootModule);
      runtimes.push(handler);

      // Until the HTTP (#5) and MQ (#7) adapters register themselves in the
      // core's ordered registry, no transport claims any event — the shipped
      // contract is a clear UNKNOWN_INVOCATION_EVENT failure, never
      // half-working behavior.
      const failure = await capturedRejection(handler(HTTP_EVENT, {}));
      expectConnectorErrorCode(failure, "UNKNOWN_INVOCATION_EVENT");
      expect(createSpy).not.toHaveBeenCalled();
    });
  });
});
