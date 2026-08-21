# AGENTS.md

## 1. Purpose and scope

This repository contains `@ycforge/ycsf-nestjs-connector`, a TypeScript package that adapts NestJS applications to Yandex Cloud Functions.

The package has two primary transport modes:

1. **HTTP / API Gateway**

    * Yandex API Gateway payload format `2.0`.
    * Synchronous request/response semantics.
    * NestJS controllers and the normal NestJS HTTP programming model.

2. **Yandex Message Queue**

    * Yandex Cloud Functions Message Queue trigger.
    * Asynchronous invocation semantics.
    * Message handlers implemented using NestJS abstractions.

The fundamental architectural principle is:

> The package is a thin runtime/transport adapter. It must not turn NestJS into a Yandex-specific application framework.

Business logic must remain independent of Yandex Cloud whenever practical.

This document is authoritative for AI agents working in this repository unless a more specific repository document explicitly overrides it.

---

# 2. Working principles

## 2.1 Read before changing

Before modifying code, inspect:

* `package.json`
* `tsconfig*.json`
* lint configuration
* test configuration
* GitHub Actions workflows
* existing source tree
* existing tests
* public exports
* relevant documentation
* related issues and pull requests when available

Do not assume that an existing implementation is correct merely because it exists.

Do not introduce a new architecture when the repository already has an established pattern unless there is a concrete reason to do so.

---

## 2.2 Make the smallest coherent change

Prefer:

* small modules;
* explicit types;
* narrow responsibilities;
* deterministic behavior;
* isolated changes;
* tests colocated with or clearly associated with the code being changed.

Do not mix unrelated refactoring into a feature or bug-fix change.

Do not reformat unrelated files.

Do not rename public APIs merely for style reasons.

Do not introduce abstractions solely because they "might be useful later".

---

## 2.3 Evidence over assumptions

Yandex Cloud runtime behavior must be treated as an external contract that requires verification.

When implementation behavior is based on observed runtime data, documentation, or both, distinguish:

* `observed`
* `documented`
* `inferred`
* `unknown`

Do not invent fields.

Do not silently normalize away information that may be significant to consumers.

When a behavior is not known, preserve the raw data where possible and document the uncertainty.

---

# 3. Project architecture

The conceptual architecture is:

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
              +-------------+-------------+
              |                           |
        HTTP transport              Queue transport
              |                           |
              +-------------+-------------+
                            |
                     NestJS runtime
```

The central runtime entry point is conceptually:

```ts
createYandexHandler(AppModule)
```

The exact public API may evolve, but the architecture must preserve these boundaries.

## 3.1 Core responsibilities

The core runtime is responsible for:

* bootstrapping NestJS;
* caching the application for warm invocations;
* routing invocations to the correct transport;
* maintaining invocation-scoped context;
* exposing raw event/context escape hatches;
* propagating failures correctly.

## 3.2 HTTP transport responsibilities

The HTTP adapter is responsible for translating Yandex API Gateway v2 events into NestJS HTTP semantics and translating NestJS HTTP responses back into the Yandex Function response shape.

## 3.3 Message Queue responsibilities

The Message Queue adapter is responsible for:

* detecting MQ invocation events;
* normalizing queue messages;
* dispatching messages to NestJS handlers;
* preserving queue metadata;
* preserving message attributes;
* preserving raw message bodies;
* propagating handler failures so queue retry semantics remain correct.

## 3.4 Decorators

The package may expose NestJS-native decorators such as:

```ts
@YandexContext()
@QueueHandler()
@QueueMessage()
```

Decorators must remain thin metadata/injection mechanisms.

Do not build a second dependency-injection system.

---

# 4. Runtime facts that must be preserved

The following runtime behavior was experimentally observed and must not be accidentally changed.

## 4.1 HTTP event

The observed HTTP event has this shape:

```ts
interface HttpEventV2 {
  version: "2.0";
  rawPath: string;
  rawQueryString: string;

  headers: Record<string, string>;

  queryStringParameters: Record<string, string>;

  requestContext: {
    authorizer: Record<string, unknown>;

    http: {
      method: string;
      path: string;
      sourceIp: string;
      userAgent: string;
    };

    requestId: string;
    time: string;
    timeEpoch: number;

    apiGateway?: {
      operationContext?: Record<string, unknown>;
    };
  };

  body: string;

  isBase64Encoded: boolean;

  pathParameters: Record<string, string>;

  parameters: Record<string, string>;

  multiValueParameters: Record<string, string[]>;

