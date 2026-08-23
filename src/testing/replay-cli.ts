import path from "node:path";
import type { Type } from "@nestjs/common";
import { ConnectorError } from "../index";
import {
  listHttpFixtureNames,
  listQueueFixtureNames,
  loadHttpFixture,
  loadHttpFixtureFile,
  loadQueueFixture,
  loadQueueFixtureFile,
} from "./invocation-fixtures";
import { createReplaySession, type FixtureReplayOutcome, type ReplaySession } from "./replay";
import { ReplayAppModule } from "./replay-app";

/**
 * Developer CLI around the replay helper (issue #12, development tooling —
 * NOT part of the published package). Replays sanitized reconstructed
 * fixtures through the public `createYandexHandler()` runtime; there is no
 * second runtime here either — the CLI only selects fixtures, prints concise
 * results and maps failures onto exit codes.
 *
 * Output is value-free: fixture names, transport kinds, status codes and
 * error messages only. Header values, cookies, bodies and client IPs of the
 * fixtures are never printed (AGENTS.md section 6.2); `ConnectorError`
 * diagnostics are value-free by construction.
 */

export const REPLAY_CLI_USAGE = `Usage: npm run replay -- [options]

Replays the sanitized reconstructed conformance fixtures under fixtures/
through the public createYandexHandler() runtime. No Yandex Cloud
connectivity, credentials or network access are involved.

Options:
  --http <name|file>   Replay one HTTP/API Gateway fixture by fixture name
                       (fixtures/http/<name>.json) or by .json file path.
  --mq <name|file>     Replay one Message Queue fixture by name or file path.
  --http-all           Replay every committed HTTP fixture.
  --mq-all             Replay every committed Message Queue fixture.
  --module <file>      Compiled JS module exporting the NestJS application
                       module class as "AppModule", "appModule" or default;
                       replays run against it instead of the built-in
                       value-free probe application.

Exit codes:
  0  every selected fixture replayed successfully
  1  at least one replay or fixture load failed
  2  usage or module-loading error`;

/** Thrown for invalid CLI input; mapped to exit code 2 by {@link runReplayCli}. */
export class ReplayCliUsageError extends Error {}

/** Transport a selection belongs to. */
export type ReplayFixtureKind = "http" | "mq";

/** One user-facing selection before expansion (`--http x` / `--mq y`). */
export interface ReplayCliSelection {
  readonly kind: ReplayFixtureKind;
  /** Fixture name (file stem) or explicit .json path, exactly as given. */
  readonly spec: string;
}

export interface ReplayCliPlan {
  readonly selections: readonly ReplayCliSelection[];
  readonly replayAllHttp: boolean;
  readonly replayAllMq: boolean;
  readonly modulePath: string | undefined;
}

/**
 * Parses argv into a plan. Throws {@link ReplayCliUsageError} on any invalid
 * input so callers control presentation and exit codes.
 */
