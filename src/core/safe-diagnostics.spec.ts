import { All, Controller, Module } from "@nestjs/common";
import { buildYandexExecutionContext } from "../context/build-yandex-execution-context";
import {
  resolveInvocationExecutionContext,
  resolveInvocationHttpRequest,
} from "../context/invocation-scope";
import { createYandexHandler } from "./create-yandex-handler";
import { ConnectorError } from "./connector-error";
import type { QueueBatch, QueueBodyDeserializer } from "../mq/message";
import type { RawQueueEvent } from "../mq/raw-event";
import { normalizeQueueBatch } from "../mq/normalize-batch";
import {
  REDACTED_AUTHORIZATION,
  REDACTED_COOKIE,
  REDACTED_IP,
  REDACTED_TOKEN,
  safeDiagnostics,
} from "./safe-diagnostics";

/**
 * Specs for the explicit redaction policy between raw runtime data and safe
 * diagnostics (issue #13). The policy is documented in full in the
 * src/core/safe-diagnostics.ts module header; every rule below pins one of
 * its observable guarantees, including the documented NON-goals (nested
 * tokens, non-header-map `authorization` fields and ordinary `body` fields
 * of application payloads stay intact).
 */

/** Observed-shaped runtime context with a sentinel IAM secret. */
const OBSERVED_CONTEXT: Record<string, unknown> = {
  awsRequestId: "f18fed85-7096-4f0e-a6db-e2c5e37e925f",
  functionName: "d4epk2u927vj48ptg4i6",
  functionVersion: "d4eu4mg45akicl7ad5ta",
  functionFolderId: "b1g9kusggl9k4bmurq6s",
  memoryLimitInMB: "1024",
  deadlineMs: 1787328996791,
  logGroupName: "",
  token: "sentinel-iam-secret-value",
  uberTraceId: "195befaa12da73b5:59ea0be13cb39c87:41d0f3eae511878e:1",
  _data: { deepCopyOfEvent: true },
};

describe("safeDiagnostics: credential and personal-data redaction", () => {
  it("redacts the root-level runtime token", () => {
    const serialized = safeDiagnostics({ ...OBSERVED_CONTEXT }) as Record<string, unknown>;

    expect(serialized["token"]).toBe(REDACTED_TOKEN);
    // Non-sensitive context scalars stay verbatim for correlation.
    expect(serialized["awsRequestId"]).toBe("f18fed85-7096-4f0e-a6db-e2c5e37e925f");
  });

  it("keeps nested token properties: only the ROOT object's token is the IAM secret", () => {
    // Documented scope: application payloads legitimately carry domain
    // fields named token; blindly redacting them would destroy business
    // data. Only the serialized value's own root level — plus nodes matching
    // the runtime-context fingerprint below — is reserved for secrets.
    const payload = {
      order: { token: "business-domain-value", nested: { token: "inner-value" } },
      items: [{ token: "item-domain-value" }],
    };
    expect(safeDiagnostics(payload)).toEqual(payload);
  });

  it("redacts the token of any node shaped like the runtime context", () => {
    // Realistic diagnostics wrap the execution context under a message key;
    // the fingerprint (awsRequestId + functionName + own token) keeps that
    // pattern safe instead of relying on callers serializing the bare
    // context as the root value.
    const wrapper = { message: "invocation handled", ctx: { ...OBSERVED_CONTEXT } };

    const serialized = safeDiagnostics(wrapper) as {
      ctx: Record<string, unknown>;
    };

    expect(serialized.ctx["token"]).toBe(REDACTED_TOKEN);
    expect(serialized.ctx["awsRequestId"]).toBe("f18fed85-7096-4f0e-a6db-e2c5e37e925f");
  });

  it("redacts Authorization and Cookie header values case-insensitively", () => {
    const serialized = safeDiagnostics({
      headers: {
        Authorization: "Bearer sentinel-auth-value",
        COOKIE: "session=sentinel-cookie-value",
        authorization: "Basic sentinel-lowercase-value",
      },
    }) as { headers: Record<string, string> };

    expect(serialized.headers["Authorization"]).toBe(REDACTED_AUTHORIZATION);
    expect(serialized.headers["COOKIE"]).toBe(REDACTED_COOKIE);
    expect(serialized.headers["authorization"]).toBe(REDACTED_AUTHORIZATION);
  });

  it("redacts every observed client-IP field and IP-bearing gateway header", () => {
    const serialized = safeDiagnostics({
      headers: {
        "X-Forwarded-For": "203.0.113.10",
        "X-Envoy-External-Address": "203.0.113.11",
        "X-Real-Remote-Address": "203.0.113.10:50384",
      },
      requestContext: { http: { sourceIp: "203.0.113.10" } },
    }) as {
      headers: Record<string, string>;
      requestContext: { http: { sourceIp: string } };
    };

    expect(serialized.headers["X-Forwarded-For"]).toBe(REDACTED_IP);
    expect(serialized.headers["X-Envoy-External-Address"]).toBe(REDACTED_IP);
    expect(serialized.headers["X-Real-Remote-Address"]).toBe(REDACTED_IP);
    // sourceIp matches at any depth (structural observed field name).
    expect(serialized.requestContext.http.sourceIp).toBe(REDACTED_IP);
  });

  it("keeps correlation identifiers inside headers verbatim", () => {
    // Deliberate policy decision: request/trace identifiers are classified
    // low-sensitivity (DATA-ANALYSE.md section H) and observability depends
    // on them (AGENTS.md section 33).
    const identifiers = {
      "X-Request-Id": "6b0d3556-e0bb-4067-a9fc-137dda39f5ae",
      "X-Trace-Id": "edb96f8c-f86f-4149-ab7e-8c30b7bafb67",
      "Uber-Trace-Id": "195befaa12da73b5:59ea0be13cb39c87:41d0f3eae511878e:1",
      Traceparent: "00-195befaa12da73b5-51fd8f610489319b-01",
    };

    expect(safeDiagnostics({ headers: { ...identifiers } })).toEqual({
      headers: identifiers,
    });
  });

  it("applies the header policy recursively to nested diagnostic structures", () => {
    const serialized = safeDiagnostics({
      wrapper: {
        _data: {
          headers: { Authorization: "Bearer sentinel-auth-value" },
        },
      },
    }) as Record<string, unknown>;

    const innerHeaders = (
      ((serialized["wrapper"] as Record<string, unknown>)["_data"] as Record<string, unknown>)[
        "headers"
      ] as Record<string, string>
    )["Authorization"];
    expect(innerHeaders).toBe(REDACTED_AUTHORIZATION);
  });
});