  operationId: string;
}
```

Do not assume that this type will remain exhaustive forever.

Unknown fields must not be discarded.

---

## 4.2 HTTP canonical path/query handling

Use:

```text
rawPath
rawQueryString
```

as the canonical representation of the original HTTP request.

Do not reconstruct the original request URI from:

```text
requestContext.http.path
```

Observed behavior shows that `requestContext.http.path` can:

* reorder query parameters;
* append a trailing `?`;
* normalize data differently from the original URI.

Encoded path characters may also behave differently from ordinary decoded paths.

---

## 4.3 HTTP repeated parameters

Observed behavior:

```text
queryStringParameters
```

contains repeated query values as comma-separated strings.

Example:

```text
?multi=one&multi=two&multi=three
```

may become:

```ts
queryStringParameters.multi === "one,two,three"
```

whereas:

```text
multiValueParameters.multi
```

contains:

```ts
["one", "two", "three"]
```

Do not silently convert these two representations into one another.

---

## 4.4 HTTP body encoding

Observed behavior:

```text
Content-Type: application/json
    -> body is plain UTF-8 text
    -> isBase64Encoded === false

other content types
    -> body is Base64
    -> isBase64Encoded === true
```

This includes:

* plain text;
* forms;
* binary payloads;
* missing content type;
* empty-body requests.

The adapter must rely on:

```ts
event.isBase64Encoded
```

rather than guessing based on `Content-Type`.

Binary data must not be corrupted.

---

## 4.5 HTTP headers

Headers are observed as:

```ts
Record<string, string>
```

not arrays.

Do not invent `multiValueHeaders` support unless the runtime actually provides it.

Some headers are injected by the gateway, including tracing and request metadata.

Client-provided sensitive values may include:

* `Authorization`
* `Cookie`

These must be treated as sensitive in logging and diagnostics.

---

## 4.6 Message Queue event

The observed structure is:

```ts
interface QueueEvent {
  messages: QueueMessageEvent[];
}
```

A message is conceptually:

```ts
interface QueueMessageEvent {
  event_metadata: {
    event_id: string;
    event_type: string;
    created_at: string;
    tracing_context: unknown;
    cloud_id: string;
    folder_id: string;
  };

