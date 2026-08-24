import { createYandexHandler, type ClosableYandexCloudFunctionHandler } from "../index";
import { NestFactory } from "@nestjs/core";
import {
  FullStackHttpAppModule,
  UNEXPECTED_FAILURE_TEXT,
  capturedHttpContexts,
  echoStageObservations,
  makeHttpEvent,
  makeRuntimeContext,
  resetLifecycleObservations,
} from "./e2e-test-apps";

/**
 * End-to-end HTTP lifecycle coverage through the public connector API
 * (issue #14): a Yandex-shaped API Gateway v2 event enters
 * `createYandexHandler()`, a real NestJS application serves it through the
 * complete framework programming model (middleware, guards, pipes,
 * interceptors, filters, decorators) and the result leaves as a wire-valid
 * Yandex response envelope.
 *
 * Unlike the transport-level suites, every scenario here drives the FULL
 * public path — detection, cold start, dispatch, serialization — and the
 * lifecycle scenarios pin cold/warm/concurrent behavior on the public
 * factory rather than an internal runtime seam. Individual framework
 * behaviors have dedicated suites; this file proves they cooperate over one
 * warm application and that invocation data never crosses invocations.
 */

function parseEnvelopeBody(envelope: unknown): Record<string, unknown> {
  const body = (envelope as { body?: string }).body;
  if (typeof body !== "string") {
    throw new Error("expected a string body in the response envelope");
  }
  return JSON.parse(body) as Record<string, unknown>;
}

