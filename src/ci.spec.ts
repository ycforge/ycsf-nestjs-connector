import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Pipeline contract for the repository automation itself (issue #15). These
 * specs read the workflow sources and .nvmrc directly so the CI that guards
 * this package cannot silently drift from what developers run locally:
 * every gate must execute through its documented npm script, Node.js must
 * stay pinned to the declared major line, third-party actions must remain
 * immutable, and the automation must stay credential-free until a secure
 * publishing mechanism exists.
 */

const repoRoot = path.join(__dirname, "..");

function readRepoFile(...segments: string[]): string {
  return readFileSync(path.join(repoRoot, ...segments), "utf8");
}

const QUALITY_GATE_COMMANDS = [
  "run: npm ci",
  "run: npm run lint",
  "run: npm run format:check",
  "run: npm run typecheck",
  "run: npm test",
  "run: npm run build",
  "run: npm run package:check",
] as const;

describe("pinned toolchain versions", () => {
  it("pins CI to the Node.js 22 minor recorded in .nvmrc", () => {
    // engines declares >=22; CI additionally pins one reproducible minor so
    // every gate runs against a stable, explicitly tested runtime.
    const pinnedVersion = readRepoFile(".nvmrc").trim();

    expect(pinnedVersion).toMatch(/^22\.\d+$/);
  });

  it("resolves the pinned version from every workflow through node-version-file", () => {
    for (const workflowName of ["ci.yml", "release.yml"]) {
      const workflow = readRepoFile(".github", "workflows", workflowName);

      expect(workflow).toContain("node-version-file: .nvmrc");
    }
  });
});

describe("CI workflow contract", () => {
  const ciWorkflow = readRepoFile(".github", "workflows", "ci.yml");

  it("runs every developer quality gate through its exact local command", () => {
    // Mirrors AGENTS.md section 16 and README Development: CI-only shortcuts
    // would let failures appear only after push.
    for (const gateCommand of QUALITY_GATE_COMMANDS) {
      expect(ciWorkflow).toContain(gateCommand);
    }
  });

  it("verifies pull requests against any base branch plus pushes to main", () => {
    // Stacked feature branches merge into intermediate bases; an unfiltered
    // pull_request trigger keeps those PRs verified as well.
    expect(ciWorkflow).toContain("branches: [main]");
    expect(ciWorkflow).toContain("pull_request:");
  });
});

describe("release preparation contract", () => {
  const releaseWorkflow = readRepoFile(".github", "workflows", "release.yml");

  it("validates tagged commits with the full quality-gate sequence", () => {
    for (const gateCommand of QUALITY_GATE_COMMANDS) {
      expect(releaseWorkflow).toContain(gateCommand);
    }
  });

  it("runs on version tags and manual dispatch only", () => {
    expect(releaseWorkflow).toContain('tags: ["v*"]');
    expect(releaseWorkflow).toContain("workflow_dispatch:");
  });

  it("produces the packed tarball as an artifact without publishing", () => {
    expect(releaseWorkflow).toContain("npm pack");
    expect(releaseWorkflow).toContain("actions/upload-artifact@");
    expect(releaseWorkflow).toContain("release-artifacts/*.tgz");
  });

  it("never touches the npm registry", () => {
    // Publication stays deliberately unimplemented (issue #15); these
    // markers must only reappear together with a secure publishing design.
    expect(releaseWorkflow).not.toMatch(/npm publish/i);
    expect(releaseWorkflow).not.toContain("NODE_AUTH_TOKEN");
    expect(releaseWorkflow).not.toContain("registry-url");
  });
});

describe("workflow security hygiene", () => {
  const workflows = [
    readRepoFile(".github", "workflows", "ci.yml"),
    readRepoFile(".github", "workflows", "release.yml"),
  ];

  it("grants least-privilege permissions to every workflow", () => {
    for (const workflow of workflows) {
      expect(workflow).toContain("permissions:\n  contents: read");
    }
  });

  it("references no repository secrets", () => {
    for (const workflow of workflows) {
      expect(workflow).not.toContain("secrets.");
    }
  });

  it("pins third-party actions to immutable commit SHAs", () => {
    for (const workflow of workflows) {
      for (const match of workflow.matchAll(/uses:\s+\S+@(\S+)/g)) {
        expect(match[1] ?? "missing version").toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });
});
