import { All, Controller, Module } from "@nestjs/common";
import {
  resolveInvocationExecutionContext,
  resolveInvocationHttpRequest,
} from "../context/invocation-scope";
import type { YandexExecutionContext } from "../context/yandex-execution-context";
import { createYandexHandler } from "../core/create-yandex-handler";
import { loadHttpFixture, type HttpInvocationFixture } from "../testing/invocation-fixtures";
import type { NormalizedHttpRequest } from "./normalized-request";

/**
 * Conformance suite against sanitized captured Yandex invocations (issue #11).
 *
 * Every JSON file under `fixtures/http/` is a full warm-invocation dump of a
 * real API Gateway payload-format-2.0 delivery (provenance and sanitization:
 * fixtures/README.md). Each dump is replayed through the PUBLIC runtime —
 * exactly the `(event, context) => response` signature Yandex calls — and the
 * normalized request is captured inside the controller via the invocation
 * scope. The tests pin observed gateway behavior that must never regress
 * (DATA-ANALYSE.md), including the quirks listed in AGENTS.md section 4.
 *
 * Decorators are applied imperatively (legacy desugaring shape) so the suite
 * stays independent of this repository's decorator compilation settings.
 */

interface CapturedRequest {
  readonly normalizedRequest: NormalizedHttpRequest;
  readonly executionContext: YandexExecutionContext;
}

const CAPTURES: CapturedRequest[] = [];

class ConformanceController {
  captureRest(rest: string): object {
    CAPTURES.push({
      normalizedRequest: resolveInvocationHttpRequest(),
      executionContext: resolveInvocationExecutionContext(),
    });
    return {
      rest,
      path: CAPTURES[CAPTURES.length - 1]!.normalizedRequest.path,
    };
  }
}

Controller()(ConformanceController);

const controllerDescriptor = Object.getOwnPropertyDescriptor(
  ConformanceController.prototype,
  "captureRest",
);
if (!controllerDescriptor) {
  throw new Error("missing descriptor for captureRest");
}
All("*rest")(ConformanceController.prototype, "captureRest", controllerDescriptor);

class ConformanceModule {}

Module({ controllers: [ConformanceController] })(ConformanceModule);

const ALL_HTTP_FIXTURE_NAMES = [
  "get-without-query",
  "catch-all-path-parameters",
  "repeated-query-parameters",
  "url-encoded-query-values",
  "encoded-path-characters",
  "custom-headers-and-cookies",
  "json-body-plain-utf8",
  "plain-text-body-base64",
  "form-body-base64",
  "binary-body-base64",
  "custom-json-content-type-base64",
] as const;

async function replay(name: string): Promise<{
  fixture: HttpInvocationFixture;
  captured: CapturedRequest;
  response: unknown;
}> {
  const fixture = await loadHttpFixture(name);
  const handler = createYandexHandler(ConformanceModule);
  try {
    const response = await handler(fixture.event, fixture.context);
    // Match by request id, not by position: concurrent replays interleave
    // their pushes into CAPTURES.
    const captured = CAPTURES.find(
      (entry) => entry.executionContext.awsRequestId === fixture.context.awsRequestId,
    );
    if (!captured) {
      throw new Error(`fixture "${name}" produced no controller capture`);
    }
    return { fixture, captured, response };
  } finally {
    await handler.close();
  }
}

function bodyText(normalizedRequest: NormalizedHttpRequest): string {
  if (normalizedRequest.body === null) {
    throw new Error("expected a non-null request body");
  }
  return Buffer.from(normalizedRequest.body).toString("utf8");
}

