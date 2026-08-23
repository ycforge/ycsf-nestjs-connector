#!/usr/bin/env node
/**
 * Packaging validation for the distributable artifact (issue #2).
 *
 * Proves, against the actual `npm pack` tarball rather than the source tree:
 *   1. the published file set contains only built output plus package
 *      metadata — no sources, tests, fixtures or secrets;
 *   2. the packed package is consumable standalone: the root entry point
 *      loads from `node_modules`, deep imports of internal modules are
 *      rejected by the exports map at runtime AND at type level, and a
 *      TypeScript consumer compiles against the shipped declarations using
 *      Node.js-style resolution.
 *
 * Run via `npm run package:check`. CI wiring lands with issue #15.
 */

import { execFileSync } from "node:child_process";
import { error as consoleError, log as consoleLog } from "node:console";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkDir = path.join(repoRoot, ".package-check");

/** Metadata files npm always ships alongside the `files` whitelist. */
const METADATA_FILES = new Set(["package.json", "README.md", "LICENSE"]);
const REQUIRED_FILES = [...METADATA_FILES, "dist/index.js", "dist/index.d.ts"];
const DIST_FILE_PATTERN = /^dist\/.+\.(js|js\.map|d\.ts|d\.ts\.map)$/;
const FORBIDDEN_NAME_PATTERN = /(^|\/)([^/]*\bspec\b|\btest[^/]*|\.env[^/]*|authorized_key[^/]*)$/i;

// Mirrors src/index.spec.ts: the runtime surface grows only deliberately
// (docs/ARCHITECTURE.md section 7); issue #3 added the bootstrap, issue #4
// the context decorator, issue #8 the queue decorators, issue #13 the
// safe-diagnostics serializer.
const EXPECTED_RUNTIME_EXPORTS = [
  "ConnectorError",
  "QueueHandler",
  "QueueMessage",
  "YandexContext",
  "createYandexHandler",
  "safeDiagnostics",
];
const FORBIDDEN_DEEP_IMPORTS = [
  "@ycforge/ycsf-nestjs-connector/dist/core/transport",
  "@ycforge/ycsf-nestjs-connector/dist/http/raw-event",
  "@ycforge/ycsf-nestjs-connector/dist/mq/message",
  "@ycforge/ycsf-nestjs-connector/dist/index.js",
];

