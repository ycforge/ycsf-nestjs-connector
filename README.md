# @ycforge/ycsf-nestjs-connector

NestJS adapter for [Yandex Cloud Functions](https://yandex.cloud/en/services/functions).
It lets a NestJS application run inside a Yandex Cloud Function behind two transports:

- **HTTP / API Gateway** — Yandex API Gateway payload format `2.0`, synchronous
  request/response semantics, normal NestJS controllers.
- **Message Queue** — Yandex Cloud Functions Message Queue trigger, asynchronous
  invocation semantics, message handlers built from NestJS abstractions.

The package is intentionally a thin runtime/transport adapter: it must not turn
NestJS into a Yandex-specific application framework. Business logic stays
independent of Yandex Cloud whenever practical.

> **Status: runtime bootstrap, execution context and the HTTP request adapter
> have landed.** The package architecture and public contracts are established
> (see [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and
> [`src/index.ts`](./src/index.ts)); the central function factory shipped with
> issue #3, the normalized execution context with `@YandexContext()` injection
> with issue #4, and the Yandex API Gateway v2 HTTP request adapter (detection,
> validation, normalization) with issue #5. Response/error mapping for HTTP
> (#6) and the Message Queue transport (#7/#8) are next. Observed Yandex Cloud
> runtime constraints that all connector code must respect are catalogued in
> [AGENTS.md](./AGENTS.md).

## Usage

```ts
import { createYandexHandler } from "@ycforge/ycsf-nestjs-connector";
import { AppModule } from "./app.module";

// Bootstraps Nest lazily on the first invocation, then reuses the cached
// application for every warm invocation.
const handler = createYandexHandler(AppModule);

export default { handler };
```

### Normalized execution context

Handlers can access runtime metadata through `@YandexContext()` parameter
injection instead of touching raw Yandex objects:

```ts
import { YandexContext } from "@ycforge/ycsf-nestjs-connector";
import type { YandexExecutionContext } from "@ycforge/ycsf-nestjs-connector";

@Injectable()
export class OrdersService {
  handle(@YandexContext() executionContext: YandexExecutionContext) {
    // Stable per-invocation correlation id (identical for HTTP and MQ).
    executionContext.awsRequestId;
    // Trace metadata preserved verbatim.
    executionContext.uberTraceId;
    // Escape hatches: untouched raw event/context.
    executionContext.rawEvent;
    executionContext.raw;
  }
}
```

The context is scoped to a single invocation and never shared between them.
Its IAM token (`executionContext.token`) is a secret: automatic serialization
(`JSON.stringify`) redacts it to `REDACTED_TOKEN` and excludes the raw
payloads, so accidental logging cannot leak credentials.

The built-in registry currently ships with the HTTP / API Gateway v2 request
adapter (#5): `version: "2.0"` events are detected, structurally validated,
normalized (canonical `rawPath`/`rawQueryString`, both query-parameter views,
`isBase64Encoded`-driven body decoding) and published to the invocation scope.
HTTP response/error mapping (#6) and Message Queue support (#7/#8) are not
landed yet; deliveries no transport claims reject with `ConnectorError` code
`UNKNOWN_INVOCATION_EVENT`. Environments requiring graceful teardown can call
`handler.close()` to release the cached application; the next invocation
cold-starts again.

## Architecture

The design-of-record lives in [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).
It covers the layering between the NestJS application layer and this
package's internal transport/core layers, the public API surface and its
visibility rules, invocation detection, cold/warm lifecycle expectations,
per-transport error semantics, raw-data preservation guarantees, and the
extension points for future transports.

Source layout:

| Directory         | Visibility | Responsibility                                    |
| ----------------- | ---------- | ------------------------------------------------- |
| `src/index.ts`    | Public     | The only entry point; deliberate export surface   |
| `src/core/`       | Mixed      | Transport SPI contracts; runtime internals (#3)   |
| `src/http/`       | Mixed      | Public HTTP contracts; adapter behavior (#5, #6)  |
| `src/mq/`         | Mixed      | Public queue contracts; adapter behavior (#7, #8) |
| `src/context/`    | Mixed      | Context contract + decorator (#4); internals      |
| `src/decorators/` | Public     | Decorator signatures; queue implementations (#8)  |

Per-module visibility tiers and the explicit list of public exports are in
[ARCHITECTURE.md §2 and §7](./docs/ARCHITECTURE.md#7-public-api-surface).

## Requirements

- Node.js >= 22
- Peer dependencies: `@nestjs/common`, `@nestjs/core` (^11)

## Development

```bash
npm install        # install toolchain
npm run lint       # eslint
npm run format:check
npm run typecheck  # tsc --noEmit
npm test           # jest
npm run build      # emit dist/ with declarations
npm run package:check
# validate the packed tarball: publishable file set plus standalone
# consumption through the public entry point only (runtime and type level)
```

Pull requests must pass lint, format check, typecheck, tests and build; CI runs
the same sequence on Node.js 22. See [AGENTS.md](./AGENTS.md) for the full set
of repository rules (transport boundaries, security, testing policy, commit
conventions).

## License

[MIT](./LICENSE)
