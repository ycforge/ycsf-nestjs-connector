import { NestFactory } from "@nestjs/core";
import {
  REDACTED_AUTHORIZATION,
  REDACTED_COOKIE,
  REDACTED_IP,
  REDACTED_TOKEN,
} from "../core/safe-diagnostics";
import {
  createYandexHandler,
  safeDiagnostics,
  type ClosableYandexCloudFunctionHandler,
} from "../index";
import {
  CombinedTransportAppModule,
  auditHandlerRounds,
  capturedHttpContexts,
  makeHttpEvent,
  makeQueueDelivery,
  makeRuntimeContext,
  resetLifecycleObservations,
  type QueueRoundObservation,
} from "./e2e-test-apps";

/**
 * Mixed-transport end-to-end coverage (issue #14): HTTP/API Gateway and
 * Message Queue invocations are served by ONE `createYandexHandler()` over
 * ONE warm NestJS application, exactly as a deployed function experiences
 * both trigger types. Proves transport detection stays correct per event,
 * invocation data never crosses transports, and the public diagnostics
 * boundary (`safeDiagnostics`) redacts live artifacts from both transports.
 */

const AUTHORIZATION_SECRET = "Bearer iam-live-authorization-secret";
const COOKIE_SECRET = "session=live-cookie-secret";
const CONTEXT_TOKEN_SECRET = "iam-live-context-token";
const BODY_SECRET = "http-body-secret-payload";
const MQ_BODY_SECRET = "mq-body-secret-value";
const MQ_ATTRIBUTE_VALUE_SECRET = "mq-attribute-string-secret";

