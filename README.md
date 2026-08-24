# @ycforge/ycsf-nestjs-connector

NestJS adapter for [Yandex Cloud Functions](https://yandex.cloud/en/services/functions).
It lets a normal NestJS application run inside a Yandex Cloud Function behind two
transports:

- **HTTP / API Gateway** — Yandex API Gateway payload format `2.0`, synchronous
  request/response semantics, ordinary NestJS controllers.
- **Message Queue** — Yandex Cloud Functions Message Queue trigger, asynchronous
  invocation semantics, message consumers built from NestJS abstractions.

The package is intentionally a thin runtime/transport adapter: it does not turn
NestJS into a Yandex-specific application framework. Controllers, services and
queue consumers stay plain NestJS code; Yandex-specific data stays reachable but
out of the way. The design-of-record is
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md); compatibility and versioning
rules are [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md).

## Requirements

- Node.js >= 22 (the function runtime and your build toolchain)
- Peer dependencies: `@nestjs/common` and `@nestjs/core` (`^11`) — any NestJS 11
  project already has them

## Installation

```bash
npm install @ycforge/ycsf-nestjs-connector
```

The published artifact is CommonJS with declaration files, so no bundler is
required: compile your function (for example with `tsc`) to CommonJS JavaScript
and deploy the output together with `node_modules`.

## How it works

```ts
import { createYandexHandler } from "@ycforge/ycsf-nestjs-connector";
import { AppModule } from "./app.module";

export const handler = createYandexHandler(AppModule);
```

`createYandexHandler(AppModule)` turns your root module into the handler the
function runtime invokes:

- Every incoming event is detected once at the boundary: API Gateway v2 events
  go to the HTTP transport, Message Queue trigger deliveries go to the queue
  transport, anything else fails fast with a diagnostic error — it is never
  silently treated as HTTP.
- The Nest application is bootstrapped lazily on the first invocation and then
  cached: warm invocations reuse the initialized application instead of paying
  the cold start again.
- One exported handler can serve both transports at the same time (an HTTP
  trigger and a Message Queue trigger pointing at the same function), because
  transports never share behavior.
- All per-invocation state (event, context, normalized request/message) is
  scoped to that single invocation; nothing leaks between invocations.

## Minimal HTTP function

A complete function needs three small files.

**`orders.controller.ts`**

```ts
import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";

@Controller("orders")
export class OrdersController {
  // GET /orders/42?expand=items -> {"id":"42","expand":"items"}
  @Get(":id")
  find(@Param("id") id: string, @Query("expand") expand?: string): object {
    return { id, expand };
  }

  @Post()
  create(@Body() body: unknown): object {
    return { received: body };
  }
}
```

Standard Nest parameter decorators work as usual: `@Query()` parses the
canonical query string, `@Param()` reads path parameters, `@Body()` receives
the decoded request body, guards/interceptors/pipes/filters behave unchanged.

**`app.module.ts`**

```ts
import { Module } from "@nestjs/common";
import { OrdersController } from "./orders.controller";

@Module({ controllers: [OrdersController] })
export class AppModule {}
```

**`index.ts`**

```ts
import { createYandexHandler } from "@ycforge/ycsf-nestjs-connector";
import { AppModule } from "./app.module";

// Bootstraps Nest lazily on the first invocation, then reuses the cached
// application for every warm invocation.
export const handler = createYandexHandler(AppModule);
```

Deploy it like any Node.js Yandex Cloud Function:

1. Compile to CommonJS into `dist/` (`npx tsc -p tsconfig.json`).
2. Create a Node.js 22 function and set its entry point to the exported
   handler, e.g. `dist/index.handler`.
