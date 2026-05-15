import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

type ReleaseReadinessAuditChecks = {
  collectReleaseReadinessAuditFailures(
    audit: string,
    options?: {
      path?: string;
      missingTextMessage?: (needle: string) => string;
      missingStageMessage?: (stage: number) => string;
      missingRuleMessage?: (rule: number) => string;
    },
  ): string[];
  collectReleaseReadinessAuditTestReferenceFailures(
    audit: string,
    options?: {
      root?: string;
      path?: string;
      missingTestMessage?: (testPath: string) => string;
    },
  ): string[];
  collectReleaseReadinessAuditPathReferenceFailures(
    audit: string,
    options?: {
      root?: string;
      path?: string;
      missingPathMessage?: (repoPath: string) => string;
    },
  ): string[];
  requiredReleaseReadinessAuditText: string[];
  releaseReadinessAuditPathReferences(audit: string): string[];
};

describe("release readiness audit checks", () => {
  it("accepts an audit with required text, stage coverage, and rule coverage", async () => {
    const checks = await loadChecks();

    expect(
      checks.collectReleaseReadinessAuditFailures(completeAuditText(checks)),
    ).toEqual([]);
  });

  it("reports missing required text, stage coverage, and rule coverage", async () => {
    const checks = await loadChecks();
    const audit = completeAuditText(checks)
      .replace("Section 33.1 README", "")
      .replace("Recent local verification has passed for:", "")
      .replace("pnpm package:check", "")
      .replace("Published quickstart smoke", "")
      .replace("Stage 12", "Stable 12")
      .replace("| 28 |", "| -- |");

    expect(checks.collectReleaseReadinessAuditFailures(audit)).toEqual(
      expect.arrayContaining([
        "docs/release-readiness-audit.md: missing Section 33.1 README",
        "docs/release-readiness-audit.md: missing Recent local verification has passed for:",
        "docs/release-readiness-audit.md: missing pnpm package:check",
        "docs/release-readiness-audit.md: missing Published quickstart smoke",
        "docs/release-readiness-audit.md: missing Stage 12",
        "docs/release-readiness-audit.md: missing Rule 28",
      ]),
    );
  });

  it("supports caller-specific failure messages", async () => {
    const checks = await loadChecks();
    const failures = checks.collectReleaseReadinessAuditFailures("", {
      missingRuleMessage: (rule) => `rule:${rule}`,
      missingStageMessage: (stage) => `stage:${stage}`,
      missingTextMessage: (needle) => `text:${needle}`,
    });

    expect(failures).toContain("text:cloudflare_auth_implementation_plan.md");
    expect(failures).toContain("stage:0");
    expect(failures).toContain("rule:1");
  });

  it("reports missing referenced test files", async () => {
    const checks = await loadChecks();
    const fixture = await mkdtemp(join(tmpdir(), "cf-auth-release-audit-"));
    await mkdir(join(fixture, "tests"));
    await writeFile(join(fixture, "tests/routes.test.ts"), "");

    expect(
      checks.collectReleaseReadinessAuditTestReferenceFailures(
        "Covered by `tests/routes.test.ts` and `tests/missing.test.ts`.",
        { root: fixture },
      ),
    ).toEqual([
      "docs/release-readiness-audit.md: referenced test file does not exist: tests/missing.test.ts",
    ]);
  });

  it("reports missing referenced repo paths except known evidence blockers", async () => {
    const checks = await loadChecks();
    const fixture = await mkdtemp(join(tmpdir(), "cf-auth-release-audit-"));
    await writeFixtureFile(fixture, "README.md", "");

    expect(
      checks.collectReleaseReadinessAuditPathReferenceFailures(
        [
          "`README.md` exists.",
          "`docs/missing.md` is stale.",
          "`docs/alpha-evidence.json` is intentionally blocked.",
          "`tests/missing.test.ts` is handled by the test-reference check.",
        ].join("\n"),
        { root: fixture },
      ),
    ).toEqual([
      "docs/release-readiness-audit.md: referenced repo path does not exist: docs/missing.md",
    ]);
  });

  it("verifies release audit files from the command line", async () => {
    const checks = await loadChecks();
    const fixture = await writeAuditFixture(completeAuditText(checks), checks);
    const result = runReleaseAuditVerifier(fixture);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release readiness audit verified");
  });

  it("returns nonzero for incomplete release audit files", async () => {
    const checks = await loadChecks();
    const fixture = await writeAuditFixture(
      completeAuditText(checks).replace("Stage 12", "Stable 12"),
      checks,
    );
    const result = runReleaseAuditVerifier(fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/release-readiness-audit.md: missing Stage 12",
    );
  });
});

async function loadChecks(): Promise<ReleaseReadinessAuditChecks> {
  return (await import(
    pathToFileURL(
      resolve(process.cwd(), "scripts/release-readiness-audit-checks.mjs"),
    ).href
  )) as ReleaseReadinessAuditChecks;
}

function completeAuditText(checks: ReleaseReadinessAuditChecks) {
  return [
    ...checks.requiredReleaseReadinessAuditText,
    ...Array.from({ length: 13 }, (_, stage) => `Stage ${stage}`),
    ...Array.from({ length: 28 }, (_, index) => `| ${index + 1} |`),
  ].join("\n");
}

async function writeAuditFixture(
  audit: string,
  checks: ReleaseReadinessAuditChecks,
) {
  const fixture = await mkdtemp(join(tmpdir(), "cf-auth-release-audit-"));
  await mkdir(join(fixture, "docs"));
  await mkdir(join(fixture, "tests"));
  await writeFile(join(fixture, "tests/lint.test.ts"), "");
  for (const repoPath of checks.releaseReadinessAuditPathReferences(audit)) {
    if (repoPath.endsWith(".test.ts")) continue;
    if (
      [
        "docs/alpha-evidence.json",
        "docs/beta-evidence.json",
        "docs/deploy-button-evidence.json",
        "docs/package-ownership.json",
        "docs/security-release-tracker.json",
      ].includes(repoPath)
    ) {
      continue;
    }
    await writeFixtureFile(fixture, repoPath, "");
  }
  await writeFile(join(fixture, "docs/release-readiness-audit.md"), audit);
  return fixture;
}

async function writeFixtureFile(root: string, path: string, content: string) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function runReleaseAuditVerifier(cwd: string) {
  return spawnSync(
    process.execPath,
    [resolve(process.cwd(), "scripts/verify-release-readiness-audit.mjs")],
    {
      cwd,
      encoding: "utf8",
    },
  );
}