describe("mixed HTTP and Message Queue traffic over one connector runtime", () => {
  let runtime: ClosableYandexCloudFunctionHandler;
  let createSpy: jest.SpyInstance;

  beforeEach(() => {
    resetLifecycleObservations();
    createSpy = jest.spyOn(NestFactory, "create");
    runtime = createYandexHandler(CombinedTransportAppModule);
  });

  afterEach(async () => {
    createSpy.mockRestore();
    await runtime.close();
  });

  it("routes interleaved HTTP and queue invocations through one shared warm bootstrap", async () => {
    // Interleaving the transports proves per-event detection and that no
    // invocation state leaks across transport boundaries.
    const httpOne = (await runtime(
      makeHttpEvent({ path: "/lifecycle/context" }),
      makeRuntimeContext("mix-http-1"),
    )) as Record<string, unknown>;

    const queueDelivery = makeQueueDelivery(
      { messageId: "mix-m-1", body: '{"step":1}' },
      { messageId: "mix-m-2", body: '{"step":2}' },
    );
    const queueResult = (await runtime(queueDelivery, makeRuntimeContext("mix-mq-1"))) as {
      messages: { messageId?: string }[];
    };

    const httpTwo = (await runtime(
      makeHttpEvent({
        method: "POST",
        path: "/lifecycle/echo",
        rawQueryString: "n=9",
        jsonBody: { message: BODY_SECRET },
        headers: { "X-Request-Marker": "marker-mix" },
      }),
      makeRuntimeContext("mix-http-2"),
    )) as Record<string, unknown>;

    const queueResultTwo = (await runtime(
      makeQueueDelivery({ messageId: "mix-m-3", body: '{"step":3}' }),
      makeRuntimeContext("mix-mq-2"),
    )) as { messages: { messageId?: string }[] };

    // One cold start served all four invocations of both transports.
    expect(createSpy).toHaveBeenCalledTimes(1);

    expect(JSON.parse(httpOne.body as string)).toMatchObject({ awsRequestId: "mix-http-1" });
    expect(queueResult.messages.map((message) => message.messageId)).toEqual([
      "mix-m-1",
      "mix-m-2",
    ]);
    expect(JSON.parse(httpTwo.body as string)).toEqual({
      via: "interceptor",
      payload: { received: { message: BODY_SECRET }, n: 9, awsRequestId: "mix-http-2" },
    });
    expect(queueResultTwo.messages.map((message) => message.messageId)).toEqual(["mix-m-3"]);

    // Queue handlers only ever saw their own delivery's messages and
    // request ids; the HTTP context-probe route observed strictly its own
    // single invocation.
    const seenMessageIds = [...auditHandlerRounds].map((round) => round.messageId);
    expect(seenMessageIds).toEqual(["mix-m-1", "mix-m-2", "mix-m-3"]);
    expect(new Set(auditHandlerRounds.map((round) => round.awsRequestId))).toEqual(
      new Set(["mix-mq-1", "mix-mq-2"]),
    );
    expect(capturedHttpContexts.map((context) => context.awsRequestId)).toEqual(["mix-http-1"]);
  });

  it("redacts live artifacts from both transports in safeDiagnostics output", async () => {
    // HTTP side: credentials on the wire, client IP, IAM token in context,
    // and a secret-bearing request body on the raw gateway event.
    await runtime(
      makeHttpEvent({
        method: "POST",
        path: "/lifecycle/context",
        jsonBody: { message: BODY_SECRET },
        headers: {
          Authorization: AUTHORIZATION_SECRET,
          Cookie: COOKIE_SECRET,
          "X-Forwarded-For": "198.51.100.7",
        },
      }),
      makeRuntimeContext("diag-http-1", { token: CONTEXT_TOKEN_SECRET }),
    );

    // MQ side: secret-bearing body AND user message attribute values.
    await runtime(
      makeQueueDelivery({
        messageId: "diag-m-1",
        body: JSON.stringify({ card: MQ_BODY_SECRET }),
        messageAttributes: {
          TraceSecret: { data_type: "String", string_value: MQ_ATTRIBUTE_VALUE_SECRET },
        },
      }),
      makeRuntimeContext("diag-mq-1", { token: CONTEXT_TOKEN_SECRET }),
    );

    const httpContext = capturedHttpContexts[0];
    const mqRound: QueueRoundObservation | undefined = auditHandlerRounds[0];
    if (!httpContext || !mqRound?.messageReference) {
      throw new Error("expected one HTTP context and one queue round to diagnose");
    }

    // A realistic diagnostic wrapper: nested runtime context (fingerprint
    // path), explicitly extracted raw escape hatches (never followed under
    // their own names), plus normalized models from each transport.
    const diagnosticBundle = {
      label: "e2e-mixed-artifacts",
      ctx: httpContext,
      gatewayEvent: httpContext.rawEvent,
      queueMessage: mqRound.messageReference,
      queueWireMessage: mqRound.messageReference.raw,
    };
    const serialized = JSON.stringify(safeDiagnostics(diagnosticBundle));

    // No secret survives serialization — from either transport.
    for (const secret of [
      CONTEXT_TOKEN_SECRET,
      AUTHORIZATION_SECRET,
      COOKIE_SECRET,
      BODY_SECRET,
      MQ_BODY_SECRET,
      MQ_ATTRIBUTE_VALUE_SECRET,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // The observed fixture client IP is redacted at any depth.
    expect(serialized).not.toContain("203.0.113.10");

    // Every documented placeholder is present.
    expect(serialized).toContain(REDACTED_TOKEN);
    expect(serialized).toContain(REDACTED_AUTHORIZATION);
    expect(serialized).toContain(REDACTED_COOKIE);
    expect(serialized).toContain(REDACTED_IP);

    // The queue message renders identity + attribute NAMES only.
    expect(serialized).toContain('"messageId":"diag-m-1"');
    expect(serialized).toContain('"messageAttributeNames":["TraceSecret"]');

    // Raw user attributes reduce to name -> declared data type.
    expect(serialized).toContain('"TraceSecret":{"dataType":"String"}');

    // Diagnostics are non-mutating: the live artifacts keep their secrets
    // for explicit property access.
    expect(
      (httpContext.rawEvent as { headers?: Record<string, string> }).headers?.Authorization,
    ).toBe(AUTHORIZATION_SECRET);
    expect(mqRound.messageReference!.body).toBe(JSON.stringify({ card: MQ_BODY_SECRET }));
  });

  it("keeps concurrent cross-transport invocations isolated", async () => {
    const [httpResult, queueResult] = (await Promise.all([
      runtime(makeHttpEvent({ path: "/lifecycle/context" }), makeRuntimeContext("cc-mix-http")),
      runtime(
        makeQueueDelivery({ messageId: "cc-mix-m-1", body: '{"side":"mq"}' }),
        makeRuntimeContext("cc-mix-mq"),
      ),
    ])) as [Record<string, unknown>, { messages: { messageId?: string }[] }];

    // Each transport answered with exactly its own invocation's data.
    expect(JSON.parse(httpResult.body as string)).toMatchObject({
      awsRequestId: "cc-mix-http",
    });
    expect(queueResult.messages.map((message) => message.messageId)).toEqual(["cc-mix-m-1"]);
    expect(auditHandlerRounds[0]?.awsRequestId).toBe("cc-mix-mq");
    expect(capturedHttpContexts[0]?.awsRequestId).toBe("cc-mix-http");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