describe("safeDiagnostics: raw boundary preservation", () => {
  it("never mutates the serialized raw event and context", () => {
    const rawEvent = {
      version: "2.0",
      rawPath: "/probe/ping",
      rawQueryString: "",
      headers: {
        Authorization: "Bearer sentinel-auth-value",
        "X-Request-Id": "keep-me",
      },
      requestContext: { http: { method: "GET", sourceIp: "203.0.113.10" } },
      body: "sentinel-request-body",
      isBase64Encoded: false,
    };
    const rawContext = { ...OBSERVED_CONTEXT };
    const snapshotEvent = structuredClone(rawEvent);
    const snapshotContext = structuredClone(rawContext);

    safeDiagnostics(rawEvent);
    safeDiagnostics(rawContext);

    expect(rawEvent).toEqual(snapshotEvent);
    expect(rawContext).toEqual(snapshotContext);
  });

  it("produces fresh copies while raw references stay identity-preserving", () => {
    const rawEvent = {
      version: "2.0",
      rawPath: "/x",
      rawQueryString: "",
      headers: {},
      requestContext: {},
      body: "",
      isBase64Encoded: false,
    };
    const context = buildYandexExecutionContext(rawEvent, { ...OBSERVED_CONTEXT });

    const serialized = safeDiagnostics(context) as Record<string, unknown>;

    // Output structures are newly built, never aliased onto the input...
    expect(serialized).not.toBe(context);
    expect(serialized["rawEvent"]).toBeUndefined();
    expect(serialized["raw"]).toBeUndefined();
    // ...and the escape hatches keep the exact references untouched.
    expect(context.rawEvent).toBe(rawEvent);
  });

  it("omits the raw/rawEvent escape hatches entirely from safe output", () => {
    // Raw payloads carry credentials and client data; they enter diagnostics
    // only when passed deliberately as THE value being serialized.
    const sensitiveRaw = { headers: { Authorization: "Bearer sentinel-auth-value" } };
    const carrier = { name: "invocation", raw: sensitiveRaw, rawEvent: sensitiveRaw };

    const rendered = JSON.stringify(safeDiagnostics(carrier));

    expect(rendered).toBe('{"name":"invocation"}');
    expect(rendered).not.toContain("sentinel-auth-value");
  });

  it("serializes a raw API Gateway v2 event safely including its _data mirror path", () => {
    // Passing the RAW CONTEXT itself is supported: root token redacted, the
    // duplicated event mirror under _data goes through the same policy.
    const rawEvent = {
      version: "2.0",
      rawPath: "/probe/ping",
      rawQueryString: "",
      headers: { Authorization: "Bearer sentinel-auth-value", Accept: "*/*" },
      queryStringParameters: {},
      requestContext: {
        http: { method: "GET", path: "/probe/ping", sourceIp: "203.0.113.10" },
      },
      body: "sentinel-form-password",
      isBase64Encoded: true,
      pathParameters: {},
      parameters: {},
      multiValueParameters: {},
      operationId: "a".repeat(64),
    };
    const rawContext = { ...OBSERVED_CONTEXT, _data: rawEvent };

    const serializedJson = JSON.stringify(safeDiagnostics(rawContext));

    expect(serializedJson).not.toContain("sentinel-iam-secret-value");
    expect(serializedJson).not.toContain("sentinel-auth-value");
    expect(serializedJson).not.toContain("203.0.113.");
    // The recognized raw-event fingerprint drops the body instead of dumping it.
    expect(serializedJson).not.toContain("sentinel-form-password");
    expect(serializedJson).toContain("/probe/ping");
    expect(serializedJson).toContain("*/*");
  });

  it("drops the body of a raw Message Queue wire message without touching siblings", () => {
    const wireMessage = {
      message_id: "b237b8ea-56142e72-6eeac5af-d4878d7a",
      md5_of_body: "5d41402abc4b2a76b9719d911017c592",
      body: "sentinel-queue-body",
      attributes: { SentTimestamp: "1787348674266" },
      message_attributes: {},
      md5_of_message_attributes: "",
    };

    const serialized = safeDiagnostics(wireMessage) as Record<string, unknown>;

    expect(serialized["body"]).toBeUndefined();
    expect(serialized["message_id"]).toBe("b237b8ea-56142e72-6eeac5af-d4878d7a");
    expect(serialized["md5_of_body"]).toBe("5d41402abc4b2a76b9719d911017c592");
    expect(serialized["attributes"]).toEqual({ SentTimestamp: "1787348674266" });
  });
});

