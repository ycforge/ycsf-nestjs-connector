import { All, Controller, HttpException, Module } from "@nestjs/common";
import { ConnectorError } from "../core/connector-error";
import { QueueHandler } from "../mq/queue-handler.decorator";
// Merged export: decorator factory plus the normalized message type it injects.
import { QueueMessage } from "../mq/queue-message.decorator";
import { listHttpFixtureNames, listQueueFixtureNames } from "./invocation-fixtures";
import {
  formatReplayRecord,
  parseReplayCliArgs,
  REPLAY_CLI_USAGE,
  ReplayCliUsageError,
  runReplayCli,
  type ReplayCliIo,
} from "./replay-cli";

/**
 * CLI contract of the local replay tooling (issue #12): selection parsing,
 * concise value-free output and deterministic exit codes — `0` when every
 * selected fixture succeeds, `1` when any replay/load fails, `2` on usage or
 * module-loading errors. The executable shell only wires these functions to
 * process.argv/console/process.exitCode, so behavior is verified in-process.
 *
 * Runs against the built-in probe application unless a module loader seam is
 * injected, which also lets the suite prove failure semantics at CLI level
 * without spawning subprocesses.
 */

class TeapotController {
  teapot(): never {
    throw new HttpException({ reason: "teapot-fixture" }, 418);
  }
}

Controller()(TeapotController);

const teapotDescriptor = Object.getOwnPropertyDescriptor(TeapotController.prototype, "teapot");
if (!teapotDescriptor) {
  throw new Error("missing descriptor for TeapotController.teapot");
}
// Catch-all so any replayed fixture path reaches the exception mapping.
All("*rest")(TeapotController.prototype, "teapot", teapotDescriptor);

class CliTeapotModule {}

Module({ controllers: [TeapotController] })(CliTeapotModule);

class CliFailingConsumer {
  handle(): void {
    throw new Error("cli-consumer-boom");
  }
}

QueueHandler()(
  CliFailingConsumer.prototype,
  "handle",
  Object.getOwnPropertyDescriptor(CliFailingConsumer.prototype, "handle")!,
);
QueueMessage()(CliFailingConsumer.prototype, "handle", 0);

class CliFailingQueueModule {}

Module({ providers: [CliFailingConsumer] })(CliFailingQueueModule);

interface CapturedIo extends ReplayCliIo {
  readonly out: string[];
  readonly err: string[];
}

function capturingIo(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, log: (line) => out.push(line), error: (line) => err.push(line) };
}

describe("replay CLI selection parsing", () => {
  it("parses explicit selections, directory modes and module overrides", () => {
    const plan = parseReplayCliArgs([
      "--mq",
      "simple-text-message",
      "--module",
      "./dist/app.module.js",
      "--http",
      "fixtures/http/get-without-query.json",
      "--http-all",
      "--mq-all",
    ]);
    expect(plan.selections).toEqual([
      { kind: "mq", spec: "simple-text-message" },
      { kind: "http", spec: "fixtures/http/get-without-query.json" },
    ]);
    expect(plan.replayAllHttp).toBe(true);
    expect(plan.replayAllMq).toBe(true);
    expect(plan.modulePath).toBe("./dist/app.module.js");
  });

  it("deduplicates identical selections while preserving order", () => {
    const plan = parseReplayCliArgs(["--http", "a", "--http", "b", "--http", "a"]);
    expect(plan.selections).toEqual([
      { kind: "http", spec: "a" },
      { kind: "http", spec: "b" },
    ]);
  });

  it("rejects unknown arguments, missing values and empty selections", () => {
    expect(() => parseReplayCliArgs(["--queue", "x"])).toThrow(ReplayCliUsageError);
    expect(() => parseReplayCliArgs(["--http"])).toThrow(ReplayCliUsageError);
    expect(() => parseReplayCliArgs(["--module"])).toThrow(ReplayCliUsageError);
    expect(() => parseReplayCliArgs([])).toThrow(ReplayCliUsageError);
  });
});