  details: {
    queue_id: string;

    message: {
      message_id: string;
      md5_of_body: string;
      body: string;

      attributes: Record<string, string>;

      message_attributes: Record<string, {
        data_type: string;
        string_value: string;
      }>;

      md5_of_message_attributes: string;
    };
  };
}
```

Do not hard-code the current trigger configuration of one grouped message into the library's internal domain model.

The trigger currently has a grouped-message limit of `1`, but the event contract is an array.

The package must remain batch-capable internally.

---

# 5. Context model

The package should expose a normalized `YandexExecutionContext`.

Observed runtime fields include:

```text
awsRequestId
functionName
functionVersion
functionFolderId
memoryLimitInMB
deadlineMs
logGroupName
token
uberTraceId
_data
```

Important:

* `memoryLimitInMB` is observed as a string.
* `deadlineMs` is an epoch-millisecond number.
* `token` is sensitive.
* `_data` is an internal runtime duplicate of the event and should not be treated as a stable public API unless explicitly documented.

Do not silently coerce runtime values merely because another representation would be more convenient.

For example, do not automatically convert:

```ts
memoryLimitInMB: "1024"
```

to:

```ts
memoryLimitInMB: 1024
```

unless the public abstraction explicitly defines a normalized numeric field while retaining access to the raw context.

---

# 6. Security rules

Security takes precedence over convenience.

## 6.1 Never commit secrets

Never commit:

* IAM tokens;
* access keys;
* secret keys;
* authorization headers;
* cookies;
* `.env` files containing credentials;
* cloud credentials;
* captured production secrets.

If a fixture contains credentials, sanitize it before committing.

---

## 6.2 Logging

Never log the following by default:

```text
context.token
Authorization
Cookie
```

Also avoid logging raw client IP information unless explicitly required.

When creating diagnostics, prefer redaction.

---

## 6.3 Test fixtures

Captured Yandex events may contain sensitive values.

Fixtures must be sanitized before being committed to Git.

Use deterministic placeholders, e.g.:

```text
REDACTED_TOKEN
REDACTED_AUTHORIZATION
REDACTED_COOKIE
203.0.113.10
```

Do not use real access credentials even temporarily in committed history.

If a secret is accidentally committed:

1. stop;
2. remove it from the working tree;
3. notify the maintainer;
4. assume it is compromised;
5. rotate the secret;
6. rewrite history if necessary.

Do not merely delete the line in a later commit and assume the secret is gone.

---

# 7. TypeScript rules

## 7.1 Strict typing

Use strict TypeScript.

Avoid:

```ts
any
```

unless there is a documented interoperability reason.

Prefer:

```ts
unknown
```

and explicit narrowing.

Do not use unsafe casts merely to satisfy the compiler.

Avoid:

```ts
foo as SomeType
```

unless the runtime invariant is demonstrated or explicitly documented.

---

## 7.2 Public APIs must be explicitly typed

Every exported function, class, decorator and public interface must have deliberate types.

Do not infer complicated public contracts accidentally from implementation details.

Public types should not expose private helper types unnecessarily.

---

## 7.3 Raw runtime types vs normalized types

Keep a distinction between:

```text
raw Yandex event
```

and:

```text
normalized application-level representation
```

Do not mutate raw event objects to turn them into normalized domain objects.

Prefer transformation:

```text
raw -> normalized
```

over mutation:

```text
raw -> mutate raw
```

---

# 8. Error handling

Errors must preserve transport semantics.

## 8.1 HTTP

HTTP exceptions should ultimately become HTTP responses.

The exact error response shape should be deliberate and documented.

Do not accidentally expose stack traces or internal implementation details to clients in production mode.

---

## 8.2 Message Queue

Queue handler failures must propagate.

Do not do this:

```ts
try {
  await handler();
} catch {
  return;
}
```

unless an explicit acknowledgement/retry policy says otherwise.

A failed message should remain a failed invocation so Yandex Message Queue can perform the configured retry/dead-letter behavior.

---

## 8.3 Unknown events

Unknown event types must fail clearly and diagnostically.

Do not silently treat an unknown event as HTTP.

Do not silently treat arbitrary objects containing `messages` as trusted Message Queue events without validation.

---

# 9. Input validation

Validation should occur at the transport boundary.

The adapter must validate enough structure to determine whether the invocation is:

* supported HTTP API Gateway v2;
* supported Message Queue;
* unknown/invalid.

Validation must be:

* deterministic;
* cheap;
* explicit;
* testable.

Do not add heavy runtime validation libraries merely to validate a few top-level discriminators unless complexity justifies it.

---

# 10. NestJS lifecycle

## 10.1 Cold start

The connector may initialize the Nest application during the first invocation.

## 10.2 Warm invocation

The connector must reuse the initialized application.

Do not bootstrap Nest on every invocation.

## 10.3 Concurrent cold starts

Application initialization must be race-safe.

Do not permit two concurrent invocations to accidentally create two separate application instances from a shared module-level state.

Use a shared initialization promise or equivalent safe mechanism.

---

# 11. Invocation isolation

Invocation-scoped data must never leak between requests.

Never store:

```ts
currentEvent
currentContext
currentMessage
currentRequest
```

in singleton state unless they are explicitly scoped to the invocation and safely isolated.

A warm Lambda/serverless process survives multiple invocations.

Tests must explicitly verify that data from invocation N does not appear in invocation N+1.

---

# 12. Code style

## General

Prefer clarity over cleverness.

Prefer explicit names.

Avoid unnecessary nesting.

Avoid giant functions.

Avoid magic constants.

Use early returns where they improve readability.

Keep transport adapters small enough that their responsibilities are obvious.

---

## Naming

Use:

* `PascalCase` for classes/interfaces/types;
* `camelCase` for functions/variables/properties;
* `UPPER_SNAKE_CASE` only for true constants/configuration constants;
* descriptive names for adapters and normalized models.

Avoid cryptic names:

```ts
ctx
evt
msg
tmp
obj
data2
```

unless the scope is extremely small and obvious.

Prefer:

```ts
event
context
message
normalizedRequest
executionContext
```

---

## Imports

Prefer deterministic import ordering.

Remove unused imports.

Do not leave imports commented out.

Use package aliases only when they are configured and consistently used.

---

## Functions

Functions should generally do one thing.

A function that:

* validates an event;
* normalizes an event;
* initializes Nest;
* executes a handler;
* serializes a response;

is doing too much.

Split responsibilities.

---

# 13. Comments

Comments must explain why, not what.

Bad:

```ts
// Increment i
i++;
```

Good:

```ts
// API Gateway v2 exposes repeated query parameters through
// multiValueParameters; preserve that representation instead of
// losing multiplicity during normalization.
```

Do not write comments that merely repeat the code.

Do add comments around:

* Yandex runtime quirks;
* compatibility workarounds;
* non-obvious lifecycle behavior;
* security-sensitive logic;
* intentionally preserved strange behavior.

When behavior is based on an observed Yandex quirk, say so.

---

# 14. Testing policy

Every behavioral change requires tests.

A PR is incomplete if it changes behavior without updating relevant tests.

## 14.1 Unit tests

Unit-test:

* event detection;
* event validation;
* HTTP normalization;
* query handling;
* repeated query parameters;
* header handling;
* path parameter handling;
* body decoding;
* response serialization;
* context normalization;
* MQ normalization;
* message attributes;
* error behavior;
* decorator metadata;
* dispatch logic.

---

## 14.2 Integration tests

Integration tests must exercise the public connector API with a small NestJS application.

At minimum test:

```text
HTTP event
    -> Nest controller
    -> HTTP response