describe("safeDiagnostics: fingerprint collision boundaries", () => {
  /**
   * Regression suite for the false-positive audit: every structural
   * fingerprint must require its COMPLETE observed field set, so ordinary
   * application objects owning plausible subsets keep every property —
   * including bodies, tokens and payloads — exactly as written.
   */

  it("keeps a seven-of-eight domain lookalike intact (no queue-message match)", () => {
    // All plausible camelCase names EXCEPT queueId: must not be mistaken for
    // a normalized queue message, or its body would be destroyed.
    const domainRecord = {
      messageId: "domain-generated-id",
      md5OfBody: "not-a-real-checksum",
      body: "sentinel-domain-body",
      attributes: { priority: "high" },
      messageAttributes: { trace: { dataType: "String", stringValue: "t" } },
      md5OfMessageAttributes: "domain-side-hash",
      eventMetadata: { origin: "outbox" },
    };

    const serializedJson = JSON.stringify(safeDiagnostics(domainRecord));

    expect(safeDiagnostics(domainRecord)).toEqual(domainRecord);
    expect(serializedJson).toContain("sentinel-domain-body");
  });

  it("keeps an eight-of-eight lookalike with a data payload property intact", () => {
    // The deciding discriminator for genuine messages is the lazy `payload`
    // accessor; a plain data property marks an application object.
    const outboxRecord = {
      messageId: "m-1",
      md5OfBody: "h",
      body: "sentinel-outbox-body",
      attributes: {},
      messageAttributes: {},
      md5OfMessageAttributes: "",
      queueId: "q-1",
      eventMetadata: {},
      payload: { already: "materialized" },
    };

    expect(safeDiagnostics(outboxRecord)).toEqual(outboxRecord);
  });

  it("keeps a partial HTTP-event lookalike intact", () => {
    // version/rawPath/headers/requestContext/body alone do NOT make an API
    // Gateway v2 event: the fingerprint requires the complete validator set.
    const legacyConfig = {
      version: "2.0",
      rawPath: "/legacy/import",
      rawQueryString: "",
      headers: { Accept: "application/json" },
      requestContext: { requestId: "cfg-1" },
      body: "sentinel-config-body",
      operationId: "cfg-operation",
    };

    expect(safeDiagnostics(legacyConfig)).toEqual(legacyConfig);
  });

  it("keeps a partial MQ wire lookalike intact", () => {
    // Two snake_case names alone no longer suppress the body: recognition
    // demands the complete observed wire shape.
    const delivery = {
      message_id: "domain-id-1",
      md5_of_body: "domain-hash",
      body: "sentinel-delivery-body",
    };

    expect(safeDiagnostics(delivery)).toEqual(delivery);
  });

  it("keeps nested application payloads mixing runtime-like names intact", () => {
    const applicationPayload = {
      shipment: {
        messageId: "ship-1",
        body: { weightKg: 12 },
        token: "shipment-domain-token",
        queueId: "warehouse-eu",
      },
      telemetry: { awsRequestId: "telemetry-1", functionName: "worker" },
      note: "version 2.0 migration with rawPath /v2",
    };

    expect(safeDiagnostics(applicationPayload)).toEqual(applicationPayload);
  });

  it("does not redact a context lookalike that misses mandatory identity fields", () => {
    // awsRequestId + functionName + token alone are no longer enough: both
    // remaining identity fields are mandatory on real contexts.
    const lookalike = {
      wrapper: {
        awsRequestId: "req-1",
        functionName: "business-worker",
        token: "sentinel-telemetry-token",
      },
    };

    expect(safeDiagnostics(lookalike)).toEqual(lookalike);
  });

  it("still redacts genuinely context-shaped nodes under diagnostic wrappers", () => {
    const wrapper = {
      message: "invocation handled",
      ctx: { ...OBSERVED_CONTEXT },
    };

    const serialized = safeDiagnostics(wrapper) as { ctx: Record<string, unknown> };
    expect(serialized.ctx["token"]).toBe(REDACTED_TOKEN);
    expect(serialized.ctx["awsRequestId"]).toBe("f18fed85-7096-4f0e-a6db-e2c5e37e925f");
  });
});

