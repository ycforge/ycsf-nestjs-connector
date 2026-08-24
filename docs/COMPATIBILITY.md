# Compatibility and versioning policy

This document defines what `@ycforge/ycsf-nestjs-connector` promises its consumers, how
changes to those promises are classified under semantic versioning, and how future changes
in Yandex Cloud, NestJS and Node.js are handled. It is the compatibility design-of-record
for issue #17; the API list itself lives in
[ARCHITECTURE.md §7](./ARCHITECTURE.md#7-public-api-surface).

The package has not published its first stable release yet; these rules govern the public
contract from the first published version onward.

## Status vocabulary

Every runtime detail this repository talks about belongs to exactly one of four tiers.
Documentation and tests use these labels consistently:

| Tier                              | Meaning                                                                                                         | Stability promise                                                                               |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Public / stable**               | Exported through `src/index.ts` and listed in ARCHITECTURE.md §7                                                | Guarded by semver (§2); breaking changes require a major release                                |
| **Internal**                      | Everything else: adapter implementations, core internals, `src/testing/`, unpublished module paths              | May change or vanish in any release, including patch releases                                   |
| **Observed but not guaranteed**   | Raw Yandex event/context/message shapes captured from the live runtime (`DATA-ANALYSE.md`, AGENTS.md §4)        | Reproduced faithfully as long as Yandex keeps sending them; never silently normalized away (§4) |
| **Guaranteed connector behavior** | Documented connector semantics: transport detection order, failure classes, redaction rules, raw escape hatches | Stable public contract; changes follow §2 and §7                                                |

Evidence levels (**observed**, **documented**, **inferred**) keep their AGENTS.md §2.3
meaning; a detail can be _observed_ today and still only become _public_ once it is part of
the exported surface or of documented connector behavior.

## 1. Public API surface

The public API is **exactly** what `src/index.ts` exports:

- runtime values: `createYandexHandler`, `ConnectorError`, `safeDiagnostics`,
  `YandexContext()`, `QueueHandler()`, `QueueMessage()` (merged value-plus-type export);
- type-only contracts: handler/entry-point options, the transport SPI
  (`TransportAdapter`, `TransportInvocation`, `TransportId`, `InvocationContainer`,
  `InjectableToken`, `YandexCloudFunctionHandler`, `ClosableYandexCloudFunctionHandler`),
  raw observed shapes (`RawHttpApiGatewayV2Event` & context types, `RawQueueEvent` &
  related), normalized models (`NormalizedHttpRequest`, `YandexFunctionHttpResponse`,
  `QueueBatch`, `QueueMessage<T>`, `QueueEventMetadata`, `QueueMessageAttribute`),
  `QueueBodyDeserializer`, `HasRaw`, `YandexExecutionContext`, decorator signatures and
  `ConnectorErrorCode` / `ConnectorErrorDetail`.

Everything else is internal:

- all modules not re-exported there — adapters, dispatch pipelines, detection loops,
  invocation scope, body-deserialization mechanics, `src/testing/**`;
- deep import paths such as `@ycforge/ycsf-nestjs-connector/dist/...`. The `exports` map
  in `package.json` exposes only the `"."` subpath, so resolvers reject deep imports at
  runtime (`ERR_PACKAGE_PATH_NOT_EXPORTED`) and at type level. **Deep imports are
  unsupported and must never be relied upon**;
- anything reachable only through implementation details of internal modules.

Rules for changing the surface:

1. Exports are added deliberately, one explicit `export { … } from "…"` line each — no
   wildcard barrels, no whole-module re-exports.
2. Every export must be listed in ARCHITECTURE.md §7, pinned in `src/index.spec.ts`
   (runtime values) and mirrored in `EXPECTED_RUNTIME_EXPORTS` of
   `scripts/validate-package.mjs`.
3. New public functionality ships together with package-contract tests proving the packed
   tarball exposes it (§10).
4. Public types/interfaces/decorators carry deliberate JSDoc documenting their contract,
   including evidence level for raw shapes.

## 2. Semantic versioning

The package follows semver. One change classifies as exactly one of:

### Patch release (bug/security fix preserving the documented contract)

- fixing behavior that contradicted this documentation or ARCHITECTURE.md;
- performance improvements without observable contract changes;
- internal refactoring with identical public behavior;
- security fixes that tighten redaction or validation without changing documented
  success/failure outcomes.

### Minor release (additive, non-breaking)

- new exports on `src/index.ts` (new option fields, new optional members, new decorators,
  new stable error codes);
- new transports registered behind the existing SPI (§9);
- support for newly observed additive Yandex fields surfaced as _new, additively named_
  normalized fields while old fields stay untouched (§3);
- widening accepted inputs where previously rejected input was undocumented behavior.

### Major release (breaking)

Any of these requires a major version:

- removing or renaming an export, type member, decorator, parameter position, or generic
  default that consumers can compile against;
- narrowing or changing the TypeScript type of a public contract (including tightening
  `unknown` to something narrower in a way that rejects previously valid code);
- changing a handler signature, decorator injection semantics, or the shape of a
  normalized model (`NormalizedHttpRequest`, `QueueBatch`, `QueueMessage<T>`,
  `YandexExecutionContext`) beyond additive extension;
- changing guaranteed connector behavior: detection discriminators, failure classes,
  error-code meanings, response-envelope serialization rules, redaction placeholders,
  lifecycle guarantees (cold/warm/close), or DI scoping behavior per queue message;
- removing or renaming a stable `ConnectorError` code otherwise than through the
  deprecation procedure (§8);
- changing documented deserialization policy defaults (strict JSON, memoized payload,
  verbatim attribute strings).

**Observed vs formally documented:** raw shapes are recorded because Yandex sends them
(_observed_), not because the connector promises them. If Yandex stops sending an observed
field, or sends it with different content, the connector updates the raw types and fixture
evidence in a minor release — that is tracking reality, not breaking a promise. By
contrast, once a behavior is promoted into the _normalized_ public models or documented
connector semantics, it becomes a guarantee, and changing it follows the major-release
rules above regardless of what Yandex does.

Pre-1.0 note: until the first stable major release the same discipline is applied
best-effort, but consumers should expect the surface to settle; every intentional break is
called out prominently in release notes even where semver would technically permit more.

## 3. Yandex Cloud runtime compatibility

Yandex owns the wire format; the connector adapts to it. Policy:

- **Additive fields are tolerated without a release.** Raw interfaces carry explicit
  `[key: string]: unknown` index signatures, and normalized models expose the untouched
  source under `raw`. A new field appearing in events or contexts therefore stays
  reachable through raw access immediately and requires no connector update; nothing may
  reject unknown additive fields merely because they were absent from older captures
  (AGENTS.md §36).
- **Promotion of new fields is minor, never silent.** When a previously unknown field
  becomes worth exposing in a normalized model, it is added under a new name alongside the
  existing ones (the `memoryLimitInMB` string precedent: a numeric accessor would be added
  as a separate field rather than replacing the string).
- **Incompatible wire-shape changes are isolated.** If Yandex alters an existing field's
  meaning or structure in a way the current normalized contract cannot represent, the
  owning transport adapter is the only place allowed to know about it; the change is
  handled there, documented here and in DATA-ANALYSE.md, covered by a regression fixture,
  and any unavoidable normalized-contract impact is classified per §2.
- **Detection stays structural.** Transport discriminators remain cheap structural checks
  over observed fingerprints; they do not grow dependencies on incidental capture details.

## 4. Raw vs normalized contracts

Two families of public types exist and must never be conflated:

- **Raw types** (`RawHttpApiGatewayV2Event`, `RawQueueEvent`, the raw function context)
  are compatibility boundaries mirroring Yandex. Field names stay verbatim, including
  casing; unknown fields survive through index signatures; values pass through untouched.
  They are _observed_: faithful records, updated when the runtime changes.
- **Normalized models** (`NormalizedHttpRequest`, `QueueBatch`, `QueueMessage<T>`,
  `YandexExecutionContext`, the response envelope) are connector-controlled public
  contracts. Their shapes change only through explicit, versioned decisions.

Non-negotiable normalization rules (each pinned by tests and fixtures):

- transformation, never mutation of raw objects (AGENTS.md §7.3);
- no silent coercion of representations: `memoryLimitInMB` stays `string`; timestamps
  stay ISO strings; message-attribute values stay exact strings;
- both query-parameter views survive independently — comma-joined
  `queryStringParameters` and multiplicity-preserving `multiValueParameters` are never
  merged into one representation;
- canonical request identity comes from `rawPath`/`rawQueryString`, never reconstructed
  from `requestContext.http.path`;
- body encoding follows `isBase64Encoded`, not Content-Type guessing; binary data is
  never corrupted by string coercion;
- three payload levels stay distinct on queue messages: opaque `body`, normalized
  identity/metadata, and lazily decoded `payload`;
- diagnostics are separate from raw data: `safeDiagnostics` and the context's
  serialization guard define the safe view; raw escape hatches remain intentionally
  unsafe full-fidelity references.

Changing any distinction above is a breaking change under §2.

## 5. NestJS compatibility

- Current supported line: **NestJS 11** (`peerDependencies`: `@nestjs/common` `^11.0.0`,
  `@nestjs/core` `^11.0.0`). No compatibility with other majors is claimed or implied.
- The connector deliberately relies on documented-but-version-sensitive `@nestjs/core` 11
  internals. These are **compatibility boundaries**, recorded here so upgrades treat them
  explicitly:
  - bootstrapping through the framework transport SPI
    (`NestFactory.create` over an `AbstractHttpAdapter` subclass) instead of a platform
    HTTP server;
  - replaying the framework's own route/middleware proxies built during `app.init()`,
    including the route-string spellings `@nestjs/core` 11's `RouteInfoPathExtractor`
    produces (documented matching subset, ARCHITECTURE.md §4);
  - REQUEST-scoped resolution via `ContextIdFactory`-created context ids consumed by
    `NestApplicationContext.resolve` (verified against `@nestjs/core` 11).
- Upgrading to a newer NestJS major is a dedicated compatibility project: peer ranges are
  widened only after the full suite (unit, conformance fixtures, E2E lifecycles, packaged
  consumer checks) passes against the new major in CI. Silent widening of
  `peerDependencies` without that validation is prohibited.
- Framework behaviors the connector inherits (exception filters, interceptor/pipes/guards
  ordering, status defaults) follow whatever the supported NestJS major does; differences
  across majors are treated like any other compatibility boundary above.

## 6. Node.js compatibility

- Current supported runtime: **Node.js 22**. Declared support is the single source of
  truth chain: `engines.node` in `package.json` (`>=22`), development/CI pinning one
  reproducible 22.x minor via `.nvmrc`, CI resolving every workflow from that file, and
  this documentation — kept consistent by test.
- No other Node.js major is claimed as supported. Supporting another major requires CI
  validation on that major first; only then are `engines`, `.nvmrc` strategy and docs
  adjusted together.
- The published artifact is CommonJS with declaration files, loadable by the function
  runtime and standard Node.js toolchains; changes to module format are breaking.

## 7. Deprecation policy

- A public API is deprecated by marking it `@deprecated` in JSDoc (with guidance toward
  the replacement) and documenting the deprecation in release notes and, when the change
  affects usage patterns, in README/ARCHITECTURE.
- Deprecated APIs keep working for at least one full minor release cycle before removal;
  removal happens only in a major release.
- Silent behavioral replacement is prohibited: an API does not keep its name while its
  documented semantics change. Either the old API keeps its behavior (fixes aside), or the
  change is a documented deprecation plus replacement, classified per §2.
- Internal code carries no deprecation ceremony — internals simply change.

## 8. Error taxonomy stability

- The five reserved `ConnectorError` codes — `UNKNOWN_INVOCATION_EVENT`,
  `INVALID_INVOCATION_EVENT`, `UNSUPPORTED_ROUTE_PATTERN`, `NO_QUEUE_HANDLER`,
  `QUEUE_BODY_DESERIALIZATION_FAILED` — are public diagnostic contracts. Applications
  branch on them; messages and diagnostic details are explicitly not contracts.
- Adding a new stable code is minor. Removing or renaming an existing code is breaking
  unless the deprecated code keeps working through the §7 procedure first.
- Application exceptions are **not** part of the taxonomy: they never become
  `ConnectorError`s, are never wrapped or converted, and reach HTTP responses through
  NestJS machinery or MQ invocations verbatim. Connector releases cannot break
  applications through application-error handling, and application errors cannot gain
  connector-taxonomy codes.
- The boundary rule is fixed: `error instanceof ConnectorError` identifies expected
  boundary failures raised by this package; everything else escaping an invocation
  originates in application (or custom-strategy) code.

## 9. Future transports

- New transports (e.g., Object Storage or other triggers) implement the existing internal
  `TransportAdapter` SPI, extend the `TransportId` union in its single registration point,
  and join the core's ordered detection registry. Application-layer code does not change.
- A new transport must not alter HTTP or Message Queue semantics: no shared behavior
  between transports, no cross-transport knowledge, no changes to the other transports'
  normalized models, detection order or failure mapping.
- Transport-specific concepts stay inside the transport's adapter and its normalized
  models; they never leak into the core or the application layer.
- Public API additions a transport needs (new types, options, decorators) follow §1 and
  ship with package-contract tests per §10.

## 10. Package artifact compatibility

- Consumers are validated against the built declarations and the real npm tarball, not the
  source tree: `npm run package:check` packs, installs and consumes the artifact standalone
  — entry-point exports at runtime and type level, deep-import rejection at both levels,
  and a representative compile of the public contract surface.
- `scripts/validate-package.mjs` (and `src/index.spec.ts` /
  `EXPECTED_RUNTIME_EXPORTS`) must be updated whenever the public surface or package layout
  changes; a surface change that passes packaging validation unchanged is suspect.
- Published contents remain `dist/**` build output plus metadata only: sources, tests,
  fixtures, replay tooling and local configuration never ship. `src/testing/**`
  (fixture loader, replay helper/CLI) stays out of the production artifact unless
  deliberately promoted through §1's process.
- Package metadata agrees with this document: engines/peers/files/exports are pinned by
  `src/packaging.spec.ts`, the declared runtime matrix below is pinned by
  `src/compatibility.spec.ts`.

### Supported environment matrix

| Target  | Declared support                                                                         | Enforced by                                             |
| ------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Node.js | `engines`: `node >=22`; development and CI pin one 22.x minor through `.nvmrc`           | `package.json`, `.nvmrc`, CI workflows, packaging specs |
| NestJS  | peers: `@nestjs/common` `^11.0.0`, `@nestjs/core` `^11.0.0`                              | `package.json`, packaging specs                         |
| Module  | CommonJS entry `dist/index.js`, types `dist/index.d.ts`, single `.` subpath in `exports` | `package.json`, `validate-package.mjs`                  |
