import {
  Body,
  Controller,
  Get,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { httpApiGatewayV2Transport } from "./adapter";
import type { RawHttpApiGatewayV2Event } from "./raw-event";
import {
  createInvocationRuntime,
  type ClosableYandexCloudFunctionHandler,
} from "../core/create-yandex-handler";
import type { YandexHttpResponseFacade } from "./response-facade";

/**
 * End-to-end dispatch integration specs (issue #6): real NestJS controllers
 * driven through the public runtime and the built-in HTTP transport, proving
 * conventional controllers produce wire-valid Yandex envelopes.
 *
 * Decorators are applied imperatively (exactly what legacy decorator
 * desugaring does) so the suite stays independent of this repository's
 * decorator compilation settings.
 */

const BINARY_BYTES = [0x00, 0xff, 0x10, 0xfe, 0x7f] as const;

class ProbeController {
  ping(): object {
    return { pong: true };
  }

  search(queryValue: unknown): object {
    return { queryValue };
  }

  create(body: unknown): object {
    return { received: body };
  }

  missing(): never {
    throw new NotFoundException("item absent");
  }

  boom(): never {
    throw new Error("controller-boom");
  }

  binary(): Buffer {
    return Buffer.from(BINARY_BYTES);
  }

  cookies(responseFacade: YandexHttpResponseFacade): object {
    responseFacade.appendHeader("Set-Cookie", "session=abc; Path=/");
    responseFacade.appendHeader("Set-Cookie", "tracking=off; Path=/; Secure");
    return { attached: true };
  }

  // Declared last so the :userId pattern never shadows the static routes
  // above: routers resolve first-match-wins over declaration order.
  user(userId: string): object {
    return { userId };
  }
}

Controller("probe")(ProbeController);

function methodDescriptor(name: string): TypedPropertyDescriptor<unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(ProbeController.prototype, name);
  if (!descriptor) {
    throw new Error(`missing descriptor for ${name}`);
  }
  return descriptor;
}

Get("ping")(ProbeController.prototype, "ping", methodDescriptor("ping"));

Get("search")(ProbeController.prototype, "search", methodDescriptor("search"));
Query("q")(ProbeController.prototype, "search", 0);

Post("items")(ProbeController.prototype, "create", methodDescriptor("create"));
Body()(ProbeController.prototype, "create", 0);

Get("missing")(ProbeController.prototype, "missing", methodDescriptor("missing"));
Get("boom")(ProbeController.prototype, "boom", methodDescriptor("boom"));
Get("binary")(ProbeController.prototype, "binary", methodDescriptor("binary"));

Get("cookies")(ProbeController.prototype, "cookies", methodDescriptor("cookies"));
Res({ passthrough: true })(ProbeController.prototype, "cookies", 0);

// Declared last on the class (see ProbeController): static routes must
// register before the parameterized pattern.
Get(":userId")(ProbeController.prototype, "user", methodDescriptor("user"));
Param("userId")(ProbeController.prototype, "user", 0);

class ProbeModule {}
Module({ controllers: [ProbeController] })(ProbeModule);

interface EventOverrides {
  readonly method?: string;
  readonly path?: string;
  readonly rawQueryString?: string;
  readonly jsonBody?: unknown;
  readonly rawJsonBody?: string;
}

function makeHttpEvent(overrides: EventOverrides = {}): RawHttpApiGatewayV2Event {
  const path = overrides.path ?? "/probe/ping";
  const rawQueryString = overrides.rawQueryString ?? "";
  let body = "";
  let isBase64Encoded = true;
  const headers: Record<string, string> = {};
  if (overrides.rawJsonBody !== undefined || overrides.jsonBody !== undefined) {
    const text = overrides.rawJsonBody ?? JSON.stringify(overrides.jsonBody);
    headers["Content-Type"] = "application/json";
    body = Buffer.from(text, "utf8").toString("base64");
    isBase64Encoded = true;
  }
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString,
    headers,
    queryStringParameters: {},
    requestContext: {
      authorizer: {},
      http: {
        method: overrides.method ?? "GET",
        path: `${path}?${rawQueryString}`,
        sourceIp: "203.0.113.10",
        userAgent: "fixture-agent/1.0",
      },
      requestId: "f18fed85-7096-4f0e-a6db-e2c5e37e925f",
      time: "21/Aug/2026:16:16:30 +0000",
      timeEpoch: 1787328990,
    },
    body,
    isBase64Encoded,
    pathParameters: {},
    parameters: {},
    multiValueParameters: {},
    operationId: "41cf33042e33".padEnd(64, "0"),
  };
}

/** Observed-shape runtime context (DATA-ANALYSE.md section D), placeholder values only. */
const RUNTIME_CONTEXT = {
  awsRequestId: "f18fed85-7096-4f0e-a6db-e2c5e37e925f",
  functionName: "fn-http-fixture",
  functionVersion: "$LATEST",
  functionFolderId: "folder-fixture",
  memoryLimitInMB: "1024",
  deadlineMs: 1787328996791,
  logGroupName: "",
};