describe("safeDiagnostics: scoped suppression of duplication channels", () => {
  it("renders raw wire message attributes as names plus declared data types only", () => {
    // User message attribute values are free-form application strings and
    // may carry secrets; the declared type is structural, observed metadata.
    const wireMessage = {
      message_id: "b237b8ea-56142e72-6eeac5af-d4878d7a",
      md5_of_body: "5d41402abc4b2a76b9719d911017c592",
      body: "{}",
      attributes: {},
      message_attributes: {
        Scenario: { data_type: "String", string_value: "sentinel-scenario-secret" },
        Attempt: { data_type: "Number", string_value: "1" },
      },
      md5_of_message_attributes: "9a0364b9e99bb480dd25e1f0284c8555",
    };

    const serializedJson = JSON.stringify(safeDiagnostics(wireMessage));

    expect(serializedJson).not.toContain("sentinel-scenario-secret");
    expect(serializedJson).not.toContain("string_value");
    const serialized = JSON.parse(serializedJson) as {
      message_attributes: Record<string, { dataType: string }>;
    };
    expect(serialized.message_attributes).toEqual({
      Scenario: { dataType: "String" },
      Attempt: { dataType: "Number" },
    });
  });

  it("placeholders credential-named entries inside gateway parameter maps", () => {
    // Observed (DATA-ANALYSE.md anomaly 10): gateway-declared cookies and
    // headers are duplicated into the parameter maps under their declared
    // names — on raw events and normalized requests alike — so cookie- or
    // authorization-named entries must not ride through diagnostics either.
    // Non-sensitive declarations stay verbatim; multi-value entries keep
    // their array representation with per-element placeholders;
    // rawQueryString remains untouched by design.
    const diagnostic = {
      parameters: {
        ID: "probe/ping",
        "X-Test-Header": "header-value",
        test_cookie: "sentinel-parameter-cookie",
        Authorization: "sentinel-parameter-auth",
      },
      multiValueParameters: {
        session_cookie: ["sentinel-multi-cookie"],
        page: ["2"],
      },
      queryStringParameters: { COOKIE_CONSENT: REDACTED_COOKIE, page: "2" },
    };

    expect(safeDiagnostics(diagnostic)).toEqual({
      parameters: {
        ID: "probe/ping",
        "X-Test-Header": "header-value",
        test_cookie: REDACTED_COOKIE,
        Authorization: REDACTED_AUTHORIZATION,
      },
      multiValueParameters: {
        session_cookie: [REDACTED_COOKIE],
        page: ["2"],
      },
      // Matching is name-based and deliberately broad ("cookie" substring):
      // over-redaction of a consent flag is acceptable, leaking a session
      // cookie is not.
      queryStringParameters: { COOKIE_CONSENT: REDACTED_COOKIE, page: "2" },
    });
  });

  it("leaves ordinary business fields named body or token outside wire scopes intact", () => {
    const business = { comment: { body: "text" }, auth: { token: "domain-token" } };
    expect(safeDiagnostics(business)).toEqual(business);
  });
});

