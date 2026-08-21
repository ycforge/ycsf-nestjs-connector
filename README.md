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

> **Status: architecture defined, runtime in progress.** The package
> architecture and public contracts are established (see
> [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) and the type-only exports of
> [`src/index.ts`](./src/index.ts)); transport behavior is implemented
> incrementally. Observed Yandex Cloud runtime constraints that all connector
> code must respect are catalogued in [AGENTS.md](./AGENTS.md).

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
| `src/context/`    | Public     | Normalized execution context contract             |
| `src/decorators/` | Public     | Decorator signatures; implementations (#4, #8)    |

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