describe("HTTP end-to-end lifecycle through the public connector", () => {
  let runtime: ClosableYandexCloudFunctionHandler;

  beforeEach(() => {
    resetLifecycleObservations();
    runtime = createYandexHandler(FullStackHttpAppModule);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("drives one gateway event through the complete framework stack to a valid envelope", async () => {
    const requestId = "stack-http-1";
    const response = await runtime(
      makeHttpEvent({
        method: "POST",
        path: "/lifecycle/echo",
        rawQueryString: "n=3",
        jsonBody: { message: "ping" },
        headers: { "X-Request-Marker": "marker-1" },
      }),
      makeRuntimeContext(requestId),
    );

    // Controller result -> interceptor wrapper -> platform POST default
    // status -> serialized JSON envelope.
    expect(response).toEqual({
      statusCode: 201,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        via: "interceptor",
        payload: { received: { message: "ping" }, n: 3, awsRequestId: requestId },
      }),
      isBase64Encoded: false,
    });

    // The whole stack really ran, in platform order: middleware saw the
    // already-parsed body (parser registers first), then the guard ran
    // inside its proxy with header access.
    expect(echoStageObservations).toEqual([
      { middlewareSawBody: { message: "ping" } },
      { guardSawMarker: "marker-1" },
    ]);
  });

  it("dispatches exception-filter routes on the same warm application", async () => {
    const filtered = (await runtime(
      makeHttpEvent({ path: "/lifecycle/failures/filtered" }),
      makeRuntimeContext("filter-http-1"),
    )) as Record<string, unknown>;

    expect(filtered.statusCode).toBe(418);
    expect(parseEnvelopeBody(filtered)).toEqual({ handledBy: "stack-probe-filter" });
  });

  it("injects this invocation's context into controllers through @YandexContext()", async () => {
    const first = (await runtime(
      makeHttpEvent({ path: "/lifecycle/context" }),
      makeRuntimeContext("ctx-http-1"),
    )) as Record<string, unknown>;

    // Regression guard for issue #14: HTTP route arguments are built by
    // Nest's own proxies, so the decorator must surface the invocation's
    // frozen context there exactly like queue dispatch does.
    expect(parseEnvelopeBody(first)).toEqual({
      awsRequestId: "ctx-http-1",
      functionName: "fn-e2e-lifecycle",
      memoryLimitInMB: "1024",
    });

    // A second warm invocation observes strictly its own context instance:
    // same controller singleton, fresh per-invocation data (AGENTS.md §11).
    const second = (await runtime(
      makeHttpEvent({ path: "/lifecycle/context" }),
      makeRuntimeContext("ctx-http-2"),
    )) as Record<string, unknown>;
    expect(parseEnvelopeBody(second)).toMatchObject({ awsRequestId: "ctx-http-2" });
    expect(capturedHttpContexts[0]?.awsRequestId).toBe("ctx-http-1");
    expect(capturedHttpContexts[1]?.awsRequestId).toBe("ctx-http-2");
    expect(capturedHttpContexts[1]).not.toBe(capturedHttpContexts[0]);
  });

  it("exposes route parameters, headers and cookies to controllers", async () => {
    const response = (await runtime(
      makeHttpEvent({
        path: "/lifecycle/whoami/alice",
        headers: {
          "X-Request-Marker": "marker-alice",
          Cookie: "session=abc; theme=dark",
        },
      }),
      makeRuntimeContext("whoami-http-1"),
    )) as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    // Gateway Pascal-Cased header names reach controllers lowercased, like
    // platform routers expose them (observed, DATA-ANALYSE.md section B).
    expect(parseEnvelopeBody(response)).toEqual({
      name: "alice",
      marker: "marker-alice",
      cookie: "session=abc; theme=dark",
    });
  });

  it("maps HttpExceptions to their deterministic status-code envelope", async () => {
    const response = (await runtime(
      makeHttpEvent({ path: "/lifecycle/failures/http" }),
      makeRuntimeContext("httpexc-http-1"),
    )) as Record<string, unknown>;

    expect(response.statusCode).toBe(400);
    expect(parseEnvelopeBody(response)).toEqual({
      statusCode: 400,
      error: "Bad Request",
      message: "rejected-by-controller",
    });
  });

  it("reduces unexpected failures to the opaque 500 without leaking failure text", async () => {
    const response = (await runtime(
      makeHttpEvent({ path: "/lifecycle/failures/unexpected" }),
      makeRuntimeContext("boom-http-1"),
    )) as Record<string, unknown>;

    // Platform parity: neither the message nor any stack frame reaches the
    // client — the established generic envelope only.
    expect(response).toEqual({
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statusCode: 500, message: "Internal server error" }),
      isBase64Encoded: false,
    });
    expect(JSON.stringify(response)).not.toContain(UNEXPECTED_FAILURE_TEXT);

    // The failing invocation must not poison the environment: the very next
    // warm request succeeds (AGENTS.md section 8).
    const healthy = (await runtime(
      makeHttpEvent({ path: "/lifecycle/context" }),
      makeRuntimeContext("boom-http-2"),
    )) as Record<string, unknown>;
    expect(healthy.statusCode).toBe(200);
  });

  it("keeps concurrent warm invocations isolated from each other's request data", async () => {
    const plans = [
      { requestId: "cc-http-a", name: "ann", marker: "marker-a", body: { n: 1 } },
      { requestId: "cc-http-b", name: "bob", marker: "marker-b", body: { n: 2 } },
      { requestId: "cc-http-c", name: "cid", marker: "marker-c", body: { n: 3 } },
      { requestId: "cc-http-d", name: "dee", marker: "marker-d", body: { n: 4 } },
    ];

    const responses = (await Promise.all([
      runtime(makeHttpEvent({ path: `/lifecycle/whoami/${plans[0]!.name}` }), {
        ...makeRuntimeContext(plans[0]!.requestId),
      }),
      runtime(
        makeHttpEvent({
          method: "POST",
          path: "/lifecycle/echo",
          rawQueryString: `n=${plans[1]!.body.n}`,
          jsonBody: plans[1]!.body,
          headers: { "X-Request-Marker": plans[1]!.marker },
        }),
        makeRuntimeContext(plans[1]!.requestId),
      ),
      runtime(makeHttpEvent({ path: `/lifecycle/whoami/${plans[2]!.name}` }), {
        ...makeRuntimeContext(plans[2]!.requestId),
      }),
      runtime(
        makeHttpEvent({
          method: "POST",
          path: "/lifecycle/echo",
          rawQueryString: `n=${plans[3]!.body.n}`,
          jsonBody: plans[3]!.body,
          headers: { "X-Request-Marker": plans[3]!.marker },
        }),
        makeRuntimeContext(plans[3]!.requestId),
      ),
    ])) as Record<string, unknown>[];

    // Every response pairs with EXACTLY its own request data — no path,
    // body, header or execution context of a sibling invocation appears.
    const [first, second, third, fourth] = responses;
    expect(first?.statusCode).toBe(200);
    expect(parseEnvelopeBody(first)).toEqual({ name: "ann", marker: null, cookie: null });
    expect(second?.statusCode).toBe(201);
    expect(parseEnvelopeBody(second)).toEqual({
      via: "interceptor",
      payload: { received: { n: 2 }, n: 2, awsRequestId: "cc-http-b" },
    });
    expect(third?.statusCode).toBe(200);
    expect(parseEnvelopeBody(third)).toEqual({ name: "cid", marker: null, cookie: null });
    expect(fourth?.statusCode).toBe(201);
    expect(parseEnvelopeBody(fourth)).toEqual({
      via: "interceptor",
      payload: { received: { n: 4 }, n: 4, awsRequestId: "cc-http-d" },
    });

    // The guard observed only markers belonging to echo requests, each once.
    expect(echoStageObservations.filter((entry) => entry.guardSawMarker !== undefined)).toEqual([
      { guardSawMarker: "marker-b" },
      { guardSawMarker: "marker-d" },
    ]);
  });
});