describe("safeDiagnostics: queue models keep payloads out of generic diagnostics", () => {
  const deserializerCalls: string[] = [];
  const countingDeserializer: QueueBodyDeserializer = (body) => {
    deserializerCalls.push(body);
    return { decoded: true };
  };

  function buildBatch(): QueueBatch {
    const event: RawQueueEvent = {
      messages: [
        {
          event_metadata: {
            event_id: "b237b8ea-56142e72-6eeac5af-d4878d7a",
            event_type: "yandex.cloud.events.serverless.triggers.MessageQueueMessage",
            created_at: "2026-08-21T21:44:47Z",
            tracing_context: null,
            cloud_id: "b1g9kusggl9k4bmurq6s",
            folder_id: "b1g9kusggl9k4bmurq6s",
          },
          details: {
            queue_id: "yrn:yc:ymq:ru-central1:b1g9kusggl9k4bmurq6s:f-test",
            message: {
              message_id: "b237b8ea-56142e72-6eeac5af-d4878d7a",
              md5_of_body: "5d41402abc4b2a76b9719d911017c592",
              body: '{"secret":"hunter2"}',
              attributes: { SentTimestamp: "1787348674266" },
              message_attributes: {
                Attempt: { data_type: "Number", string_value: "1" },
              },
              md5_of_message_attributes: "9a0364b9e99bb480dd25e1f0284c8555",
            },
          },
        },
      ],
    };
    return normalizeQueueBatch(event, countingDeserializer);
  }

  it("emits identity, metadata and attribute NAMES but never bodies or payloads", () => {
    const batch = buildBatch();
    const callsBeforeSerialization = deserializerCalls.length;

    const serialized = safeDiagnostics(batch) as {
      messages: Array<Record<string, unknown>>;
    };

    // Traversal evaluated no lazy payload getter.
    expect(deserializerCalls.length).toBe(callsBeforeSerialization);
    const message = serialized.messages[0]!;
    expect(message["messageId"]).toBe("b237b8ea-56142e72-6eeac5af-d4878d7a");
    expect(message["queueId"]).toBe("yrn:yc:ymq:ru-central1:b1g9kusggl9k4bmurq6s:f-test");
    expect(message["attributes"]).toEqual({ SentTimestamp: "1787348674266" });
    expect(message["messageAttributeNames"]).toEqual(["Attempt"]);
    expect(message).not.toHaveProperty("body");
    expect(message).not.toHaveProperty("payload");

    const rendered = JSON.stringify(serialized);
    expect(rendered).not.toContain("hunter2");
    // Attribute string values may carry secrets too; only names surface.
    expect(rendered).not.toContain('"stringValue"');
  });

  it("flags lazy getters instead of evaluating them during traversal", () => {
    let getterRuns = 0;
    const probe = {
      messageId: "m",
      get explosive(): string {
        getterRuns++;
        return "sentinel-lazy-value";
      },
    };

    const serialized = safeDiagnostics(probe) as Record<string, unknown>;

    expect(getterRuns).toBe(0);
    expect(serialized["explosive"]).toBe("[unevaluated getter]");
    expect(serialized["messageId"]).toBe("m");
  });
});