describe("controller dispatch through the public runtime", () => {
  let runtime: ClosableYandexCloudFunctionHandler;

  beforeEach(() => {
    runtime = createInvocationRuntime(ProbeModule, [httpApiGatewayV2Transport]);
  });

  afterEach(async () => {
    if (runtime) {
      await runtime.close();
    }
  });

  it("serializes a controller's returned object as a JSON envelope", async () => {
    const result = (await runtime(makeHttpEvent(), RUNTIME_CONTEXT)) as Record<string, unknown>;

    expect(result.statusCode).toBe(200);
    expect(result.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(result.body as string)).toEqual({ pong: true });
    expect(result.isBase64Encoded).toBe(false);
  });

  it("injects matched route parameters through @Param()", async () => {
    const result = (await runtime(
      makeHttpEvent({ path: "/probe/user-42" }),
      RUNTIME_CONTEXT,
    )) as Record<string, unknown>;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body as string)).toEqual({ userId: "user-42" });
  });

  it("hands @Query() repeated parameters as arrays from the canonical query string", async () => {
    const result = (await runtime(
      makeHttpEvent({
        path: "/probe/search",
        rawQueryString: "q=alpha&q=beta&flag=on",
      }),
      RUNTIME_CONTEXT,
    )) as Record<string, unknown>;

    expect(result.statusCode).toBe(200);
    // Multiplicity survives: no comma-folded "alpha,beta" anywhere.
    expect(JSON.parse(result.body as string)).toEqual({
      queryValue: ["alpha", "beta"],
    });
  });

  it("parses declared JSON bodies into @Body()", async () => {
    const result = (await runtime(
      makeHttpEvent({ method: "POST", path: "/probe/items", jsonBody: { name: "widget" } }),
      RUNTIME_CONTEXT,
    )) as Record<string, unknown>;

    // Platform parity: POST routes default to 201 Created.
    expect(result.statusCode).toBe(201);
    expect(JSON.parse(result.body as string)).toEqual({ received: { name: "widget" } });
    expect((result.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("maps malformed JSON bodies to a deterministic 400 through the exception layer", async () => {
    const result = (await runtime(
      makeHttpEvent({
        method: "POST",
        path: "/probe/items",
        rawJsonBody: "{ definitely-not-json",
      }),
      RUNTIME_CONTEXT,
    )) as Record<string, unknown>;

    expect(result.statusCode).toBe(400);
    const payload = JSON.parse(result.body as string);
    expect(payload.error).toBe("Bad Request");
    expect(typeof payload.message).toBe("string");
  });

  it("maps HttpExceptions raised by controllers to their status codes", async () => {
    const result = (await runtime(
      makeHttpEvent({ path: "/probe/missing" }),
      RUNTIME_CONTEXT,
    )) as Record<string, unknown>;
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body as string)).toEqual(
      expect.objectContaining({ message: "item absent", statusCode: 404 }),
    );
  });

  it("maps unhandled controller failures to the deterministic 500 without leaking internals", async () => {
    const result = (await runtime(
      makeHttpEvent({ path: "/probe/boom" }),
      RUNTIME_CONTEXT,
    )) as Record<string, unknown>;

    // Platform parity: unexpected failures become an opaque internal server
    // error; neither the message nor any stack frame reaches the client.
    expect(result).toEqual({
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ statusCode: 500, message: "Internal server error" }),
      isBase64Encoded: false,
    });
    expect(String(result.body)).not.toContain("controller-boom");
  });

  it("returns binary buffers base64-encoded without corruption", async () => {
    const result = (await runtime(
      makeHttpEvent({ path: "/probe/binary" }),
      RUNTIME_CONTEXT,
    )) as Record<string, unknown>;

    expect(result.isBase64Encoded).toBe(true);
    expect([...Buffer.from(result.body as string, "base64")]).toEqual([...BINARY_BYTES]);
    expect((result.headers as Record<string, string>)["content-type"]).toBe(
      "application/octet-stream",
    );
  });

  it("emits multiple Set-Cookie appends through multiValueHeaders", async () => {
    const result = (await runtime(
      makeHttpEvent({ path: "/probe/cookies" }),
      RUNTIME_CONTEXT,
    )) as Record<string, unknown>;

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body as string)).toEqual({ attached: true });
    expect(result.multiValueHeaders).toEqual({
      "set-cookie": ["session=abc; Path=/", "tracking=off; Path=/; Secure"],
    });
    expect(Object.keys(result.headers as object)).not.toContain("set-cookie");
  });

  it("keeps invocations isolated on the warm application across sequential requests", async () => {
    const first = (await runtime(
      makeHttpEvent({ method: "POST", path: "/probe/items", jsonBody: { n: 1 } }),
      RUNTIME_CONTEXT,
    )) as Record<string, unknown>;
    const second = (await runtime(
      makeHttpEvent({ method: "POST", path: "/probe/items", jsonBody: { n: 2 } }),
      RUNTIME_CONTEXT,
    )) as Record<string, unknown>;

    // Invocation N's payload never appears in N+1 (AGENTS.md section 11).
    expect(JSON.parse(first.body as string)).toEqual({ received: { n: 1 } });
    expect(JSON.parse(second.body as string)).toEqual({ received: { n: 2 } });
    expect(first).not.toBe(second);
  });
});