MQ event
    -> queue handler
    -> successful invocation

MQ event
    -> queue handler exception
    -> failed invocation
```

---

## 14.3 Regression fixtures

Use real sanitized Yandex event fixtures where practical.

Every discovered runtime quirk that affects behavior should become a regression test.

Important examples include:

* repeated query parameters;
* `rawPath`;
* `rawQueryString`;
* unusual encoded path values;
* Base64 body;
* empty bodies;
* Unicode;
* MQ message attributes;
* MQ metadata;
* context shape.

---

## 14.4 Test names

Tests must describe behavior.

Prefer:

```text
decodes a base64 encoded API Gateway body
```

over:

```text
test body
```

Prefer:

```text
preserves repeated query parameters in multiValueParameters
```

over:

```text
query params
```

---

# 15. Testing captured Yandex events

When adding a captured fixture:

1. Remove credentials and sensitive data.
2. Preserve relevant structure.
3. Preserve unusual values that triggered the bug/behavior.
4. Name the fixture after its behavior.
5. Add a test explaining why the fixture matters.

Do not replace a useful regression fixture with a simplified synthetic object unless the original fixture is genuinely unnecessary.

---

# 16. Linting and formatting

The repository must have one canonical lint/format configuration.

Developers and AI agents must use repository-provided commands rather than inventing alternate commands.

Before submitting a PR:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

If the project does not yet have one of these scripts, add it as part of the tooling work instead of silently assuming it exists.

Do not suppress lint rules inline unless:

1. there is a real technical reason;
2. the suppression is as narrow as possible;
3. a comment explains why.

Never disable a project-wide lint rule just to make one change compile.

---

# 17. Dependency policy

Before adding a dependency, ask:

1. Is the functionality small enough to implement locally?
2. Is the dependency maintained?
3. Does it increase package size significantly?
4. Does it introduce runtime dependencies unnecessarily?
5. Is it compatible with Node.js 22?
6. Is it compatible with supported NestJS versions?
7. Is the dependency needed at runtime or only development time?

Avoid adding dependencies for trivial utilities.

Runtime dependencies should be kept minimal.

---

# 18. API design policy

The public API should be small.

Prefer:

```text
createYandexHandler
YandexExecutionContext
@YandexContext
@QueueHandler
@QueueMessage
```

over dozens of exported helper classes.

Do not export internal adapter implementation details merely because they are technically accessible.

An API should be public because consumers need it, not because the implementation happens to use it.

---

# 19. Backward compatibility

The package follows semantic versioning.

Breaking changes require a major version.

Additive functionality should normally be a minor version.

Bug fixes should normally be a patch version.

Never silently change the normalized behavior of an existing public API because the new behavior seems "cleaner".

If Yandex runtime behavior is strange but observable and relied upon, preserve it unless there is an explicit compatibility decision.

---

# 20. Git workflow

## 20.1 Branches

Never develop directly on `main`.

Use a branch named approximately:

```text
feat/<short-name>
fix/<short-name>
refactor/<short-name>
test/<short-name>
docs/<short-name>
chore/<short-name>
```

Example:

```text
feat/http-api-gateway-adapter
fix/mq-error-propagation
test/http-event-fixtures
```

---

## 20.2 One issue per coherent change

A branch should normally correspond to one GitHub issue.

Do not combine unrelated issues.

If implementation reveals that the issue is too large, stop and split the work rather than producing one enormous PR.

---

## 20.3 Commits

Commits should be:

* small;
* logically coherent;
* buildable whenever practical;
* easy to review;
* easy to revert.

Preferred format:

```text
type(scope): short imperative description
```

Examples:

```text
feat(http): add API Gateway v2 request normalization
fix(mq): propagate handler failures
test(http): add repeated query parameter fixtures
refactor(core): isolate invocation lifecycle
docs(readme): document queue handler usage
```

Do not create commits such as:

```text
fix
changes
wip
stuff
updates
```

Avoid meaningless formatting-only commits.

---

## 20.4 Commit content

A commit should represent one logical step.

Good:

```text
feat(context): add normalized execution context
```

followed by:

```text
test(context): cover context injection
```

Avoid a giant commit containing:

* architecture changes;
* unrelated formatting;
* tests;
* documentation;
* CI changes;
* dependency upgrades.

---

## 20.5 Before committing

Run at minimum:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

If a command does not exist yet, use the repository's actual equivalent.

Do not knowingly create a commit with failing tests.

---

# 21. Pull request policy

Every implementation change should go through a pull request unless the repository maintainer explicitly permits otherwise.

A PR should contain:

## Summary

What changed.

## Motivation

Why it changed.

## Implementation

How it works.

## Tests

Exactly what was executed.

## Compatibility

Whether public API behavior changed.

## Risks

Any known risks or Yandex-specific assumptions.

---

# 22. PR size

Prefer small PRs.

A PR should ideally answer one question:

> What coherent behavior does this PR add or change?

Avoid mixing:

```text
HTTP adapter
MQ adapter
CI rewrite
README rewrite
dependency migration
formatting
```

into one PR.

---

# 23. PR review requirements

Before requesting review:

* all tests pass;
* lint passes;
* typecheck passes;
* build passes;
* no secrets are present;
* public exports are intentional;
* documentation is updated where behavior changed;
* tests cover the changed behavior;
* no unrelated files are modified.

AI agents must inspect the final diff before declaring completion.

---

# 24. CI/CD

The repository should maintain a GitHub Actions pipeline covering:

```text
install
  ↓