3. For HTTP traffic, connect an [API Gateway](https://yandex.cloud/en/services/api-gateway)
   using payload format `2.0` — the format this package implements.

## Synchronous vs asynchronous transports

|                | HTTP / API Gateway                          | Message Queue trigger                                 |
| -------------- | ------------------------------------------- | ----------------------------------------------------- |
| Execution      | synchronous request/response                | asynchronous delivery                                 |
| Result         | HTTP response envelope                      | none — success means the delivery was fully processed |
| Handler errors | mapped to HTTP responses via Nest semantics | fail the whole invocation so retries/DLQ stay working |
| Trigger setup  | API Gateway (payload format `2.0`)          | Message Queue trigger invoking the function           |

Both transports inject the same execution context and share one warm
application; they differ only in what an invocation produces.

## HTTP request and response behavior

These rules reproduce observed API Gateway v2 behavior (see
[DATA-ANALYSE.md](./DATA-ANALYSE.md)); they are pinned by conformance fixtures.

### Body encoding

The gateway encodes bodies by content type:

- `Content-Type: application/json` arrives as plain UTF-8 text
  (`isBase64Encoded === false`);
- everything else — plain text, forms, binaries, missing content types,
  empty bodies — arrives Base64-encoded (`isBase64Encoded === true`).

Decoding follows `isBase64Encoded`, never a Content-Type guess, so binary data
cannot be corrupted. Malformed JSON request bodies surface as deterministic
`400 Bad Request` responses, exactly like on any other platform.

### Canonical path and query

Routing uses `rawPath`, and `@Query()` parses `rawQueryString`. These are the
canonical representations of the original request; the rebuilt
`requestContext.http.path` is deliberately ignored because the gateway may
reorder query parameters or append a trailing `?` there.

### Repeated query parameters

For `GET /orders?tag=one&tag=two&tag=three` the gateway delivers two different
views, and both survive normalization:

- `queryStringParameters.tag === "one,two,three"` — repeated values
  comma-joined;
- `multiValueParameters.tag === ["one", "two", "three"]` — value lists.

Nest's `@Query("tag")` parses the canonical query string and returns
`["one", "two", "three"]`. The verbatim gateway views stay accessible through
the raw event escape hatch (below); they are never merged into each other.

### Responses

Handlers return values normally; the connector serializes them into the
Yandex Function response envelope:

- explicit content types always win; implicit defaults are `application/json`
  for objects, `text/plain; charset=utf-8` for strings and
  `application/octet-stream` for buffers;
- `Buffer` bodies are sent Base64-encoded (`isBase64Encoded: true`);
- single-valued headers go to `headers`; repeated values (typically multiple
  `Set-Cookie` appends) move to the optional `multiValueHeaders` map instead of
  being lossily comma-joined. That field is live-verified against the real
  API Gateway response path: the gateway joins repeated ordinary headers into
  one wire line but emits repeated `Set-Cookie` values as separate header
  lines.

### Errors

HTTP exceptions are first-class NestJS territory: `HttpException` responses
keep their exact status code and body, exception filters and interceptors stay
in charge. An unexpected failure becomes one static opaque envelope
(`{"statusCode":500,"message":"Internal server error"}`) — no stack frames,
error messages or request values reach the client. Unmatched requests hit the
normal Nest not-found handling. A failing invocation never affects the next
warm one.

## Execution context: `@YandexContext()`

Inject the normalized invocation context into any controller/service method or
queue handler parameter:

```ts
import { Controller, Get } from "@nestjs/common";
import { YandexContext } from "@ycforge/ycsf-nestjs-connector";
import type { YandexExecutionContext } from "@ycforge/ycsf-nestjs-connector";

@Controller("probe")
export class ProbeController {
  @Get()
  probe(@YandexContext() yandex: YandexExecutionContext): object {
    return {
      invocationId: yandex.awsRequestId, // stable cross-transport correlation id
      functionName: yandex.functionName,
    };
  }
}
```

Available fields include `awsRequestId` (the correlation id shared by HTTP and
Message Queue invocations), `functionName`, `functionVersion`,
`functionFolderId`, `memoryLimitInMB` (kept verbatim as a string),
`deadlineMs` (epoch milliseconds), `logGroupName`, optional `token` and
`uberTraceId`, plus two escape hatches: `rawEvent` (the untouched API Gateway
v2 event or Message Queue delivery) and `raw` (the entire runtime context,
including undocumented fields).

Security-sensitive values: `token` (IAM token of the function's service
account), `Authorization`/`Cookie` headers inside raw events and client IP
data (`sourceIp`, forwarded headers) must never be logged. Automatic
serialization protects you by default — `JSON.stringify(context)` replaces the
token with `REDACTED_TOKEN` and omits the raw payloads entirely. For your own
diagnostics use [`safeDiagnostics`](#safe-diagnostics-vs-raw-access).

## Safe diagnostics vs raw access

Raw escape hatches (`raw`, `rawEvent`, direct property access) are exact and
intentionally unsafe references — they carry credentials and unredacted
personal data. When you log or snapshot invocation data yourself, route it
through `safeDiagnostics` instead of serializing raw structures directly:

```ts
import { safeDiagnostics } from "@ycforge/ycsf-nestjs-connector";

console.log(JSON.stringify(safeDiagnostics({ stage: "done", context })));
```

`safeDiagnostics(value)` returns a redacted, JSON-safe copy (input is never
mutated): tokens become `REDACTED_TOKEN`, credential headers and client IPs in
recognized header maps become placeholders, queue bodies/deserialized payloads
stay out, errors collapse to `{ name }` (+ stable codes), getters such as lazy
`payload` are never evaluated. It is a diagnostics aid, not a security
framework — your own error messages remain your responsibility.

## Message Queue consumers

Queue handlers are ordinary providers (or controllers) whose methods carry
`@QueueHandler()`. There is no separate bootstrap: the same
`createYandexHandler(AppModule)` serves queue triggers.

```ts
import { Injectable } from "@nestjs/common";
import { QueueHandler, QueueMessage, YandexContext } from "@ycforge/ycsf-nestjs-connector";
import type { YandexExecutionContext } from "@ycforge/ycsf-nestjs-connector";

interface OrderEvent {
  orderId: string;
}

@Injectable()
export class OrdersConsumer {
  @QueueHandler()
  handle(
    @QueueMessage() message: QueueMessage<OrderEvent>,
    @YandexContext() yandex: YandexExecutionContext,
  ): void {
    this.processOrder(message.payload); // deserialized application payload
    this.auditDelivery(yandex.awsRequestId, message.messageId, message.body);
  }

  private processOrder(order: OrderEvent): void {}

  /** Raw body access stays available beside the typed payload. */
  private auditDelivery(invocationId: string, messageId: string, rawBody: string): void {}
}
```

### Delivery model

- A delivery is modeled as a batch: `messages[]`. The current trigger
  configuration groups one message per invocation (**observed**), but nothing
  in the domain model hard-codes that limit — consumers are batch-ready.
- Every discovered `@QueueHandler()` method receives **every** delivered
  message, sequentially in delivery order (fan-out). Return values are ignored:
  a queue delivery has no response envelope.
- Batch processing is fail-fast: the first failure rejects the whole
  invocation immediately and later messages are not attempted in that
  invocation. Redelivery after a failure is decided by the platform's retry
  configuration (at-least-once semantics); deduplicate in your consumer if
  reprocessing matters.
- Provider scopes behave exactly like one platform request per message:
  `DEFAULT` providers keep their warm-process singleton across all
  invocations, `REQUEST` providers get a fresh instance per message that stays
  consistent across every handler call of that message, and `TRANSIENT`
  providers refresh at every injection point.

A failing handler fails the whole invocation — deliberately, so Message Queue
retry/dead-letter configuration stays effective. A delivery reaching an
application without any registered `@QueueHandler()` fails with
`ConnectorError` code `NO_QUEUE_HANDLER` instead of being silently
acknowledged.

### Payloads: raw, normalized, deserialized

Three representation levels coexist on every message and are kept strictly
apart:

1. **Raw** — `message.body`, the exact delivered string, plus everything under
   `message.raw` and `batch.raw`.
2. **Normalized** — identity (`messageId`), checksums (`md5OfBody`),
   system/user attributes and delivery metadata in their observed forms.
   Strings stay strings: timestamps keep their ISO form, attribute values keep
   their exact form (`{ dataType, stringValue }` — Number-typed values are not
   coerced, converting them is your deliberate step), unknown future fields
   flow through untouched.
3. **Deserialized** — `message.payload`, typed as `QueueMessage<T>`'s generic.

Payload deserialization is **lazy and memoized**: nothing is parsed during
normalization, the configured strategy runs on the first read of `payload`,
and the outcome is computed once per message and replayed afterwards — so
handlers that only inspect metadata skip parsing entirely, and fan-out
handlers observe one consistent payload.

The default strategy is strict JSON: valid JSON becomes exactly what
`JSON.parse` produces (no Date revival, no numeric rewriting). Anything else —
plain text, empty or malformed bodies — raises `ConnectorError` code
`QUEUE_BODY_DESERIALIZATION_FAILED` inside exactly the handler round that
reads `payload`; `body` and `raw` stay usable throughout, so non-JSON queues
remain fully accessible without any custom setup.

Queues that do not carry JSON can install an explicit custom deserializer:

```ts
const handler = createYandexHandler(AppModule, {
  queue: {
    deserializeBody: (body, message) => JSON.parse(body),
  },
});
```

The strategy receives `(body, message)` — the exact raw string plus the
normalized message, so it can branch on attributes — and its return value
(including `undefined`) becomes `payload`. Failures propagate verbatim into
the consuming round, exactly like handler failures.

## Error semantics

Every invocation ends in a transport-shaped success or a transport-shaped
failure. Failures belong to exactly one of three classes (full contract:
[ARCHITECTURE.md §6](./docs/ARCHITECTURE.md#6-error-semantics)):

| Class                         | Raised when                                                  | Behavior                                                                                                                                                |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invocation validation         | unknown/malformed events, unsupported route patterns         | `ConnectorError`: `UNKNOWN_INVOCATION_EVENT`, `INVALID_INVOCATION_EVENT`, `UNSUPPORTED_ROUTE_PATTERN` (the last fails cold start); before any user code |
| Queue payload deserialization | invalid JSON read via `payload` (or custom strategy failure) | `QUEUE_BODY_DESERIALIZATION_FAILED` / original error, failing the consuming round                                                                       |
| Application handler failure   | your controllers/services/consumers throw                    | never wrapped: HTTP maps through Nest semantics, Message Queue propagates out of the invocation                                                         |

`error instanceof ConnectorError` identifies an expected boundary error raised
by this package; branch on its stable `code`, never on messages.

Bootstrap failures behave sanely too: if Nest initialization fails, the
invocation rejects with the original error (never a falsely successful
response), concurrent cold-start callers observe the same failure, and the
next invocation retries initialization from scratch.

## Cold starts, warm invocations and shutdown

- First invocation performs the full Nest initialization; concurrent cold
  starts share one initialization promise instead of building duplicate
  applications.
- Warm invocations reuse the cached application — Nest is never re-created per
  invocation, while all per-invocation data stays isolated between requests.
- Environments requiring graceful teardown call `handler.close()`: idempotent,
  safe before the first invocation, releases the cached application so the
  next invocation cold-starts fresh. Otherwise the application simply lives as
  long as the warm execution environment.

## Local development and replay

Application code stays testable with plain NestJS tooling — controllers and
consumers neither know nor care that Yandex exists. To exercise the full
runtime locally (warm caching, transport detection, normalization, failure
semantics), the repository ships a replay CLI that runs sanitized conformance
fixtures through the same public `createYandexHandler()` entry point — with no
Yandex Cloud connectivity, credentials or network access:

```bash
git clone https://github.com/ycforge/ycsf-nestjs-connector.git
cd ycsf-nestjs-connector
npm ci

npm run replay -- --http-all --mq-all          # every committed fixture
npm run replay -- --mq json-body-message       # one fixture by name
npm run replay -- --module ./dist/my-app.module.js --mq my-scenario.json
```

`--module` points at a compiled JS file exporting your `AppModule`, so your own
application replays against recorded-shape events. Exit code `0` means every
selected fixture succeeded; CLI output is deliberately value-free (fixture
names, status codes, fixed error categories only).

The fixtures are sanitized reconstructions derived from captured evidence of
real Yandex invocations — not literal production dumps; sensitive values are
deterministic placeholders (provenance rules: [fixtures/README.md](./fixtures/README.md)).
They double as templates for driving your own local tests: feed a fixture's
raw `event`/`context` objects straight into the exported handler.

Full details: [docs/REPLAY.md](./docs/REPLAY.md).

## Documentation map

| Document                                         | Contents                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)   | Layering, public API surface, lifecycle, transport and error contracts |
| [docs/COMPATIBILITY.md](./docs/COMPATIBILITY.md) | Semver policy, supported environments, stability guarantees            |
| [docs/REPLAY.md](./docs/REPLAY.md)               | Replay CLI and programmatic replay API                                 |
| [DATA-ANALYSE.md](./DATA-ANALYSE.md)             | Evidence base of observed Yandex runtime behavior                      |
| [fixtures/README.md](./fixtures/README.md)       | Fixture provenance, sanitization and scenario index                    |
| [AGENTS.md](./AGENTS.md)                         | Repository rules for contributors                                      |

## Development (this repository)

```bash
npm install        # install toolchain
npm run lint       # eslint
npm run format:check
npm run typecheck  # tsc --noEmit
npm test           # jest
npm run build      # emit dist/ with declarations
npm run package:check
# packs the tarball and proves it contains only built output plus metadata,
# consumed standalone through the public entry point
npm run replay -- --http-all --mq-all
# locally replay the sanitized conformance fixtures through
# createYandexHandler(); see docs/REPLAY.md
```

Every pull request and every push to `main` runs the identical sequence in
GitHub Actions on the Node.js version pinned in [.nvmrc](./.nvmrc): install,
lint, format check, typecheck, tests, build, package validation. Tagging a
commit with `v*` triggers release preparation — the packed tarball is stored
as a workflow artifact for inspection; publishing to npm is deliberately not
automated yet and must only ever be introduced with a secure publishing
mechanism.

## License

[MIT](./LICENSE)
