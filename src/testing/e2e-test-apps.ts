import {
  BadRequestException,
  Body,
  CanActivate,
  Catch,
  Controller,
  ExecutionContext,
  ExceptionFilter,
  Get,
  Headers,
  Inject,
  Injectable,
  Module,
  NestInterceptor,
  Param,
  ParseIntPipe,
  Post,
  Query,
  RequestMethod,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
  type ArgumentsHost,
  type CallHandler,
  type MiddlewareConsumer,
  type Type,
} from "@nestjs/common";
import { map, type Observable } from "rxjs";
import { YandexContext } from "../context/yandex-context.decorator";
import type { YandexExecutionContext } from "../context/yandex-execution-context";
import type { NormalizedHttpRequest } from "../http/normalized-request";
import type { QueueMessage } from "../mq/message";
import type { RawQueueEvent, RawQueueMessageEvent } from "../mq/raw-event";
import { QueueHandler } from "../mq/queue-handler.decorator";
// Merged export: the decorator factory plus the normalized message type it injects.
import { QueueMessage as QueueMessageDecorator } from "../mq/queue-message.decorator";
import type { RawHttpApiGatewayV2Event } from "../http/raw-event";

/**
 * Purpose-built NestJS applications for the end-to-end lifecycle suites
 * (issue #14, test infrastructure — NOT part of the published package;
 * `src/testing` is excluded from the build).
 *
 * Every app here is a real NestJS module exercised exclusively through the
 * public `createYandexHandler()` runtime with Yandex-shaped events: no fake
 * framework implementations, no internal adapter shortcuts. Decorators are
 * applied imperatively (exactly what legacy decorator desugaring does) and
 * dependencies are declared through explicit `@Inject` positions because
 * this repository compiles without `emitDecoratorMetadata`, mirroring the
 * established spec conventions.
 *
 * Observation statics record what user code saw per invocation. They hold
 * synthetic fixture data only; assertions read them to prove per-invocation
 * isolation, never to carry state between tests.
 */

// ---------------------------------------------------------------------------
// Shared observation state (reset by each suite's beforeEach).
// ---------------------------------------------------------------------------

/** What the echo pipeline observed for one request, in execution order. */
export interface EchoStageObservation {
  readonly middlewareSawBody?: unknown;
  readonly guardSawMarker?: string;
}

export const echoStageObservations: EchoStageObservation[] = [];

/** Execution contexts captured by HTTP controllers through @YandexContext(). */
export const capturedHttpContexts: YandexExecutionContext[] = [];

/** One recorded round of one queue handler. */
export interface QueueRoundObservation {
  readonly handler: "audit" | "mirror";
  readonly messageId?: string;
  readonly awsRequestId?: string;
  /** Instance id of the REQUEST-scoped MessageClockService seen this round. */
  readonly clockInstanceId?: number;
  /** Instance id of the DEFAULT-scoped WarmSingletonService seen this round. */
  readonly singletonInstanceId?: number;
  /** Decoded payload reference when the handler read `message.payload`. */
  readonly payloadReference?: unknown;
  /** The exact normalized message instance handed to the handler. */
  readonly messageReference?: QueueMessage;
}

export const auditHandlerRounds: QueueRoundObservation[] = [];
export const mirrorHandlerRounds: QueueRoundObservation[] = [];

/** Rounds of the consumer that deliberately never reads `message.payload`. */
export const payloadAgnosticRounds: { messageId?: string; awsRequestId?: string }[] = [];

/** Resets every observation static. */
export function resetLifecycleObservations(): void {
  echoStageObservations.length = 0;
  capturedHttpContexts.length = 0;
  auditHandlerRounds.length = 0;
  mirrorHandlerRounds.length = 0;
  payloadAgnosticRounds.length = 0;
}

// ---------------------------------------------------------------------------
// Providers shared by the E2E apps.
// ---------------------------------------------------------------------------

