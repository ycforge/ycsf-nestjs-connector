import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Publishability pins for the distributable package (issue #2). These specs
 * read the repository configuration directly so accidental metadata changes
 * that would break consumers — a new export subpath, a runtime dependency,
 * lost declaration output — fail here before they ever reach npm.
 */

const repoRoot = path.join(__dirname, "..");
const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as Record<
  string,
  unknown
>;
const tsconfigJson = JSON.parse(
  readFileSync(path.join(repoRoot, "tsconfig.json"), "utf8"),
) as Record<string, unknown>;

describe("npm package distribution contract", () => {
  it("serves the public API only through the stable root entry point", () => {
    const exportsMap = packageJson.exports as Record<string, unknown>;

    // A single subpath keeps internal dist modules unreachable by import;
    // docs/ARCHITECTURE.md section 2 relies on exactly this guarantee.
    expect(Object.keys(exportsMap)).toEqual(["."]);
    expect(exportsMap["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });

    // Legacy (node10) resolvers fall back to main/types; both must keep
    // pointing at the same compiled entry.
    expect(packageJson.main).toBe("dist/index.js");
    expect(packageJson.types).toBe("dist/index.d.ts");
  });

  it("explicitly targets Node.js 22", () => {
    expect(packageJson.engines).toEqual({ node: ">=22" });
  });

  it("ships only built output and never as a private package", () => {
    expect(packageJson.files).toEqual(["dist"]);
    expect(packageJson.private).toBeUndefined();
    expect(packageJson.publishConfig).toEqual({ access: "public" });
  });

  it("keeps zero runtime dependencies with NestJS 11 peers only", () => {
    expect(packageJson.dependencies).toBeUndefined();

    expect(packageJson.peerDependencies).toEqual({
      "@nestjs/common": "^11.0.0",
      "@nestjs/core": "^11.0.0",
    });
  });

  it("provides the development scripts required by the workflow", () => {
    const scripts = packageJson.scripts as Record<string, string>;

    for (const script of ["build", "typecheck", "lint", "format:check", "test", "package:check"]) {
      expect(scripts[script]).toBeDefined();
    }
  });
});

describe("library build configuration contract", () => {
  it("emits declarations, declaration maps and source maps", () => {
    const compilerOptions = tsconfigJson.compilerOptions as Record<string, unknown>;

    // Declaration files make the type-only public surface consumable without
    // repository sources; maps keep stack traces and go-to-definition working.
    expect(compilerOptions.declaration).toBe(true);
    expect(compilerOptions.declarationMap).toBe(true);
    expect(compilerOptions.sourceMap).toBe(true);
  });

  it("compiles strict ES2022 output into dist/", () => {
    const compilerOptions = tsconfigJson.compilerOptions as Record<string, unknown>;

    expect(compilerOptions.target).toBe("ES2022");
    expect(compilerOptions.module).toBe("CommonJS");
    expect(compilerOptions.strict).toBe(true);
    expect(compilerOptions.outDir).toBe("dist");
  });
});
