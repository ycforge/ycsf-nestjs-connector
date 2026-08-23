# Local invocation and replay (issue #12)

The repository ships a local replay tool that executes the sanitized
conformance fixtures (`fixtures/http/*.json`, `fixtures/mq/*.json`) through the
**same public runtime entry point** used in production —
`createYandexHandler()` from the package root export — without any Yandex Cloud
connectivity. It exists for local development, debugging and regression
triage: any behavior change shows up as a different replay outcome.

The replay tooling lives under `src/testing/`, is covered by its own test
suites, is **not part of the published package** (excluded from `dist` and the
npm tarball), and adds no runtime dependencies.

## What it does

- Loads fixtures through the same loader the conformance suites use
  (`src/testing/invocation-fixtures.ts`), including its provenance validation:
  every fixture must declare `{ kind: "reconstructed", evidence }`.
- Feeds each fixture's raw `event`/`context` objects verbatim into
  `createYandexHandler(AppModule)` — no metadata injection, no mutation.
- Reports one outcome per fixture: HTTP replays resolve to the Yandex Function
  response envelope; Message Queue replays resolve to normalized batches.
  Failures (load errors, handler exceptions) are reported per fixture instead
  of aborting the run.

## Command line

```bash
npm run replay -- --http get-without-query --mq simple-text-message
```

Options:

| Option                  | Effect                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `--http <name-or-path>` | Replay one HTTP fixture by name or by path to a fixture JSON file                      |
| `--mq <name-or-path>`   | Replay one MQ fixture by name or by path to a fixture JSON file                        |
| `--http-all`            | Replay every committed HTTP fixture                                                    |
| `--mq-all`              | Replay every committed MQ fixture                                                      |
| `--module <path>`       | Load a NestJS module from a compiled JS file instead of the built-in probe application |
| `--help`                | Print usage                                                                            |

Exit codes: `0` — all selected fixtures succeeded; `1` — at least one replay
or load failure (also when nothing matched); `2` — usage error or unreadable
`--module`.

Output lines are deliberately value-free (`ok http name -> 200`,
`fail mq name -> Error: ...`) followed by a summary line, so they are safe to
paste into issues even though fixtures contain only sanitized placeholders.

### Default probe application

Without `--module`, replays run against `ReplayAppModule`
(`src/testing/replay-app.ts`): an HTTP catch-all that echoes structural facts
of the invocation (method, path, request id, query parameter names, header
count, body byte length) and a no-op MQ consumer. It contains no business
logic and returns no event values, keeping CLI output free of fixture data.

### Custom applications

Point `--module` at a compiled JS file exporting `AppModule` (or `appModule`
or a default export):

```bash
npx tsc -p tsconfig.json
node .tools/testing/replay-cli.js --module ./dist/my-app.module.js --mq json-body-message
```

Failure semantics match production exactly: mapped HTTP exceptions surface as
their response envelope (and count as successful invocations), unexpected HTTP
failures become opaque 500 envelopes, MQ handler failures fail the replay with
the verbatim error so queue retry semantics remain observable.

## Programmatic API

For tests and scripts, `src/testing/replay.ts` exposes:

```ts
import { createReplaySession, replayHttpFixture } from "./testing/replay";

// One warm Nest application across many replays:
const session = createReplaySession(MyModule);
try {
  const outcome = await session.replay({
    fixtureName: "my-scenario",
    event: myEvent,
    context: myContext,
  });
} finally {
  await session.close();
}

// One-shot helper (loads fixture + session + replay):
const loaded = await replayHttpFixture(MyModule, "repeated-query-parameters");
// loaded.fixture — the full InvocationFixture record
// loaded.ok / loaded.result / loaded.error
```

`createYandexHandler()` is imported through the public barrel (`src/index.ts`)
inside the helper, which is also asserted by tests: rerouting replay away from
the production entry point would fail the suite.

## Security notes

- The loader keeps re-redacting `context.token` on every read and validates
  the provenance stamp; malformed or non-reconstructed fixtures fail loudly.
- Fixtures contain only sanitized placeholders, but CLI output intentionally
  avoids echoing fixture values anyway; a test pins that sensitive placeholder
  values never appear in CLI output.
- Never point `--module` at code you do not trust: it is executed locally.
