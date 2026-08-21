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

> **Status: bootstrap.** Repository scaffolding, tooling and CI are in place;
> no connector logic is implemented yet and the public API surface
> (`src/index.ts`) is deliberately empty until it can be designed deliberately.
> Observed Yandex Cloud runtime constraints that transport code must respect
> are catalogued in [AGENTS.md](./AGENTS.md).

## Planned architecture

```text
                     NestJS Application
                            |
              +-------------+-------------+
              |                           |
       HTTP / API Gateway          Message Queue
              |                           |
       Yandex HTTP event          Yandex MQ event
              |                           |
              +-------------+-------------+
                            |
               @ycforge/ycsf-nestjs-connector
                            |
                     NestJS runtime
```

Source layout (placeholders during bootstrap):

| Directory         | Responsibility                                    |
| ----------------- | ------------------------------------------------- |
| `src/core/`       | Bootstrap, warm-start caching, invocation routing |
| `src/http/`       | API Gateway v2 event ↔ NestJS HTTP translation    |
| `src/mq/`         | Message Queue trigger event → handler dispatch    |
| `src/context/`    | Normalized execution context                      |
| `src/decorators/` | Thin metadata/injection decorators                |

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
```

Pull requests must pass lint, format check, typecheck, tests and build; CI runs
the same sequence on Node.js 22. See [AGENTS.md](./AGENTS.md) for the full set
of repository rules (transport boundaries, security, testing policy, commit
conventions).

## License

[MIT](./LICENSE)
