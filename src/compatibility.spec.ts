import { readFileSync } from "node:fs";
import path from "node:path";
import { ConnectorError } from "./index";
import type { ConnectorErrorCode } from "./index";

/**
 * Compatibility-policy pins for issue #17 (docs/COMPATIBILITY.md). These
 * specs enforce the concrete invariants the policy promises consumers: the
 * reserved boundary error codes stay constructable and documented, and the
 * supported Node.js/NestJS targets stated in the policy cannot drift from
 * what package.json, .nvmrc and CI actually declare.
 */

const repoRoot = path.join(__dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as Record<
  string,
  unknown
>;
const compatibilityPolicy = readFileSync(path.join(repoRoot, "docs", "COMPATIBILITY.md"), "utf8");

describe("stable boundary error codes", () => {
  // Compile-time exhaustiveness in both directions: a code added to
  // ConnectorErrorCode makes this map incomplete, a removed or renamed code
  // leaves an unknown property — either way typecheck fails here first
  // (docs/COMPATIBILITY.md section 8).
  const factoryByStableCode: { [Code in ConnectorErrorCode]: () => ConnectorError } = {
    UNKNOWN_INVOCATION_EVENT: ConnectorError.unknownInvocationEvent,
    INVALID_INVOCATION_EVENT: () => ConnectorError.invalidInvocationEvent("http"),
    UNSUPPORTED_ROUTE_PATTERN: () => ConnectorError.unsupportedRoutePattern("/fixture"),
    NO_QUEUE_HANDLER: ConnectorError.noQueueHandler,
    QUEUE_BODY_DESERIALIZATION_FAILED: ConnectorError.queueBodyDeserializationFailed,
  };

  it("constructs a boundary failure for every reserved code", () => {
    const stableCodes = Object.keys(factoryByStableCode) as ConnectorErrorCode[];

    expect(stableCodes).toHaveLength(5);

    for (const code of stableCodes) {
      const boundaryError = factoryByStableCode[code]!();

      expect(boundaryError).toBeInstanceOf(ConnectorError);
      expect(boundaryError.name).toBe("ConnectorError");
      expect(boundaryError.code).toBe(code);
      expect(boundaryError.detail.code).toBe(code);
    }
  });

  it("lists every reserved code in the compatibility policy", () => {
    for (const code of Object.keys(factoryByStableCode)) {
      expect(compatibilityPolicy).toContain(code);
    }
  });
});

describe("documented compatibility targets", () => {
  const engines = packageJson.engines as Record<string, string>;
  const peerDependencies = packageJson.peerDependencies as Record<string, string>;

  it("documents the same Node.js support the package declares", () => {
    // The policy must quote the exact engines range; bumping engines without
    // updating docs/COMPATIBILITY.md fails here before publication.
    expect(compatibilityPolicy).toContain(`node ${engines["node"]!}`);
  });

  it("documents the same NestJS support the package declares", () => {
    for (const peer of ["@nestjs/common", "@nestjs/core"] as const) {
      expect(compatibilityPolicy).toContain(peer);
      expect(compatibilityPolicy).toContain(`\`${peerDependencies[peer]!}\``);
    }
  });

  it("pins development and CI to the same Node.js major the package declares", () => {
    // engines declares the supported major line; .nvmrc pins one minor of
    // exactly that line for reproducible local and CI runs.
    const declaredMajor = /^>=?(\d+)/.exec(engines["node"]!)?.[1];
    const pinnedMinor = readFileSync(path.join(repoRoot, ".nvmrc"), "utf8").trim();
    const pinnedMajor = /^\d+/.exec(pinnedMinor)?.[0];

    expect(declaredMajor).toBeDefined();
    expect(pinnedMajor).toBe(declaredMajor);

    // The policy references .nvmrc as part of the alignment chain it defines.
    expect(compatibilityPolicy).toContain(".nvmrc");
  });
});