let clockInstanceCounter = 0;
let singletonInstanceCounter = 0;

/**
 * REQUEST-scoped: one instance per message DI sub-tree. Cross-provider
 * equality within one message proves the shared sub-tree; inequality across
 * messages proves per-message freshness (issue #8 semantics).
 */
@Injectable({ scope: Scope.REQUEST })
class MessageClockService {
  readonly instanceId = ++clockInstanceCounter;
}

/** DEFAULT-scoped: stays the same instance until the application is released. */
@Injectable()
class WarmSingletonService {
  readonly instanceId = ++singletonInstanceCounter;
}

export function lastSingletonInstanceId(): number {
  return singletonInstanceCounter;
}

// ---------------------------------------------------------------------------
// HTTP full-stack application: middleware -> parser -> guard -> interceptor
// -> pipe -> controller (@Param/@Query/@Headers/@Body/@YandexContext), plus
// exception-filter, HttpException and unexpected-failure routes.
// ---------------------------------------------------------------------------

const UNEXPECTED_FAILURE_MARKER = "invocation-secret-e2e-marker";

/** Marker text of the deliberate unexpected failure; must never reach a response. */
export const UNEXPECTED_FAILURE_TEXT = UNEXPECTED_FAILURE_MARKER;

class MarkerGuard implements CanActivate {
  canActivate(executionContext: ExecutionContext): boolean {
    const request = executionContext.switchToHttp().getRequest<
      NormalizedHttpRequest & {
        headers: Record<string, string>;
      }
    >();
    echoStageObservations.push({
      guardSawMarker: String(request.headers["x-request-marker"] ?? ""),
    });
    return true;
  }
}

class WrappingInterceptor implements NestInterceptor {
  intercept(_executionContext: ExecutionContext, nextHandler: CallHandler): Observable<unknown> {
    return nextHandler.handle().pipe(map((payload) => ({ via: "interceptor", payload })));
  }
}

class StackProbeError extends Error {}

@Catch(StackProbeError)
class StackProbeFilter implements ExceptionFilter {
  catch(_exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status: (statusCode: number) => unknown;
      json: (body: unknown) => unknown;
    }>();
    response.status(418);
    response.json({ handledBy: "stack-probe-filter" });
  }
}

class RecordingMiddleware {
  use(requestFacade: { body?: unknown }, _responseFacade: unknown, next: () => void): void {
    echoStageObservations.push({ middlewareSawBody: requestFacade.body });
    next();
  }
}

class LifecycleController {
  contextProbe(executionContext: YandexExecutionContext): object {
    capturedHttpContexts.push(executionContext);
    return {
      awsRequestId: executionContext.awsRequestId,
      functionName: executionContext.functionName,
      memoryLimitInMB: executionContext.memoryLimitInMB,
    };
  }

  // Separate handler because Nest stores ONE verb per method: this POST
  // variant lets suites capture a context whose raw event carries a real
  // (secret-bearing) request body.
  capturePostedContext(body: unknown, executionContext: YandexExecutionContext): object {
    capturedHttpContexts.push(executionContext);
    return {
      awsRequestId: executionContext.awsRequestId,
      receivedBytes: typeof body === "object" && body !== null ? Object.keys(body).length : null,
    };
  }

  identity(
    name: string,
    markerHeader: string | undefined,
    cookieHeader: string | undefined,
  ): object {
    return { name, marker: markerHeader ?? null, cookie: cookieHeader ?? null };
  }

  echo(body: unknown, parsedN: number, executionContext: YandexExecutionContext): object {
    return {
      received: body,
      n: parsedN,
      awsRequestId: executionContext.awsRequestId,
    };
  }

  filtered(): never {
    throw new StackProbeError(UNEXPECTED_FAILURE_MARKER);
  }

  httpRejection(): never {
    throw new BadRequestException("rejected-by-controller");
  }