describe("safeDiagnostics: error rendering", () => {
  it("exposes stable boundary identifiers without message text", () => {
    const error = ConnectorError.invalidInvocationEvent("http", 'field "body" is required');

    const serialized = safeDiagnostics({ failure: error }) as {
      failure: { name: string; code: string; transportId: string };
    };

    expect(serialized.failure).toEqual({
      name: "ConnectorError",
      code: "INVALID_INVOCATION_EVENT",
      transportId: "http",
    });
    const rendered = JSON.stringify(serialized);
    expect(rendered).not.toContain('field "body" is required');
    expect(rendered).not.toContain("claimed the invocation event");
  });

  it("never leaks message, stack or cause chains of arbitrary errors", () => {
    const cause = new Error("sentinel-cause-message");
    const error = new Error("sentinel-application-message quoting cookie=secret", { cause });

    const rendered = JSON.stringify(safeDiagnostics({ failure: error }));

    expect(rendered).not.toContain("sentinel-application-message");
    expect(rendered).not.toContain("sentinel-cause-message");
    expect(rendered).not.toContain("cookie=secret");
    expect(rendered).not.toContain('"stack"');
    expect(rendered).toContain('"name":"Error"');
  });

  it("renders thrown non-error values without stringifying them into structures", () => {
    // A thrown plain value is not an Error instance: traversal treats it as
    // ordinary data. Pinning the behavior so it stays a deliberate choice.
    expect(safeDiagnostics({ failure: 42 })).toEqual({ failure: 42 });
  });
});

describe("safeDiagnostics: documented scope limits", () => {
  it("leaves legitimate application fields named like sensitive ones intact", () => {
    const businessPayload = {
      authorization: "internal-flow-marker",
      comment: { body: "plain text body of a comment" },
      auth: { token: "oauth-domain-token", refreshToken: "r" },
      query: "?access_token=kept-as-written",
    };

    expect(safeDiagnostics(businessPayload)).toEqual(businessPayload);
  });

  it("treats every property named headers as a header map, at any depth", () => {
    // Pinned so any future narrowing of this scope is a deliberate decision.
    const serialized = safeDiagnostics({
      response: { headers: { authorization: "Bearer x" } },
    }) as Record<string, unknown>;
    expect(
      ((serialized["response"] as Record<string, unknown>)["headers"] as Record<string, string>)[
        "authorization"
      ],
    ).toBe(REDACTED_AUTHORIZATION);
  });
});

describe("safeDiagnostics: deterministic JSON-safe traversal", () => {
  it("is deterministic for identical inputs", () => {
    const input = { b: 1, a: { c: [true, null, "x"] }, headers: { Cookie: "session=1" } };
    expect(safeDiagnostics(input)).toEqual(safeDiagnostics(input));
  });

  it("terminates cycles while preserving shared diamond references", () => {
    const cyclic: Record<string, unknown> = { name: "root" };
    cyclic["self"] = cyclic;

    const serialized = safeDiagnostics(cyclic) as Record<string, unknown>;
    expect(serialized["name"]).toBe("root");
    expect(serialized["self"]).toBe("[circular]");

    const shared = { value: 1 };
    const diamond = { first: shared, second: shared };
    // Shared (non-cyclic) references are re-emitted, not flagged circular.
    expect(safeDiagnostics(diamond)).toEqual({
      first: { value: 1 },
      second: { value: 1 },
    });
  });

  it("keeps output stable under JSON.stringify for exotic values", () => {
    const exotic = {
      when: new Date("2026-08-22T00:00:00.000Z"),
      bytes: new Uint8Array([1, 2, 3]),
      big: 42n,
      fn: () => "dropped",
      symbolValue: Symbol("dropped"),
      missing: undefined,
    };

    const serialized = safeDiagnostics(exotic) as Record<string, unknown>;
    expect(serialized["when"]).toBe("2026-08-22T00:00:00.000Z");
    expect(serialized["bytes"]).toBe("[binary value: 3 bytes]");
    expect(serialized["big"]).toBe("42");
    // Function/symbol/undefined-valued properties are dropped entirely.
    expect(Object.keys(serialized)).toEqual(["when", "bytes", "big"]);
    expect(() => JSON.stringify(serialized)).not.toThrow();
  });

  it("passes primitives through unchanged", () => {
    expect(safeDiagnostics("text")).toBe("text");
    expect(safeDiagnostics(7)).toBe(7);
    expect(safeDiagnostics(false)).toBe(false);
    expect(safeDiagnostics(null)).toBe(null);
  });
});

