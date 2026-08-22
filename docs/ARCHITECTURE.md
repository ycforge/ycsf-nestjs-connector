# Architecture

This document defines the architecture and public contracts of
`@ycforge/ycsf-nestjs-connector`. It is the design-of-record for issue #1;
runtime behavior is implemented incrementally by later issues and must conform
to the contracts defined here.

Evidence levels used below, following AGENTS.md §2.3:

- **observed** — captured from the real Yandex Cloud Functions runtime.
- **documented** — stated by Yandex documentation.
- **inferred** — a deliberate design decision made where evidence is absent;
  always marked as such.

---

## 1. Layering

```text
+---------------------------------------------------------------+
| Application layer (user code)                                 |
|   NestJS controllers, queue handlers, services                |
|   MUST NOT import anything from this package's internals      |
|   and SHOULD not need Yandex-specific types at all            |
+---------------------------------------------------------------+
                              | depends only on public API (src/index.ts)
+---------------------------------------------------------------+
| Public contract layer (@ycforge/ycsf-nestjs-connector)        |
|   Normalized models: HTTP request, response envelope,         |
|   queue batch/message, execution context                      |
|   Decorator signatures: @YandexContext @QueueHandler          |
|   @QueueMessage                                               |
|   createYandexHandler(AppModule) entry point                  |
+---------------------------------------------------------------+
                              | implemented by
+---------------------------------------------------------------+
| Transport adapter layer (internal)                            |
|   src/http — API Gateway v2 event <-> NestJS HTTP             |
|   src/mq   — Message Queue trigger event -> handler dispatch  |
|   Each transport is independent: no shared behavior,          |
|   no knowledge of each other's semantics.                     |
+---------------------------------------------------------------+
                              | bootstraps / routes
+---------------------------------------------------------------+
| Core runtime layer (internal)                                 |
|   src/core — detection, Nest bootstrap + warm caching,        |
|   invocation-scoped context propagation, raw escape hatches   |
+---------------------------------------------------------------+
```

The application layer is the user's NestJS application. The connector is a
thin runtime/transport adapter (AGENTS.md §1): it never turns NestJS into a
Yandex-specific framework, and business code stays testable with plain
NestJS/HTTP/queue abstractions.

## 2. Module map and visibility

Visibility tiers:

- **Public** — exported through `src/index.ts`; stable per semver (AGENTS.md
  §19).
- **Internal** — everything else. The `exports` map in `package.json` exposes
  only the `"."` subpath, so deep imports of `dist/**` are blocked by the
  package resolver; internal modules may change at any time.