  unexpectedFailure(): never {
    throw new Error(UNEXPECTED_FAILURE_MARKER);
  }
}

Controller("lifecycle")(LifecycleController);

function lifecycleDescriptor(name: string): TypedPropertyDescriptor<unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(LifecycleController.prototype, name);
  if (!descriptor) {
    throw new Error(`missing descriptor for LifecycleController.${name}`);
  }
  return descriptor;
}

Get("context")(LifecycleController.prototype, "contextProbe", lifecycleDescriptor("contextProbe"));
YandexContext()(LifecycleController.prototype, "contextProbe", 0);

Post("context")(
  LifecycleController.prototype,
  "capturePostedContext",
  lifecycleDescriptor("capturePostedContext"),
);
Body()(LifecycleController.prototype, "capturePostedContext", 0);
YandexContext()(LifecycleController.prototype, "capturePostedContext", 1);

Get("whoami/:name")(LifecycleController.prototype, "identity", lifecycleDescriptor("identity"));
Param("name")(LifecycleController.prototype, "identity", 0);
Headers("x-request-marker")(LifecycleController.prototype, "identity", 1);
Headers("cookie")(LifecycleController.prototype, "identity", 2);

Post("echo")(LifecycleController.prototype, "echo", lifecycleDescriptor("echo"));
UseGuards(MarkerGuard)(LifecycleController.prototype, "echo", lifecycleDescriptor("echo"));
UseInterceptors(WrappingInterceptor)(
  LifecycleController.prototype,
  "echo",
  lifecycleDescriptor("echo"),
);
Body()(LifecycleController.prototype, "echo", 0);
Query("n", ParseIntPipe)(LifecycleController.prototype, "echo", 1);
YandexContext()(LifecycleController.prototype, "echo", 2);

Get("failures/filtered")(
  LifecycleController.prototype,
  "filtered",
  lifecycleDescriptor("filtered"),
);
UseFilters(StackProbeFilter)(
  LifecycleController.prototype,
  "filtered",
  lifecycleDescriptor("filtered"),
);

Get("failures/http")(
  LifecycleController.prototype,
  "httpRejection",
  lifecycleDescriptor("httpRejection"),
);

Get("failures/unexpected")(
  LifecycleController.prototype,
  "unexpectedFailure",
  lifecycleDescriptor("unexpectedFailure"),
);

class FullStackHttpModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RecordingMiddleware)
      .forRoutes({ path: "lifecycle/echo", method: RequestMethod.POST });
  }
}

Module({ controllers: [LifecycleController] })(FullStackHttpModule);

export const FullStackHttpAppModule: Type<unknown> = FullStackHttpModule;

// ---------------------------------------------------------------------------
// Message Queue fan-out application: two consumers receive every message in
// discovery order under one shared DI sub-tree per message.
//
// Handler methods live ON each consumer class: queue-handler discovery walks
// prototype chains, but registering on an inherited method's descriptor would
// miss the subclass scan level, so each consumer owns and registers its own
// `handle`.
// ---------------------------------------------------------------------------

interface ConsumerDependencies {
  readonly clock: MessageClockService;
  readonly singleton: WarmSingletonService;
}

function recordRound(
  rounds: QueueRoundObservation[],
  handler: "audit" | "mirror",
  dependencies: ConsumerDependencies,
  message: QueueMessage,
  executionContext: YandexExecutionContext,
): void {
  rounds.push({
    handler,
    messageId: message.messageId,
    awsRequestId: executionContext.awsRequestId,
    clockInstanceId: dependencies.clock.instanceId,
    singletonInstanceId: dependencies.singleton.instanceId,
    payloadReference: message.payload,
    messageReference: message,
  });
}

@Injectable()
class AuditConsumer {
  private readonly dependencies: ConsumerDependencies;