describe("safeDiagnostics: integration with YandexExecutionContext.toJSON()", () => {
  it("agrees with the context serialization guard on the IAM token placeholder", () => {
    const context = buildYandexExecutionContext(
      { version: "2.0", headers: {} },
      { ...OBSERVED_CONTEXT },
    );

    // Both paths source REDACTED_TOKEN from the single policy module (#13).
    expect(context.toJSON()["token"]).toBe(REDACTED_TOKEN);
    expect((safeDiagnostics(context) as Record<string, unknown>)["token"]).toBe(REDACTED_TOKEN);

    // Both representations exclude raw payloads; safeDiagnostics additionally
    // skips the toJSON function itself instead of invoking caller code, so
    // its field set matches toJSON's deliberate shape exactly.
    const serializedKeys = Object.keys(safeDiagnostics(context) as Record<string, unknown>).sort();
    expect(serializedKeys).toEqual(
      [
        "awsRequestId",
        "functionName",
        "functionVersion",
        "functionFolderId",
        "memoryLimitInMB",
        "deadlineMs",
        "logGroupName",
        "uberTraceId",
        "token",
      ].sort(),
    );
  });
});

describe("safeDiagnostics across warm invocations", () => {
  const CAPTURED_DIAGNOSTICS: string[] = [];

  class WarmIsolationController {
    capture(): { statusCode: number } {
      // Resolved inside the invocation scope, serialized immediately: what
      // lands in the array is exactly what a real diagnostic log line
      // would contain for this invocation.
      const context = resolveInvocationExecutionContext();
      const request = resolveInvocationHttpRequest();
      CAPTURED_DIAGNOSTICS.push(
        JSON.stringify(safeDiagnostics({ requestId: request.requestId, context })),
      );
      return { statusCode: 200 };
    }
  }

  All("*")(
    WarmIsolationController.prototype,
    "capture",
    Object.getOwnPropertyDescriptor(WarmIsolationController.prototype, "capture")!,
  );
  Controller()(WarmIsolationController);

  class WarmIsolationModule {}

  Module({ controllers: [WarmIsolationController] })(WarmIsolationModule);

  it("carries only the current invocation's data on a reused handler", async () => {
    const handler = createYandexHandler(WarmIsolationModule);

    // Full observed-shape contract (validateHttpApiGatewayV2Event), minimal
    // values — the redaction behavior is what matters here.
    const firstEvent = {
      version: "2.0",
      rawPath: "/warm/first",
      rawQueryString: "",
      headers: {},
      queryStringParameters: {},
      requestContext: {
        authorizer: {},
        http: { method: "GET", path: "/warm/first", sourceIp: "203.0.113.10", userAgent: "jest" },
        requestId: "first-invocation-request-id",
        time: "21/Aug/2026:21:44:47 +0000",
        timeEpoch: 1787348687,
      },
      body: "",
      isBase64Encoded: false,
      pathParameters: {},
      parameters: {},
      multiValueParameters: {},
      operationId: "a".repeat(64),
    };
    const firstContext = {
      ...OBSERVED_CONTEXT,
      awsRequestId: "first-invocation-request-id",
    };
    const secondContext = {
      ...OBSERVED_CONTEXT,
      awsRequestId: "second-invocation-request-id",
    };

    try {
      await handler(firstEvent, firstContext);
      const secondEvent = {
        ...firstEvent,
        rawPath: "/warm/second",
        requestContext: {
          ...firstEvent.requestContext,
          requestId: "second-invocation-request-id",
          http: { ...firstEvent.requestContext.http, path: "/warm/second" },
        },
      };
      await handler(secondEvent, secondContext);
    } finally {
      await handler.close();
    }

    expect(CAPTURED_DIAGNOSTICS).toHaveLength(2);
    const [firstLine, secondLine] = CAPTURED_DIAGNOSTICS.map(
      (line) => JSON.parse(line) as { requestId: string; context: { token: string } },
    );

    // Each warm invocation's diagnostics reflect only its own request id...
    expect(firstLine!.requestId).toBe("first-invocation-request-id");
    expect(secondLine!.requestId).toBe("second-invocation-request-id");
    // ...and the redaction policy held on both.
    expect(firstLine!.context.token).toBe(REDACTED_TOKEN);
    expect(secondLine!.context.token).toBe(REDACTED_TOKEN);
    expect(CAPTURED_DIAGNOSTICS[1]).not.toContain("first-invocation-request-id");
  });
});