describe("cold start and warm reuse through the public connector", () => {
  let runtime: ClosableYandexCloudFunctionHandler;
  let createSpy: jest.SpyInstance;

  beforeEach(() => {
    resetLifecycleObservations();
    // Since issue #6 the runtime bootstraps Nest over the connector's
    // in-memory adapter; counting `NestFactory.create` calls therefore counts
    // cold starts without touching internal state.
    createSpy = jest.spyOn(NestFactory, "create");
  });

  afterEach(async () => {
    createSpy.mockRestore();
    if (runtime) {
      await runtime.close();
    }
  });

  it("bootstraps exactly once and reuses the warm application across invocations", async () => {
    runtime = createYandexHandler(FullStackHttpAppModule);

    for (const requestId of ["warm-1", "warm-2", "warm-3"]) {
      const response = (await runtime(
        makeHttpEvent({ path: "/lifecycle/context" }),
        makeRuntimeContext(requestId),
      )) as Record<string, unknown>;
      expect(response.statusCode).toBe(200);
      expect(parseEnvelopeBody(response)).toMatchObject({ awsRequestId: requestId });
    }

    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("shares one cold start between concurrent first invocations", async () => {
    runtime = createYandexHandler(FullStackHttpAppModule);

    // All four invocations race the uninitialized application; the shared
    // initialization promise must yield one bootstrap (AGENTS.md §10.3).
    const responses = (await Promise.all(
      ["race-1", "race-2", "race-3", "race-4"].map((requestId) =>
        runtime(makeHttpEvent({ path: "/lifecycle/context" }), makeRuntimeContext(requestId)),
      ),
    )) as Record<string, unknown>[];

    expect(createSpy).toHaveBeenCalledTimes(1);
    responses.forEach((response, index) => {
      expect(response.statusCode).toBe(200);
      expect(parseEnvelopeBody(response)).toMatchObject({ awsRequestId: `race-${index + 1}` });
    });
  });

  it("propagates a failed bootstrap to concurrent invocations and retries afterwards", async () => {
    runtime = createYandexHandler(FullStackHttpAppModule);
    createSpy.mockRejectedValueOnce(new Error("bootstrap-boom"));

    const attempts = [
      runtime(makeHttpEvent(), makeRuntimeContext("failed-cold-1")),
      runtime(makeHttpEvent(), makeRuntimeContext("failed-cold-2")),
    ];
    for (const attempt of attempts) {
      await expect(attempt).rejects.toThrow("bootstrap-boom");
    }

    // The failed cold start is not cached as a permanent rejection: the next
    // invocation initializes from scratch and succeeds.
    const recovered = (await runtime(
      makeHttpEvent({ path: "/lifecycle/context" }),
      makeRuntimeContext("recovered-cold"),
    )) as Record<string, unknown>;
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(recovered.statusCode).toBe(200);
  });

  it("performs a fresh cold start after close() releases the cached application", async () => {
    runtime = createYandexHandler(FullStackHttpAppModule);

    const beforeClose = (await runtime(
      makeHttpEvent({ path: "/lifecycle/context" }),
      makeRuntimeContext("pre-close"),
    )) as Record<string, unknown>;
    expect(beforeClose.statusCode).toBe(200);
    expect(createSpy).toHaveBeenCalledTimes(1);

    await runtime.close();
    const afterClose = (await runtime(
      makeHttpEvent({ path: "/lifecycle/context" }),
      makeRuntimeContext("post-close"),
    )) as Record<string, unknown>;

    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(afterClose.statusCode).toBe(200);
    // A brand-new application served the post-close invocation: its captured
    // context comes from the fresh DI graph, not a stale cache.
    expect(capturedHttpContexts.at(-1)?.awsRequestId).toBe("post-close");
  });
});