  constructor(clock: MessageClockService, singleton: WarmSingletonService) {
    // Compiled without emitDecoratorMetadata: constructor parameters are
    // declared to Nest through explicit self-decorated dependency positions
    // right after the class declaration.
    this.dependencies = { clock, singleton };
  }

  handle(message: QueueMessage, executionContext: YandexExecutionContext): void {
    recordRound(auditHandlerRounds, "audit", this.dependencies, message, executionContext);
  }
}
Inject(MessageClockService)(AuditConsumer, undefined, 0);
Inject(WarmSingletonService)(AuditConsumer, undefined, 1);

const auditHandleDescriptor = Object.getOwnPropertyDescriptor(AuditConsumer.prototype, "handle");
if (!auditHandleDescriptor) {
  throw new Error("missing descriptor for AuditConsumer.handle");
}
QueueHandler()(AuditConsumer.prototype, "handle", auditHandleDescriptor);
QueueMessageDecorator()(AuditConsumer.prototype, "handle", 0);
YandexContext()(AuditConsumer.prototype, "handle", 1);

@Injectable()
class MirrorConsumer {
  private readonly dependencies: ConsumerDependencies;

  constructor(clock: MessageClockService, singleton: WarmSingletonService) {
    this.dependencies = { clock, singleton };
  }

  handle(message: QueueMessage, executionContext: YandexExecutionContext): void {
    recordRound(mirrorHandlerRounds, "mirror", this.dependencies, message, executionContext);
  }
}
Inject(MessageClockService)(MirrorConsumer, undefined, 0);
Inject(WarmSingletonService)(MirrorConsumer, undefined, 1);

const mirrorHandleDescriptor = Object.getOwnPropertyDescriptor(MirrorConsumer.prototype, "handle");
if (!mirrorHandleDescriptor) {
  throw new Error("missing descriptor for MirrorConsumer.handle");
}
QueueHandler()(MirrorConsumer.prototype, "handle", mirrorHandleDescriptor);
QueueMessageDecorator()(MirrorConsumer.prototype, "handle", 0);
YandexContext()(MirrorConsumer.prototype, "handle", 1);

/**
 * Declaration order fixes discovery order (providers walk in declaration
 * order): audit fans out before mirror for every message.
 */
class FanOutQueueModule {}
Module({
  providers: [MessageClockService, WarmSingletonService, AuditConsumer, MirrorConsumer],
})(FanOutQueueModule);

export const FanOutQueueAppModule: Type<unknown> = FanOutQueueModule;

/** Consumer that never touches `message.payload`: laziness proof at the boundary. */
@Injectable()
class PayloadAgnosticConsumer {
  handle(message: QueueMessage, executionContext: YandexExecutionContext): void {
    payloadAgnosticRounds.push({
      messageId: message.messageId,
      awsRequestId: executionContext.awsRequestId,
    });
  }
}

const agnosticHandleDescriptor = Object.getOwnPropertyDescriptor(
  PayloadAgnosticConsumer.prototype,
  "handle",
);
if (!agnosticHandleDescriptor) {
  throw new Error("missing descriptor for PayloadAgnosticConsumer.handle");
}
QueueMessageDecorator()(PayloadAgnosticConsumer.prototype, "handle", 0);
QueueHandler()(PayloadAgnosticConsumer.prototype, "handle", agnosticHandleDescriptor);
YandexContext()(PayloadAgnosticConsumer.prototype, "handle", 1);

class PayloadAgnosticQueueModule {}
Module({ providers: [PayloadAgnosticConsumer] })(PayloadAgnosticQueueModule);

export const PayloadAgnosticQueueAppModule: Type<unknown> = PayloadAgnosticQueueModule;

// ---------------------------------------------------------------------------
// Combined application: one module serving BOTH transports over one warm
// application (issue #14 mixed-transport coverage).
// ---------------------------------------------------------------------------

class CombinedTransportModule {}
Module({
  controllers: [LifecycleController],
  providers: [MessageClockService, WarmSingletonService, AuditConsumer, MirrorConsumer],
})(CombinedTransportModule);