lint
  ↓
typecheck
  ↓
unit tests
  ↓
integration/conformance tests
  ↓
build
  ↓
package validation
```

PRs must execute the relevant checks automatically.

Main branch must not accept a change that bypasses required quality checks.

Release automation should:

1. build from a clean checkout;
2. run all tests;
3. validate package contents;
4. publish only intended files;
5. use protected publishing credentials;
6. avoid printing secrets.

Do not add release automation that publishes arbitrary working-tree contents.

---

# 25. Package contents

The published npm package should contain only what consumers need.

Do not publish:

* test fixtures;
* local datasets;
* captured event archives;
* development scripts that are not required;
* source snapshots unless deliberately part of the package;
* secrets;
* local configuration;
* `.env` files.

Use package validation before releases.

---

# 26. Documentation requirements

When adding public functionality, update documentation in the same PR.

Document:

* what it does;
* how to import it;
* how to use it;
* failure behavior;
* relevant configuration;
* limitations;
* Yandex-specific behavior where applicable.

Do not document behavior that has not been verified.

---

# 27. AI agent workflow

AI agents must follow this order unless an issue explicitly requires another sequence:

### Step 1 — Inspect

Read:

* repository instructions;
* issue;
* existing implementation;
* related tests;
* package configuration.

### Step 2 — Understand

Identify:

* current behavior;
* desired behavior;
* constraints;
* public APIs involved;
* potential compatibility issues.

### Step 3 — Plan internally

Break work into the smallest implementation steps.

Do not modify files before understanding the surrounding code.

### Step 4 — Implement

Make the smallest coherent change.

### Step 5 — Test

Add or update tests before declaring the issue complete.

### Step 6 — Validate

Run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

or repository equivalents.

### Step 7 — Inspect diff

Run:

```bash
git status
git diff
git diff --check
```

Look specifically for:

* accidental formatting;
* debug code;
* secrets;
* unrelated changes;
* generated files;
* API changes not reflected in tests.

### Step 8 — Commit

Create a focused commit with a meaningful message.

### Step 9 — Push

Push the branch.

### Step 10 — Pull request

Open a PR referencing the issue.

### Step 11 — Review feedback

When review changes are required:

* address the actual comment;
* update tests;
* re-run all relevant checks;
* do not weaken tests merely to make them pass.

---

# 28. AI agent prohibitions

An AI agent must not:

* rewrite unrelated modules;
* silently change public APIs;
* add dependencies without justification;
* skip tests because a change appears trivial;
* disable lint rules to bypass errors;
* ignore TypeScript errors;
* swallow exceptions in MQ handlers;
* expose credentials in logs;
* commit captured secrets;
* modify CI merely to make a build green without understanding the failure;
* fabricate Yandex behavior;
* claim tests were run when they were not;
* claim a runtime behavior is documented when it was only inferred.

---

# 29. Handling uncertainty

When implementation depends on an uncertain Yandex behavior:

1. preserve raw data;
2. avoid destructive normalization;
3. write a test demonstrating the currently observed behavior;
4. document the uncertainty;
5. isolate the assumption in a small adapter layer.

Do not spread one uncertain assumption across the entire codebase.

---

# 30. Transport separation rules

HTTP and MQ must remain separate at the transport boundary.

Do not introduce code such as:

```ts
if (event.messages) {
  // queue
} else {
  // everything else
}
```

throughout the application.

Event detection should happen once near the runtime boundary.

After detection, the application receives a typed abstraction appropriate to the transport.

HTTP code must not depend on MQ internals.

MQ code must not depend on HTTP response semantics.

---

# 31. HTTP-specific implementation rules

Use the observed API Gateway v2 semantics.

Prefer:

```ts
rawPath
rawQueryString
```

for canonical URI representation.

Respect:

```ts
isBase64Encoded
```

for body decoding.

Do not automatically parse form bodies.

Do not silently convert all bodies to JSON.

Do not invent `multiValueHeaders`.

Do not assume `parameters` contains every incoming parameter.

---

# 32. Message Queue-specific implementation rules

Treat the incoming message body as an opaque string at the transport boundary.

Deserialization is a separate concern.

Do not assume:

```ts
message.body
```

is valid JSON.

Do not lose:

* `message_id`;
* `md5_of_body`;
* `attributes`;
* `message_attributes`;
* `md5_of_message_attributes`;
* `queue_id`;
* event metadata.

Do not hard-code one-message invocations into the public domain model.

---

# 33. Observability

The connector should expose enough metadata for applications to correlate invocations.

At minimum, normalized context should make the invocation/request ID easily accessible.

Tracing information should be preserved rather than discarded.

Do not introduce an opinionated tracing SDK unless explicitly required.

A connector should expose information; an application decides whether and how to instrument it.

---

# 34. Performance

This package runs in a serverless environment.

Performance-sensitive areas include:

* Nest bootstrap;
* dependency graph creation;
* repeated serialization/deserialization;
* unnecessary object copying;
* excessive runtime validation;
* large fixture processing.

Prioritize:

1. correctness;
2. deterministic behavior;
3. security;
4. then optimization.

Do not optimize based on guesses.

When optimizing, add a benchmark or demonstrate the measurable issue.

---

# 35. Cold start discipline

Do not:

* perform unnecessary network requests during module import;
* initialize large data structures eagerly without reason;
* recreate configuration repeatedly;
* rebuild Nest per invocation;
* repeatedly parse static configuration that can safely be cached.

At the same time, do not cache invocation-specific state.

---

# 36. Compatibility with future Yandex changes

Yandex may add new fields to events or context.

The connector should generally tolerate additive fields.

For example, if:

```ts
event.someFutureField
```

appears, the connector should not fail merely because the field was unknown.

Unknown data should remain accessible through raw event/context access.

Breaking changes to the normalized connector API must be deliberate and versioned.

---

# 37. Definition of Done

An issue is not complete merely because the code compiles.

It is done when all applicable criteria are satisfied:

* implementation is complete;
* public API is deliberate;
* tests exist;
* regression cases are covered;
* lint passes;
* typecheck passes;
* tests pass;
* build passes;
* documentation is updated where needed;
* no secrets are present;
* diff is reviewed;
* no unrelated changes remain;
* commit is focused;
* PR references the issue.

---

# 38. Final verification checklist

Before declaring a task complete, an AI agent should verify:

```text
[ ] I read the issue and repository instructions.
[ ] I inspected the existing implementation.
[ ] I understood the transport boundary.
[ ] I changed only files relevant to the task.
[ ] I added/updated tests.
[ ] I preserved existing public behavior unless the issue requires a change.
[ ] I did not invent Yandex runtime behavior.
[ ] I did not leak credentials.
[ ] I ran lint.
[ ] I ran typecheck.
[ ] I ran tests.
[ ] I ran build.
[ ] I ran git diff --check.
[ ] I inspected the final git diff.
[ ] I created a focused commit.
[ ] I referenced the relevant issue in the PR.
```

The agent must not report success if any required verification was skipped.