export function parseReplayCliArgs(argv: readonly string[]): ReplayCliPlan {
  const selections: ReplayCliSelection[] = [];
  const seen = new Set<string>();
  let replayAllHttp = false;
  let replayAllMq = false;
  let modulePath: string | undefined;

  const addSelection = (kind: ReplayFixtureKind, spec: string): void => {
    if (!spec) {
      throw new ReplayCliUsageError(`--${kind} requires a fixture name or .json file path`);
    }
    const key = `${kind}:${spec}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    selections.push({ kind, spec });
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    switch (arg) {
      case "--http":
      case "--mq":
        addSelection(arg === "--http" ? "http" : "mq", argv[++index] ?? "");
        break;
      case "--http-all":
        replayAllHttp = true;
        break;
      case "--mq-all":
        replayAllMq = true;
        break;
      case "--module": {
        const value = argv[++index];
        if (!value) {
          throw new ReplayCliUsageError(
            "--module requires a path to a compiled JS module exporting AppModule",
          );
        }
        modulePath = value;
        break;
      }
      default:
        throw new ReplayCliUsageError(`unknown argument "${arg}" (see usage below)`);
    }
  }

  if (!replayAllHttp && !replayAllMq && selections.length === 0) {
    throw new ReplayCliUsageError(
      "nothing to replay: pass at least one --http/--mq fixture, --http-all or --mq-all",
    );
  }

  return { selections, replayAllHttp, replayAllMq, modulePath };
}

/** One expanded work item after directory/name resolution. */
export interface ReplayCliItem {
  readonly kind: ReplayFixtureKind;
  /** Display label: fixture stem for names, given specifier for paths. */
  readonly label: string;
  /** True when `label` is a bare fixture name inside fixtures/<kind>/. */
  readonly byName: boolean;
}

/** Result of one replayed item, ready for formatting. */
export interface ReplayCliRecord {
  readonly kind: ReplayFixtureKind;
  readonly label: string;
  readonly outcome: FixtureReplayOutcome;
  /** Concise value-free detail: status/method/path, batch size or error summary. */
  readonly detail: string;
}

/** Output sink injected for tests; defaults to the console. */
export interface ReplayCliIo {
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/** Seam replacing on-disk module loading in tests. */
export type LoadAppModule = (modulePath: string | undefined) => Type<unknown>;

const DEFAULT_IO: ReplayCliIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * Runs one CLI invocation and returns the process exit code:
 * `0` when every selected fixture replayed successfully, `1` when any replay
 * or fixture load failed, `2` for usage/module-loading errors. All items
 * share ONE warm handler created through the public runtime factory.
 */
export async function runReplayCli(
  argv: readonly string[],
  io: ReplayCliIo = DEFAULT_IO,
  deps: { readonly loadAppModule?: LoadAppModule } = {},
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    io.log(REPLAY_CLI_USAGE);
    return 0;
  }

  let plan: ReplayCliPlan;
  try {
    plan = parseReplayCliArgs(argv);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    io.error("");
    io.error(REPLAY_CLI_USAGE);
    return 2;
  }

  let appModule: Type<unknown>;
  try {
    appModule = resolveAppModule(plan.modulePath, deps.loadAppModule);
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const items: ReplayCliItem[] = [];
  items.push(...plan.selections.map((selection) => expandSelection(selection)));
  if (plan.replayAllHttp) {
    for (const name of await listHttpFixtureNames()) {
      items.push({ kind: "http", label: name, byName: true });
    }
  }
  if (plan.replayAllMq) {
    for (const name of await listQueueFixtureNames()) {
      items.push({ kind: "mq", label: name, byName: true });
    }
  }
  if (items.length === 0) {
    io.error("no fixtures matched the selection");
    return 1;
  }

  // One warm application for the whole run: sequential replays reuse it like
  // warm invocations of a deployed function (AGENTS.md section 10.2).
  const session = createReplaySession(appModule);
  try {
    let okCount = 0;
    let failCount = 0;
    for (const item of items) {
      const record = await replayItem(session, item);
      if (record.outcome.ok) {
        okCount++;
      } else {
        failCount++;
      }
      io.log(formatReplayRecord(record));
    }
    io.log("");
    io.log(`${okCount} ok, ${failCount} failed (${items.length} replayed)`);
    return failCount > 0 ? 1 : 0;
  } finally {
    await session.close();
  }
}

function resolveAppModule(modulePath: string | undefined, load?: LoadAppModule): Type<unknown> {
  if (load) {
    return load(modulePath);
  }
  if (modulePath) {
    return loadAppModuleFromDisk(modulePath);
  }
  return ReplayAppModule;
}

function loadAppModuleFromDisk(modulePath: string): Type<unknown> {
  const resolved = path.resolve(process.cwd(), modulePath);
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the compiled CLI is CommonJS; require() lets --module accept any built JS module
  const exported = require(resolved) as Record<string, unknown>;
  const candidate = exported["AppModule"] ?? exported["appModule"] ?? exported["default"];
  if (typeof candidate !== "function") {
    throw new ReplayCliUsageError(
      `module "${modulePath}" must export the NestJS application module class as "AppModule", "appModule" or default`,
    );
  }
  return candidate as Type<unknown>;
}

function expandSelection(selection: ReplayCliSelection): ReplayCliItem {
  // A spec counts as a path when it carries an extension or separator;
  // everything else is treated as a fixture name inside fixtures/<kind>/.
  const looksLikePath =
    selection.spec.endsWith(".json") ||
    selection.spec.includes("/") ||
    selection.spec.includes(path.sep);
  return { kind: selection.kind, label: selection.spec, byName: !looksLikePath };
}

async function replayItem(session: ReplaySession, item: ReplayCliItem): Promise<ReplayCliRecord> {
  const outcome = item.byName
    ? await replayNamedFixture(session, item)
    : await replayFixtureFile(session, item);
  return {
    kind: item.kind,
    label: item.label,
    outcome,
    detail: describeOutcome(item.kind, outcome),
  };
}

/** Loads a fixture from fixtures/<kind>/ by name, then replays it. Load errors become failed outcomes. */
async function replayNamedFixture(
  session: ReplaySession,
  item: ReplayCliItem,
): Promise<FixtureReplayOutcome> {
  try {
    const fixture =
      item.kind === "http" ? await loadHttpFixture(item.label) : await loadQueueFixture(item.label);
    return await session.replay({
      fixtureName: item.label,
      event: fixture.event,
      context: fixture.context,
    });
  } catch (error) {
    return { fixtureName: item.label, ok: false, error };
  }
}

/** Loads a fixture from an explicit .json path, then replays it. Load errors become failed outcomes. */
async function replayFixtureFile(
  session: ReplaySession,
  item: ReplayCliItem,
): Promise<FixtureReplayOutcome> {
  try {
    const fixture =
      item.kind === "http"
        ? await loadHttpFixtureFile(item.label)
        : await loadQueueFixtureFile(item.label);
    return await session.replay({
      fixtureName: item.label,
      event: fixture.event,
      context: fixture.context,
    });
  } catch (error) {
    return { fixtureName: item.label, ok: false, error };
  }
}

/**
 * Renders one record as a single value-free line:
 * `ok   http  repeated-query-parameters -> 200 GET /probe/query`.
 */
export function formatReplayRecord(record: ReplayCliRecord): string {
  const status = record.outcome.ok ? "ok" : "fail";
  return `${status.padEnd(4)} ${record.kind.padEnd(4)} ${record.label} -> ${record.detail}`;
}

function describeOutcome(kind: ReplayFixtureKind, outcome: FixtureReplayOutcome): string {
  if (!outcome.ok) {
    return describeError(outcome.error);
  }
  if (kind === "http") {
    const envelope = outcome.result as { statusCode?: unknown } | null;
    return typeof envelope?.statusCode === "number"
      ? String(envelope.statusCode)
      : "resolved without an envelope";
  }
  const batch = outcome.result as { messages?: readonly unknown[] } | null;
  return Array.isArray(batch?.messages)
    ? `batch(${batch.messages.length})`
    : "resolved without a batch";
}

function describeError(error: unknown): string {
  if (error instanceof ConnectorError) {
    return `${error.name}[${error.code}] ${error.message}`;
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/** True when this compiled file was launched directly as a script. */
function isExecutedAsScript(): boolean {
  const scriptArg = process.argv[1];
  return scriptArg !== undefined && path.resolve(scriptArg) === __filename;
}

if (isExecutedAsScript()) {
  void runReplayCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