export const CombinedTransportAppModule: Type<unknown> = CombinedTransportModule;

// ---------------------------------------------------------------------------
// Yandex-shaped event builders (synthetic placeholder values only).
// ---------------------------------------------------------------------------

const FIXTURE_OPERATION_ID = "41cf33042e33".padEnd(64, "0");

export interface RuntimeContextOverrides {
  readonly token?: string;
}

/** Observed-shape runtime context (DATA-ANALYSE.md section D). */
export function makeRuntimeContext(
  awsRequestId: string,
  overrides: RuntimeContextOverrides = {},
): Record<string, unknown> {
  return {
    awsRequestId,
    functionName: "fn-e2e-lifecycle",
    functionVersion: "$LATEST",
    functionFolderId: "folder-e2e-fixture",
    memoryLimitInMB: "1024",
    deadlineMs: 1787328996791,
    logGroupName: "",
    ...(overrides.token === undefined ? null : { token: overrides.token }),
  };
}

export interface HttpEventOptions {
  readonly method?: string;
  readonly path?: string;
  readonly rawQueryString?: string;
  /** JSON body: encoded exactly as the gateway does for application/json. */
  readonly jsonBody?: unknown;
  readonly headers?: Record<string, string>;
}

/**
 * Minimal complete API Gateway v2 event (DATA-ANALYSE.md section B): every
 * validated field present, JSON bodies base64-encoded with
 * `isBase64Encoded: true` per the observed encoding contract.
 */
export function makeHttpEvent(options: HttpEventOptions = {}): RawHttpApiGatewayV2Event {
  const path = options.path ?? "/lifecycle/context";
  const rawQueryString = options.rawQueryString ?? "";
  let body = "";
  const isBase64Encoded = true;
  const headers: Record<string, string> = { Host: "e2e.fixture.local" };
  if (options.jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = Buffer.from(JSON.stringify(options.jsonBody), "utf8").toString("base64");
  }
  Object.assign(headers, options.headers);
  return {
    version: "2.0",
    rawPath: path,
    rawQueryString,
    headers,
    queryStringParameters: {},
    requestContext: {
      authorizer: {},
      http: {
        method: options.method ?? "GET",
        path: `${path}?${rawQueryString}`,
        sourceIp: "203.0.113.10",
        userAgent: "e2e-lifecycle-agent/1.0",
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
    operationId: FIXTURE_OPERATION_ID,
  };
}

const QUEUE_ID = "yrn:yc:ymq:ru-central1:b1ge2e0000000000:f-lifecycle";

export interface QueueMessageSpec {
  readonly messageId: string;
  /** Raw body delivered verbatim; may be any text, not necessarily JSON. */
  readonly body: string;
  /** Optional user message attributes (observed wire declaration shape). */
  readonly messageAttributes?: Record<string, { data_type: string; string_value: string }>;
}

export function makeQueueMessageEnvelope(spec: QueueMessageSpec): RawQueueMessageEvent {
  return {
    event_metadata: {
      event_id: spec.messageId,
      event_type: "yandex.cloud.events.messagequeue.QueueMessage",
      created_at: "2026-08-21T21:44:34.266Z",
      tracing_context: null,
      cloud_id: "a1b2c3d4e2e000000000",
      folder_id: "e5f6a7b8e2e000000000",
    },
    details: {
      queue_id: QUEUE_ID,
      message: {
        message_id: spec.messageId,
        md5_of_body: "9e107d9d372bb6826bd81d3542a419d6",
        body: spec.body,
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "1787328274187",
        },
        message_attributes: spec.messageAttributes ?? {},
        md5_of_message_attributes: "",
      },
    },
  };
}

export function makeQueueDelivery(...messages: readonly QueueMessageSpec[]): RawQueueEvent {
  return { messages: messages.map(makeQueueMessageEnvelope) };
}