function fail(message) {
  throw new Error(`package validation failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function run(command, args, options) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

/**
 * Environment for the standalone consumer checks. The scratch consumer
 * installs only the packed tarball — peer dependencies stay undeclared by
 * design (issue #2 contract) — while the runtime entry point now loads
 * `@nestjs/core` (issue #3). Resolving peers from the repository checkout
 * mirrors a real consumer environment (which always has the peers installed)
 * without pulling the network into packaging validation. Node and tsc both
 * honor NODE_PATH.
 */
function consumerEnv() {
  const nodePath = path.join(repoRoot, "node_modules");
  return { ...process.env, NODE_PATH: nodePath };
}

function packTarball() {
  const packDir = mkdtempSync(path.join(tmpdir(), "ycsf-pack-"));
  let stdout;
  try {
    // `npm pack` executes the `prepack` script, so the tarball always reflects
    // a fresh build of the current source tree.
    stdout = run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: repoRoot });
  } catch (error) {
    rmSync(packDir, { recursive: true, force: true });
    fail(`npm pack did not succeed: ${error.message}`);
  }
  let result;
  try {
    result = JSON.parse(stdout)[0];
  } catch {
    rmSync(packDir, { recursive: true, force: true });
    fail("could not parse `npm pack --json` output");
  }
  return {
    tarballPath: path.join(packDir, result.filename),
    files: result.files.map((file) => file.path),
    cleanup: () => rmSync(packDir, { recursive: true, force: true }),
  };
}

function assertTarballContents(files) {
  for (const required of REQUIRED_FILES) {
    assert(files.includes(required), `tarball is missing required file ${required}`);
  }
  for (const filePath of files) {
    const allowed = METADATA_FILES.has(filePath) || DIST_FILE_PATTERN.test(filePath);
    assert(allowed, `unexpected file in tarball: ${filePath}`);
    assert(!FORBIDDEN_NAME_PATTERN.test(filePath), `forbidden file in tarball: ${filePath}`);
  }
}

function installIntoConsumerScratch(tarballPath) {
  const extractDir = path.join(checkDir, "tarball");
  const consumerDir = path.join(checkDir, "consumer");
  const installedPkgDir = path.join(
    consumerDir,
    "node_modules",
    "@ycforge",
    "ycsf-nestjs-connector",
  );
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(installedPkgDir, { recursive: true });
  run("tar", ["-xzf", tarballPath, "-C", extractDir]);
  // Tarballs unpack into `package/`; move it under node_modules so both Node
  // and TypeScript resolve the exact specifier consumers will use.
  rmSync(installedPkgDir, { recursive: true, force: true });
  renameSync(path.join(extractDir, "package"), installedPkgDir);
  return consumerDir;
}

function runRuntimeCheck(consumerDir) {
  // CommonJS on purpose: plain `require` exercises the CJS exports map the
  // function runtime will use when loading the handler module.
  const script = `
const expectedRuntimeExports = ${JSON.stringify(EXPECTED_RUNTIME_EXPORTS)};
const forbiddenDeepImports = ${JSON.stringify(FORBIDDEN_DEEP_IMPORTS)};

const entry = require("@ycforge/ycsf-nestjs-connector");
const entryKeys = Object.keys(entry).sort();
if (JSON.stringify(entryKeys) !== JSON.stringify([...expectedRuntimeExports].sort())) {
  console.error("entry point runtime exports differ from the declared surface:", entryKeys);
  process.exit(1);
}

if (typeof entry.createYandexHandler !== "function") {
  console.error("createYandexHandler must be a function");
  process.exit(1);
}
if (typeof entry.ConnectorError !== "function") {
  console.error("ConnectorError must be a constructable class");
  process.exit(1);
}
if (typeof entry.YandexContext !== "function") {
  console.error("YandexContext must be a decorator factory function");
  process.exit(1);
}
if (typeof entry.QueueHandler !== "function") {
  console.error("QueueHandler must be a decorator factory function");
  process.exit(1);
}
if (typeof entry.QueueMessage !== "function") {
  console.error("QueueMessage must be a decorator factory function");
  process.exit(1);
}
if (typeof entry.safeDiagnostics !== "function") {
  console.error("safeDiagnostics must be a function");
  process.exit(1);
}
const redactedProbe = entry.safeDiagnostics({
  token: "sentinel-iam-secret-value",
  headers: { Authorization: "Bearer sentinel-auth-value", Cookie: "session=sentinel-cookie" },
});
const redactedJson = JSON.stringify(redactedProbe);
if (
  redactedJson !==
  '{"token":"REDACTED_TOKEN","headers":{"Authorization":"REDACTED_AUTHORIZATION","Cookie":"REDACTED_COOKIE"}}'
) {
  console.error("safeDiagnostics did not produce the documented redacted shape:", redactedJson);
  process.exit(1);
}
const probeHandler = entry.createYandexHandler(class AppModule {});
if (typeof probeHandler !== "function" || typeof probeHandler.close !== "function") {
  console.error("createYandexHandler must return an invocable handler with close()");
  process.exit(1);
}

for (const specifier of forbiddenDeepImports) {
  let caught = null;
  try {
    require(specifier);
  } catch (error) {
    caught = error;
  }
  if (!caught || caught.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
    console.error("deep import was not blocked by the exports map:", specifier);
    process.exit(1);
  }
}
`;
  writeFileSync(path.join(consumerDir, "runtime-check.cjs"), script);
  run(process.execPath, [path.join(consumerDir, "runtime-check.cjs")], {
    cwd: consumerDir,
    env: consumerEnv(),
  });
}

const CONSUMER_TYPESCRIPT_OPTIONS = {
  target: "ES2022",
  // node16 resolution enforces the exports map for type imports too; weaker
  // resolvers would happily reach internal dist files behind deep import paths.
  module: "node16",
  moduleResolution: "node16",
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  types: ["node"],
};

function runPositiveTypeCheck(consumerDir) {
  // Exercises a representative slice of the public contract surface through
  // the packaged declarations only; no repository source files are involved.
  writeFileSync(
    path.join(consumerDir, "consumer-positive.ts"),
    [
      'import { ConnectorError, createYandexHandler, QueueHandler, QueueMessage, safeDiagnostics, YandexContext } from "@ycforge/ycsf-nestjs-connector";',
      "import type {",
      "  ConnectorErrorCode,",
      "  ClosableYandexCloudFunctionHandler,",
      "  CreateYandexHandlerOptions,",
      "  HasRaw,",
      "  NormalizedHttpRequest,",
      "  QueueBatch,",
      "  QueueBodyDeserializer,",
      "  RawHttpApiGatewayV2Event,",
      "  RawQueueEvent,",
      "  TransportAdapter,",
      "  YandexCloudFunctionHandler,",
      "  YandexExecutionContext,",
      "  YandexFunctionHttpResponse,",
      '} from "@ycforge/ycsf-nestjs-connector";',
      "",
      "export const handler: YandexCloudFunctionHandler = async () => null;",
      "",
      "export const httpTransport: TransportAdapter<RawHttpApiGatewayV2Event, YandexFunctionHttpResponse | null> = {",
      '  id: "http",',
      "  supports(rawEvent): rawEvent is RawHttpApiGatewayV2Event {",
      "    return (",
      '      typeof rawEvent === "object" &&',
      "      rawEvent !== null &&",
      '      "version" in rawEvent &&',
      '      rawEvent.version === "2.0"',
      "    );",
      "  },",
      "  async invoke() {",
      "    return null;",
      "  },",
      "};",
      "",
      'export const errorCode: ConnectorErrorCode = "UNKNOWN_INVOCATION_EVENT";',
      "",
      "export const carryingRaw: HasRaw<RawQueueEvent> = { raw: { messages: [] } };",
      "export const batch: QueueBatch = { ...carryingRaw, messages: [] };",
      "",
      "declare const normalizedRequest: NormalizedHttpRequest;",
      "export const requestPath: string = normalizedRequest.path;",
      "",
      "declare const executionContext: YandexExecutionContext;",
      "// The observed string form of memoryLimitInMB must survive packaging",
      "// without silent coercion (AGENTS.md section 5).",
      "export const memoryLimitInMB: string = executionContext.memoryLimitInMB;",
      "",
      "// Issue #4 surface: raw event escape hatch, redaction-safe automatic",
      "// serialization and the context parameter decorator.",
      "export const rawEventEscapeHatch: unknown = executionContext.rawEvent;",
      "export const serializedContext: Record<string, unknown> = JSON.parse(JSON.stringify(executionContext));",
      "",
      "// Applied imperatively (exactly what legacy decorator desugaring does),",
      "// mirroring how the repository specs exercise decorators without relying",
      "// on decorator compilation settings of the consumer toolchain.",
      "class ContextConsumer {",
      "  handle(executionContext: YandexExecutionContext): string {",
      "    return executionContext.awsRequestId;",
      "  }",
      "}",
      "const consumer = new ContextConsumer();",
      'YandexContext()(consumer, "handle", 0);',
      "",
      "// Issue #8 surface: the merged QueueMessage export must work in both",
      "// positions (decorator factory and normalized message type).",
      "class QueueConsumer {",
      "  consume(message: QueueMessage): string {",
      "    return message.messageId;",
      "  }",
      "}",
      "const queueConsumer = new QueueConsumer();",
      'QueueHandler()(queueConsumer, "consume", Object.getOwnPropertyDescriptor(QueueConsumer.prototype, "consume")!);',
      'QueueMessage()(queueConsumer, "consume", 0);',
      "",
      "// Issue #9 surface: QueueMessage<T> exposes a typed payload beside the",
      "// untouched raw body; options accept a custom deserializer strategy.",
      "interface OrderPayload {",
      "  orderId: string;",
      "}",
      "class TypedQueueConsumer {",
      "  consume(message: QueueMessage<OrderPayload>): string {",
      "    const decodedOrderId: string = message.payload.orderId;",
      "    const rawBody: string = message.body;",
      '    const attributeValue: string | undefined = message.messageAttributes["Attempt"]?.stringValue;',
      '    return decodedOrderId + rawBody.length + (attributeValue ?? "");',
      "  }",
      "}",
      "const typedQueueConsumer = new TypedQueueConsumer();",
      'QueueHandler()(typedQueueConsumer, "consume", Object.getOwnPropertyDescriptor(TypedQueueConsumer.prototype, "consume")!);',
      'QueueMessage()(typedQueueConsumer, "consume", 0);',
      "",
      "const stringDeserializer: QueueBodyDeserializer = (body) => body;",
      "const connectorOptions: CreateYandexHandlerOptions = {",
      "  queue: { deserializeBody: stringDeserializer },",
      "};",
      "",
      "// Runtime exports added by issue #3 must stay consumable through the",
      "// packaged declarations, including the closable handler shape.",
      "class AppModule {}",
      "const yandexHandler: ClosableYandexCloudFunctionHandler = createYandexHandler(AppModule, connectorOptions);",
      "export const handlerClose: Promise<void> = yandexHandler.close();",
      'export const boundaryError = ConnectorError.invalidInvocationEvent("http", "missing body");',
      "export const boundaryErrorCode: ConnectorErrorCode = boundaryError.code;",
      "",
      "// Issue #13 surface: the redacting diagnostic serializer ships through",
      "// the packaged declarations and accepts arbitrary diagnostic values.",
      "export const redacted: unknown = safeDiagnostics({",
      "  token: boundaryErrorCode,",
      '  headers: { Authorization: "Bearer x", "X-Request-Id": "keep" },',
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(consumerDir, "tsconfig-positive.json"),
    JSON.stringify(
      { compilerOptions: CONSUMER_TYPESCRIPT_OPTIONS, files: ["consumer-positive.ts"] },
      null,
      2,
    ),
  );
  try {
    run(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        "tsconfig-positive.json",
      ],
      { cwd: consumerDir, env: consumerEnv() },
    );
  } catch (error) {
    const diagnostics = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    fail(`the packed declarations did not compile for a consumer:\n${diagnostics}`);
  }
}

function runNegativeTypeCheck(consumerDir) {
  writeFileSync(
    path.join(consumerDir, "consumer-negative.ts"),
    [
      'import type { TransportId } from "@ycforge/ycsf-nestjs-connector/dist/core/transport";',
      'export const transportId: TransportId = "http";',
      "",
    ].join("\n"),
  );
  writeFileSync(
    path.join(consumerDir, "tsconfig-negative.json"),
    JSON.stringify(
      { compilerOptions: CONSUMER_TYPESCRIPT_OPTIONS, files: ["consumer-negative.ts"] },
      null,
      2,
    ),
  );
  try {
    run(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
        "-p",
        "tsconfig-negative.json",
      ],
      { cwd: consumerDir, env: consumerEnv() },
    );
  } catch (error) {
    const diagnostics = `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    if (/Cannot find module/.test(diagnostics)) {
      return;
    }
    fail(`deep type import failed for an unexpected reason:\n${diagnostics}`);
  }
  fail("deep type import compiled although the exports map must hide internal modules");
}

function validate() {
  rmSync(checkDir, { recursive: true, force: true });
  mkdirSync(checkDir, { recursive: true });

  const packed = packTarball();
  try {
    assertTarballContents(packed.files);

    const consumerDir = installIntoConsumerScratch(packed.tarballPath);
    runRuntimeCheck(consumerDir);
    runPositiveTypeCheck(consumerDir);
    runNegativeTypeCheck(consumerDir);
  } finally {
    packed.cleanup();
  }

  // Keep the scratch area only when validation fails, for post-mortem.
  rmSync(checkDir, { recursive: true, force: true });

  consoleLog(
    `package validation passed: ${packed.files.length} files in ${path.basename(
      packed.tarballPath,
    )}, entry-point-only consumption verified at runtime and type level`,
  );
}

try {
  validate();
} catch (error) {
  consoleError(error instanceof Error ? error.message : error);
  consoleError(`inspection artifacts left in ${checkDir}`);
  process.exitCode = 1;
}