| Module                                          | Visibility | Responsibility                                               |
| ----------------------------------------------- | ---------- | ------------------------------------------------------------ |
| `src/core/transport.ts`                         | Public     | Transport SPI: adapter contract, handler type, container ref |
| `src/core/raw-access.ts`                        | Public     | `HasRaw` mixin contract for lossless raw access              |
| `src/core/errors.ts`                            | Public     | Error taxonomy codes for unknown/invalid invocations         |
| `src/core/create-yandex-handler.ts`             | Public     | Runtime entry point: bootstrap, caching, dispatch (#3)       |
| `src/core/connector-error.ts`                   | Public     | Concrete boundary error carrying the taxonomy codes (#3)     |
| `src/core/detect-transport.ts`                  | Internal   | Detection loop over the ordered adapter registry (#3)        |
| `src/core/transports.ts`                        | Internal   | Ordered built-in adapter registry; registration point        |
| `src/http/raw-event.ts`                         | Public     | Raw API Gateway v2 event shape (**observed**)                |
| `src/http/normalized-request.ts`                | Public     | Normalized HTTP request contract                             |
| `src/http/response.ts`                          | Public     | Function response envelope (**documented**)                  |
| `src/mq/raw-event.ts`                           | Public     | Raw Message Queue trigger event shape (**observed**)         |
| `src/mq/message.ts`                             | Public     | Normalized queue message/batch contracts                     |
| `src/context/yandex-execution-context.ts`       | Public     | Normalized execution context (**observed**)                  |
| `src/context/build-yandex-execution-context.ts` | Internal   | Builds the normalized context per invocation (#4)            |
| `src/context/invocation-scope.ts`               | Internal   | AsyncLocalStorage invocation isolation (#4)                  |
| `src/context/yandex-context.decorator.ts`       | Public     | `@YandexContext()` implementation (#4)                       |
| `src/decorators/decorator-contracts.ts`         | Public     | Signatures of the three decorators                           |
| `src/http/*`, `src/mq/*` adapters               | Internal   | Behavior implementing the above contracts (#5–#8)            |

Rules:

- `src/index.ts` is the **only** public entry point. Exports there are added
  deliberately and explicitly (`export type { ... } from "..."`), never via a
  wildcard barrel.
- Types are exported as _type-only_ until their runtime implementation exists,
  so consumers can compile against contracts without shipping dead code.

## 3. Invocation flow and lifecycle

### 3.1 Entry point

The single runtime entry point is:

```ts
const handler = createYandexHandler(AppModule);
export const handler; // consumed by the Yandex Cloud Function runtime
```

`createYandexHandler` returns a `ClosableYandexCloudFunctionHandler`: the exact
`YandexCloudFunctionHandler` call signature the function runtime invokes
(`(rawEvent, rawContext) => Promise<unknown>`) plus a `close()` teardown hook
(section 3.4). Contract: `src/core/transport.ts`. Implementation: issue #3.

### 3.2 Cold start

- On first invocation the core bootstraps the Nest application exactly once.
- The bootstrap uses `NestFactory.create(AppModule, new YandexHttpAdapter())`
  over the framework transport SPI (`AbstractHttpAdapter`), followed by
  `app.init()`: Nest builds the full dependency graph and registers routes,
  middleware and body parsing with the connector's own adapter instead of an
  HTTP listener. No socket is opened and no platform package
  (`@nestjs/platform-express`) is required; the only peers stay
  `@nestjs/common`/`@nestjs/core`. Controller dispatch then flows through the
  warm application itself, so framework semantics (guards, interceptors,
  pipes, filters) apply unchanged.
- Initialization is race-safe: a single shared initialization promise lives in
  the handler factory closure, so concurrent cold invocations await one
  instance instead of building duplicate applications (AGENTS.md §10.3). One
  cache exists per created handler — never global state shared between
  unrelated handlers.
- A failed cold start is **not** cached as a permanent failure: the promise is
  cleared on rejection so the next invocation retries initialization. All
  concurrent callers of the failed attempt receive the same bootstrap error.

### 3.3 Warm invocations

- The initialized application is cached and reused; Nest is never re-created
  per invocation (AGENTS.md §10.2).
- Everything invocation-specific (event, context, normalized request/message)
  is created per invocation and passed explicitly. No singleton may hold
  `currentEvent`/`currentContext`/`currentMessage` state between invocations
  (AGENTS.md §11); tests must prove isolation across sequential invocations.

### 3.4 Shutdown

Yandex Cloud Functions freezes or reclaims execution environments without
guaranteed teardown signals, so the connector registers no automatic shutdown
hooks and deliberately keeps the application alive for warm invocations until
the environment dies with it. Environments where graceful teardown is required
(custom runtimes, integration tests) call `close()` on the returned handler:
it releases the cached application, is idempotent, performs nothing when no
cold start happened yet, awaits an in-flight initialization before releasing
it, and lets the next invocation perform a fresh cold start.

### 3.5 Invocation-scoped execution context (#4)

After detection claims an event, the core builds one
`YandexExecutionContext` per invocation (`src/context/build-yandex-execution-context.ts`)
from the untouched event/context pair and dispatches inside an
AsyncLocalStorage scope (`src/context/invocation-scope.ts`). Consequences:

- The context is transport-neutral: HTTP and Message Queue executions expose
  the identical abstraction, including the same correlation id
  (`awsRequestId`) and trace metadata.
- `@YandexContext()` is a thin parameter registration; transports fill the
  registered parameters from the invocation scope when dispatching to user
  handlers (issues #5/#7/#8). Resolution outside an invocation fails loudly.
- The scope state is the transports' extension slot: the claiming transport
  adds its normalized per-invocation models (the HTTP request since issue #5)
  immutably before dispatch, so concurrent invocations keep fully isolated
  views (AGENTS.md §11).
- The scope exists only for the duration of one handler invocation: concurrent
  invocations get isolated stores, sequential invocations never observe each
  other's state (AGENTS.md §11), and nothing survives after completion.
- The normalized context is frozen and carries a serialization guard
  (`toJSON`) that redacts the IAM token and excludes raw payloads, so
  accidental logging cannot leak credentials (AGENTS.md §6.2). Explicit
  property access remains available as the escape hatch.

## 4. Transport detection

Detection happens **once**, in the core, immediately after receiving the raw
invocation — never scattered through application code (AGENTS.md §30).

Policy:

1. Core iterates registered transport adapters in a fixed, deterministic order.
2. Each adapter answers `supports(rawEvent)` — a cheap, deterministic,
   structural predicate that never throws and never mutates the input.
3. The first adapter that claims the event handles it exclusively.
4. If no adapter claims the event, the core throws an error coded
   `UNKNOWN_INVOCATION_EVENT`. Unknown events are **never silently treated as
   HTTP**, and arbitrary objects that happen to contain `messages` are not
   trusted as MQ events without full structural validation (AGENTS.md §8.3).

Discriminators (**observed**):

- **HTTP**: `event.version === "2.0"` plus the presence of the canonical
  fields `rawPath` / `rawQueryString` (full validation in the HTTP adapter).
- **Message Queue**: a validated `messages` array whose elements match the
  observed trigger structure (`event_metadata`, `details.queue_id`,
  `details.message.message_id`, ...). Validation must be cheap top-level
  structure checks — no heavyweight schema library (AGENTS.md §9).

Adding a future transport means writing a new internal adapter module,
extending the `TransportId` union in one place, and registering it in
`src/core/transports.ts`'s ordered adapter list. The application layer does
not change. The built-in registry currently contains the HTTP / API Gateway
v2 adapter (#5); until issue #7 registers the Message Queue adapter, queue-shaped
events fail with `UNKNOWN_INVOCATION_EVENT` — an honest rejection, never
half-working behavior. Detection also precedes initialization: events nobody
claims never trigger a Nest cold start.

The registered HTTP adapter (`src/http/adapter.ts`) claims events whose
`version === "2.0"` plus string `rawPath`/`rawQueryString` (**observed**
discriminator), validates the full observed shape inside its dispatch, and
publishes the normalized `NormalizedHttpRequest` into the invocation scope
before user code runs. Controller dispatch then goes through the warm
application itself: the transport resolves the application's HTTP adapter,
verifies it is the connector's own (`YandexHttpAdapter`), and hands it the
normalized request plus a fresh response facade. The dispatch pipeline runs
body parsing, registered middleware, route resolution and error handling in
framework order; response serialization maps the facade onto the
`YandexFunctionHttpResponse` envelope (section 6.1).

## 5. Raw data preservation

Every normalized model carries its untouched source under `raw` via the
`HasRaw<TRaw>` contract:

- `NormalizedHttpRequest.raw` → the raw API Gateway v2 event.
- `QueueBatch.raw` / `QueueMessage.raw` → the raw trigger event / message.
- `YandexExecutionContext.raw` → the entire raw function context, including
  undocumented fields such as `_data`.
- `YandexExecutionContext.rawEvent` → the raw invocation event this context
  belongs to (API Gateway v2 payload or Message Queue delivery).

Consequences enforced by this rule:

- Normalization is transformation, never mutation of raw objects (AGENTS.md
  §7.3).
- Additive/unknown Yandex fields remain reachable through `raw` even when the
  normalized model does not describe them yet (AGENTS.md §36). Raw interfaces
  therefore include explicit index signatures typed `unknown`.
- Values are never silently coerced: `memoryLimitInMB` stays `string`,
  `createdAt` stays ISO string, repeated query parameters keep both their
  comma-joined (`queryStringParameters`) and list (`multiValueParameters`)
  forms without merging them (AGENTS.md §4.3, §5).

## 6. Error semantics

Error handling differs by transport because the transports differ in sync vs
async semantics.

### 6.1 Synchronous HTTP

- Exceptions raised inside controllers/services are first-class NestJS
  territory: the dispatch pipeline runs the application's registered exception
  layers (`setErrorHandler`) after middleware and route execution, so normal
  exception filters and `HttpException` mapping produce the HTTP response
  unchanged. The connector does not swallow or wrap them.
- Failures escaping every registered layer fall back to a deterministic,
  opaque internal-server-error envelope (`statusCode` `500`,
  `"Internal server error"`) mirroring the platform default; neither the error
  message nor stack frames reach the client (AGENTS.md §8.1).
- Success serialization maps the response facade onto
  `YandexFunctionHttpResponse`: string bodies stay plain UTF-8, `Buffer`
  bodies become Base64 with `isBase64Encoded: true`, and JSON objects
  serialize as `application/json`. Single-value headers collapse to strings;
  repeated values (e.g. multiple `Set-Cookie` appends) surface under the
  documented optional `multiValueHeaders` field instead of being lost or
  comma-joined (**documented**, not an observed runtime field).
- Framework router semantics are inherited rather than reimplemented:
  unmatched routes produce the platform's 404 envelope (`Cannot …` message)
  through the connector's defense-in-depth fallbacks (which only fire when no
  Nest layer is registered), and `POST` routes default to `201 Created`.
- Malformed JSON request bodies surface as deterministic `400 Bad Request`
  responses through the same error path — body parsing is the pipeline's
  first step, so syntax errors flow through exception layers exactly like
  platform `bodyParser` errors do.

### 6.2 Asynchronous Message Queue

- Any failure inside a queue handler propagates out of the invocation. The
  connector never catches-and-forgets (AGENTS.md §8.2): a failed message must
  surface as a failed invocation so Message Queue retry / dead-letter
  configuration remains effective. Acknowledgement/retry policy knobs are
  introduced by issue #10 if ever needed.
- Partial-batch failures fail the whole invocation unless a deliberate,
  documented acknowledgement policy says otherwise; the domain model stays
  batch-capable regardless of the current grouped-message limit of `1`
  (**observed**, AGENTS.md §4.6).

### 6.3 Boundary errors

Two error codes are reserved at the runtime boundary (`src/core/errors.ts`):

| Code                       | Meaning                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `UNKNOWN_INVOCATION_EVENT` | No transport claimed the event (diagnostic, non-secret detail) |
| `INVALID_INVOCATION_EVENT` | A claiming transport failed deeper structural validation       |

Concrete error classes: `ConnectorError` (issue #3) implements both codes and
is thrown at the detection boundary; transports raise
`INVALID_INVOCATION_EVENT` from their own validation. Redaction utilities for
diagnostics land with issue #13; error messages carry structural information
only (field names, never payload values).

## 7. Public API surface

Explicit list. Everything not listed here is internal.

Defined now (exported from `src/index.ts`):

| Export                                                                                       | Kind  | Purpose                                              |
| -------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------- |
| `createYandexHandler`                                                                        | value | Central entry point: module -> function handler (#3) |
| `ClosableYandexCloudFunctionHandler`                                                         | type  | Handler plus `close()` teardown hook (#3)            |
| `ConnectorError`                                                                             | value | Boundary error carrying the taxonomy codes (#3)      |
| `YandexCloudFunctionHandler`                                                                 | type  | Signature the function runtime calls                 |
| `TransportAdapter`                                                                           | type  | SPI each transport implements                        |
| `TransportInvocation`                                                                        | type  | Per-invocation input handed to a transport           |
| `TransportId`                                                                                | type  | Stable transport discriminator ids                   |
| `InvocationContainer`                                                                        | type  | Read-only provider resolution over warm app          |
| `InjectableToken`                                                                            | type  | Token accepted by `InvocationContainer`              |
| `HasRaw`                                                                                     | type  | Raw-preservation mixin                               |
| `ConnectorErrorCode`                                                                         | type  | Reserved boundary error codes                        |
| `RawHttpApiGatewayV2Event` (+ context types)                                                 | type  | Observed raw HTTP event                              |
| `NormalizedHttpRequest`                                                                      | type  | Canonical normalized request                         |
| `YandexFunctionHttpResponse`                                                                 | type  | Response envelope returned to the runtime            |
| `RawQueueEvent`, `RawQueueMessageEvent`, `RawQueueMessageAttributeValue`                     | type  | Observed raw MQ event                                |
| `QueueBatch`, `QueueMessage`, `QueueEventMetadata`, `QueueMessageAttribute`                  | type  | Normalized MQ models                                 |
| `YandexExecutionContext`                                                                     | type  | Normalized execution context (**observed**)          |
| `ContextParameterDecorator`, `QueueMessageParameterDecorator`, `QueueHandlerMethodDecorator` | type  | Decorator signatures                                 |
| `YandexContext()`                                                                            | value | Parameter injection of the normalized context (#4)   |

Planned runtime exports (implemented by their owning issues; adding them must
not change these contracts):

| Export                               | Issue |
| ------------------------------------ | ----- |
| `@QueueHandler()`, `@QueueMessage()` | #8    |

The runtime value exports are pinned in two places that must stay in sync with
this table: `src/index.spec.ts` and `EXPECTED_RUNTIME_EXPORTS` in
`scripts/validate-package.mjs`.

## 8. Extension points

- **New transports** (e.g., Object Storage triggers): implement
  `TransportAdapter`, extend `TransportId`, register the adapter in the core's
  deterministic order. No changes to normalized models of other transports and
  none to the application layer.
- **Application-side extensibility** stays in NestJS: users intercept behavior
  with standard guards/interceptors/filters, not connector-specific plugins.
- **Raw escape hatches** guarantee that gaps in the connector can be bridged by
  application code reading `raw`, without waiting for connector support — while
  keeping day-to-day code decoupled from Yandex shapes.

## 9. Runtime targets

- Node.js >= 22 (`engines` field), CommonJS output with declaration files for
  frictionless consumption by NestJS toolchains.
- Peer dependencies limited to `@nestjs/common` and `@nestjs/core` (^11);
  zero runtime dependencies otherwise (AGENTS.md §17).

## 10. Traceability

| Concern                                | Where defined here | Implemented by |
| -------------------------------------- | ------------------ | -------------- |
| Bootstrap + lifecycle + race-safe init | §3                 | #3             |
| Execution context + `@YandexContext()` | §5, §7             | #4             |
| HTTP request adapter                   | §4, §5, §6.1       | #5             |
| HTTP response/error mapping            | §6.1               | #6             |
| MQ event adapter                       | §4, §5             | #7             |
| Queue decorators/dispatch              | §6.2, §7           | #8             |
| Body deserialization, attributes       | §5                 | #9             |
| Unified error/retry/acknowledgement    | §6.3               | #10            |
| Redaction/security utilities           | §6.3               | #13            |