describe("HTTP conformance fixtures (issue #11)", () => {
  beforeEach(() => {
    CAPTURES.length = 0;
  });

  it("replays every committed HTTP fixture through the public handler", async () => {
    expect(ALL_HTTP_FIXTURE_NAMES).toHaveLength(11);
    for (const name of ALL_HTTP_FIXTURE_NAMES) {
      const { response } = await replay(name);
      // Every replay must reach the catch-all controller and produce the
      // wire-valid four-field envelope (statusCode/body/isBase64Encoded).
      expect(response).toMatchObject({ statusCode: 200, isBase64Encoded: false });
      expect(typeof (response as { body?: unknown }).body).toBe("string");
    }
    expect(CAPTURES).toHaveLength(ALL_HTTP_FIXTURE_NAMES.length);
  });

  it("routes on rawPath even when the gateway rebuilt requestContext.http.path", async () => {
    // get-without-query carries httpPath "/probe/ping?" (trailing ?); the
    // encoded-path fixture carries a decoded "?" INSIDE its path. Both must
    // route by rawPath; requestContext.http.path must stay untouched.
    const trailing = await replay("get-without-query");
    expect(trailing.fixture.event.requestContext.http.path).toBe("/probe/ping?");
    expect(trailing.captured.normalizedRequest.path).toBe("/probe/ping");

    const encoded = await replay("encoded-path-characters");
    expect(encoded.fixture.event.rawPath).toBe("/probe/with space/and/encoded?chars");
    expect(encoded.fixture.event.requestContext.http.path).toBe(
      "/probe/with space/and/encoded?chars?x=1",
    );
    expect(encoded.captured.normalizedRequest.path).toBe("/probe/with space/and/encoded?chars");
  });

  it("preserves repeated query parameters in both gateway representations", async () => {
    const { captured } = await replay("repeated-query-parameters");
    const { normalizedRequest } = captured;

    expect(normalizedRequest.rawQueryString).toBe("multi=one&multi=two&multi=three&flag=on");
    // Verbatim comma join in queryStringParameters...
    expect(normalizedRequest.queryStringParameters.multi).toBe("one,two,three");
    // ...and true multiplicity in multiValueParameters.
    expect(normalizedRequest.multiValueParameters.multi).toEqual(["one", "two", "three"]);
    // searchParams parses the canonical rawQueryString, not the collapsed map.
    expect(normalizedRequest.searchParams.getAll("multi")).toEqual(["one", "two", "three"]);
    // Declared parameters collapse repeats: last value wins.
    expect(captured.normalizedRequest.raw.parameters?.multi).toBe("three");
  });

  it("decodes url-encoded query values without touching the raw query string", async () => {
    const { captured, fixture } = await replay("url-encoded-query-values");
    const { normalizedRequest } = captured;

    expect(normalizedRequest.searchParams.get("text")).toBe("тест");
    expect(normalizedRequest.searchParams.get("emoji")).toBe("😀");
    expect(normalizedRequest.searchParams.get("phrase")).toBe("hello world");
    expect(normalizedRequest.searchParams.get("punct")).toBe("/?&=%#+");
    expect(normalizedRequest.rawQueryString).toContain("%D1%82%D0%B5%D1%81%D1%82");
    // Rebuilt gateway path lowercased percent hex and swapped + for spaces —
    // another reason it must never become the routing source.
    expect(fixture.event.requestContext.http.path).toContain("phrase=hello+world");
    expect(fixture.event.requestContext.http.path).toContain("%d1%82%d0%b5%d1%81%d1%82");
  });

  it("exposes catch-all gateway path parameters verbatim", async () => {
    const users = await replay("catch-all-path-parameters");
    expect(users.captured.normalizedRequest.pathParameters.ID).toBe("probe/users/user-42");
    expect(users.captured.normalizedRequest.path).toBe("/probe/users/user-42");
  });

  it("keeps custom headers, cookies and client metadata accessible", async () => {
    const { captured, fixture } = await replay("custom-headers-and-cookies");
    const { normalizedRequest, executionContext } = captured;

    expect(normalizedRequest.headers.Authorization).toBe("Bearer REDACTED_AUTHORIZATION");
    expect(normalizedRequest.headers.Cookie).toContain("test_cookie=cookie-value");
    expect(normalizedRequest.sourceIp).toBe("203.0.113.10");
    expect(normalizedRequest.userAgent).toBe(fixture.event.requestContext.http.userAgent);
    // Correlation ids line up across event/context/header.
    expect(normalizedRequest.requestId).toBe(fixture.context.awsRequestId);
    expect(executionContext.awsRequestId).toBe(fixture.context.awsRequestId);
  });

  it("keeps application/json bodies plain UTF-8 text", async () => {
    const { captured, fixture } = await replay("json-body-plain-utf8");
    expect(fixture.event.isBase64Encoded).toBe(false);
    expect(bodyText(captured.normalizedRequest)).toBe(
      '{"orderId":"order-conf-1","comment":"подтверждение ✔"}',
    );
  });

  it("decodes base64 bodies for non-json content types without parsing them", async () => {
    const text = await replay("plain-text-body-base64");
    expect(text.fixture.event.isBase64Encoded).toBe(true);
    expect(bodyText(text.captured.normalizedRequest)).toBe("Hello, Yandex Cloud Function!");

    const form = await replay("form-body-base64");
    // Forms arrive unparsed: normalization must not invent form handling.
    expect(bodyText(form.captured.normalizedRequest)).toBe(
      "name=Alice&age=30&active=true&tag=one&tag=two",
    );

    const binary = await replay("binary-body-base64");
    // The captured artifact decodes byte-exactly; documented in DATA-ANALYSE
    // (its prose lists byte 5 as 0x77 while the base64 yields 0x7f — the
    // base64 string is the authoritative artifact).
    expect([...binary.captured.normalizedRequest.body!]).toEqual([0, 1, 2, 3, 127, 128, 255]);

    const customJson = await replay("custom-json-content-type-base64");
    // Suffix JSON types are NOT granted plain-text treatment.
    expect(customJson.fixture.event.isBase64Encoded).toBe(true);
    expect(bodyText(customJson.captured.normalizedRequest)).toBe('{"source":"custom"}');
  });

  it("surfaces an empty bodiless GET as a null body despite isBase64Encoded", async () => {
    const { captured, fixture } = await replay("get-without-query");
    expect(fixture.event.isBase64Encoded).toBe(true);
    expect(captured.normalizedRequest.body).toBeNull();
  });

  it("normalizes the execution context without coercing observed types", async () => {
    const { captured, fixture } = await replay("get-without-query");
    const { executionContext } = captured;

    // memoryLimitInMB stays the string the runtime delivers.
    expect(executionContext.memoryLimitInMB).toBe("1024");
    expect(typeof executionContext.memoryLimitInMB).toBe("string");
    expect(executionContext.deadlineMs).toBeGreaterThan(0);
    // timeEpoch is seconds on the wire despite its name.
    expect(fixture.event.requestContext.timeEpoch).toBeLessThan(10_000_000_000);
    // The undocumented _data mirror stays reachable through raw.
    expect((executionContext.raw as { _data?: unknown })._data).toEqual(fixture.event);
    // Serialization guard: the token placeholder can never leak through toJSON.
    expect(JSON.stringify(executionContext)).not.toContain("[REDACTED]");
    expect(executionContext.toJSON().token).toBe("REDACTED_TOKEN");
  });

  it("isolates sequential replays: warm invocations never observe each other", async () => {
    const first = await replay("repeated-query-parameters");
    const second = await replay("url-encoded-query-values");

    expect(first.captured.executionContext.awsRequestId).not.toBe(
      second.captured.executionContext.awsRequestId,
    );
    // Both fixtures share the path /probe/query, so isolation must be visible
    // in the invocation-scoped data: the second replay carries its own query
    // string, never the first one's repeated parameters.
    expect(second.captured.normalizedRequest.rawQueryString).toBe(
      "text=%D1%82%D0%B5%D1%81%D1%82&emoji=%F0%9F%98%80&phrase=hello%20world&punct=%2F%3F%26%3D%25%23%2B",
    );
    expect(second.captured.normalizedRequest.searchParams.has("multi")).toBe(false);
  });

  it("isolates concurrent replays of all fixtures", async () => {
    const results = await Promise.all(ALL_HTTP_FIXTURE_NAMES.map((name) => replay(name)));
    const requestIds = results.map((result) => result.fixture.context.awsRequestId);
    // Distinct dumps carry distinct request ids and each capture saw its own.
    expect(new Set(requestIds).size).toBe(results.length);
    results.forEach((result, index) => {
      expect(result.captured.executionContext.awsRequestId).toBe(requestIds[index]);
    });
  });
});