describe("replay CLI execution and exit codes", () => {
  it("prints usage and exits 0 for --help", async () => {
    const io = capturingIo();
    const exitCode = await runReplayCli(["--help"], io);
    expect(exitCode).toBe(0);
    expect(io.out[0]).toContain("--http-all");
    expect(io.out.join("\n")).toBe(REPLAY_CLI_USAGE);
    expect(io.err).toHaveLength(0);
  });

  it("maps usage errors to exit code 2 with the usage text on stderr", async () => {
    const io = capturingIo();
    const exitCode = await runReplayCli(["--nonsense"], io);
    expect(exitCode).toBe(2);
    expect(io.err.join("\n")).toContain('unknown argument "--nonsense"');
    expect(io.err.join("\n")).toContain("Exit codes:");
  });

  it("maps unreadable --module targets to exit code 2", async () => {
    const io = capturingIo();
    const exitCode = await runReplayCli(
      ["--module", "./no-such-directory/no-such-module.js", "--http", "get-without-query"],
      io,
    );
    expect(exitCode).toBe(2);
    expect(io.out).toHaveLength(0);
  });

  it("exits 0 after replaying every committed HTTP fixture", async () => {
    const io = capturingIo();
    const names = await listHttpFixtureNames();
    const exitCode = await runReplayCli(["--http-all"], io);

    expect(exitCode).toBe(0);
    // One line per fixture, one blank separator, one summary line.
    expect(io.out).toHaveLength(names.length + 2);
    expect(io.out.slice(0, names.length)).toEqual(
      names.map((name) => expect.stringContaining(name)),
    );
    expect(io.out[names.length]).toBe("");
    expect(io.out[io.out.length - 1]).toBe(
      `${names.length} ok, 0 failed (${names.length} replayed)`,
    );
  });

  it("exits 0 after replaying every committed Message Queue fixture as batches", async () => {
    const io = capturingIo();
    const names = await listQueueFixtureNames();
    const exitCode = await runReplayCli(["--mq-all"], io);

    expect(exitCode).toBe(0);
    expect(io.out).toHaveLength(names.length + 2);
    for (const line of io.out.slice(0, names.length)) {
      expect(line).toMatch(/^ok\s+mq\s+\S+ -> batch\(1\)$/u);
    }
    expect(io.out[io.out.length - 1]).toBe(
      `${names.length} ok, 0 failed (${names.length} replayed)`,
    );
  });

  it("replays mixed explicit selections in argument order", async () => {
    const io = capturingIo();
    const exitCode = await runReplayCli(
      ["--mq", "unicode-body-message", "--http", "encoded-path-characters"],
      io,
    );

    expect(exitCode).toBe(0);
    expect(io.out[0]).toMatch(/^ok\s+mq\s+unicode-body-message -> batch\(1\)$/u);
    expect(io.out[1]).toMatch(/^ok\s+http\s+encoded-path-characters -> 200$/u);
    expect(io.out[io.out.length - 1]).toBe("2 ok, 0 failed (2 replayed)");
  });

  it("reports a missing fixture as a failed outcome with exit code 1", async () => {
    const io = capturingIo();
    const exitCode = await runReplayCli(["--http", "does-not-exist"], io);

    expect(exitCode).toBe(1);
    expect(io.out[0]).toContain("fail");
    expect(io.out[0]).toContain("does-not-exist");
    expect(io.out[io.out.length - 1]).toBe("0 ok, 1 failed (1 replayed)");
  });

  it("keeps Message Queue failure semantics at CLI level: handler failures exit 1", async () => {
    const io = capturingIo();
    const exitCode = await runReplayCli(["--mq", "json-body-message"], io, {
      loadAppModule: () => CliFailingQueueModule,
    });

    expect(exitCode).toBe(1);
    expect(io.out[0]).toContain("cli-consumer-boom");
    // The verbatim application error propagates unwrapped — no ConnectorError
    // masquerade and no fabricated success result.
    expect(io.out[0]).not.toContain("ConnectorError[");
  });

  it("treats mapped HTTP exceptions as resolved invocations with their status shown", async () => {
    const io = capturingIo();
    const exitCode = await runReplayCli(["--http", "get-without-query"], io, {
      loadAppModule: () => CliTeapotModule,
    });

    // Issue #10 semantics: an HttpException became its response envelope, so
    // the invocation succeeded transport-wise and the CLI reports the status.
    expect(exitCode).toBe(0);
    expect(io.out[0]).toMatch(/^ok\s+http\s+get-without-query -> 418$/u);
    expect(io.out[io.out.length - 1]).toBe("1 ok, 0 failed (1 replayed)");
  });

  it("never prints sensitive fixture values into the output", async () => {
    const io = capturingIo();
    const exitCode = await runReplayCli(["--http-all", "--mq-all"], io);
    const rendered = io.out.join("\n");

    expect(exitCode).toBe(0);
    // Sanitized placeholders standing in for credentials, cookies, sessions,
    // client IPs and gateway hosts must never surface in CLI output.
    expect(rendered).not.toContain("[REDACTED]");
    expect(rendered).not.toContain("REDACTED_AUTHORIZATION");
    expect(rendered).not.toContain("REDACTED_SESSION");
    expect(rendered).not.toContain("203.0.113.");
    expect(rendered).not.toContain("conformance.gateway.apigw.yandexcloud.net");
  });
});

describe("replay CLI record formatting", () => {
  it("renders successes with their transport detail and failures with error summaries", () => {
    expect(
      formatReplayRecord({
        kind: "http",
        label: "get-without-query",
        outcome: { fixtureName: "get-without-query", ok: true, result: { statusCode: 200 } },
        detail: "200",
      }),
    ).toBe("ok   http get-without-query -> 200");

    expect(
      formatReplayRecord({
        kind: "mq",
        label: "simple-text-message",
        outcome: { fixtureName: "simple-text-message", ok: true },
        detail: "batch(1)",
      }),
    ).toBe("ok   mq   simple-text-message -> batch(1)");

    const boundaryFailure = ConnectorError.unknownInvocationEvent("top-level fields: x");
    expect(
      formatReplayRecord({
        kind: "http",
        label: "broken",
        outcome: { fixtureName: "broken", ok: false, error: boundaryFailure },
        detail: describeForTest(boundaryFailure),
      }),
    ).toBe(
      `fail http broken -> ConnectorError[UNKNOWN_INVOCATION_EVENT] ${boundaryFailure.message}`,
    );
  });
});

function describeForTest(error: ConnectorError): string {
  return `${error.name}[${error.code}] ${error.message}`;
}
