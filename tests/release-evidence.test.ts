import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("release evidence verifiers", () => {
  it("accepts redaction-safe alpha evidence with production command proof", async () => {
    const path = await writeEvidence("alpha", validAlphaEvidence());
    const result = runScript("scripts/verify-alpha-evidence.mjs", {
      CF_AUTH_REQUIRE_ALPHA_EVIDENCE: "1",
      CF_AUTH_ALPHA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("private-alpha evidence verified");
  });

  it("rejects alpha production deploys without required command proof", async () => {
    const evidence = validAlphaEvidence();
    evidence.productionDeploys[0]!.commands = [];
    const path = await writeEvidence("alpha-missing-command", evidence);
    const result = runScript("scripts/verify-alpha-evidence.mjs", {
      CF_AUTH_REQUIRE_ALPHA_EVIDENCE: "1",
      CF_AUTH_ALPHA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cf-auth doctor --env production");
    expect(result.stderr).toContain(
      "cf-auth migrate --remote --env production",
    );
    expect(result.stderr).toContain("cf-auth deploy --env production");
  });

  it("rejects alpha evidence that reuses the same users for thresholds", async () => {
    const evidence = validAlphaEvidence();
    for (const setup of evidence.localSetups) setup.user = "alpha-user-1";
    for (const deploy of evidence.productionDeploys) {
      deploy.user = "alpha-user-1";
    }
    const path = await writeEvidence("alpha-duplicate-users", evidence);
    const result = runScript("scripts/verify-alpha-evidence.mjs", {
      CF_AUTH_REQUIRE_ALPHA_EVIDENCE: "1",
      CF_AUTH_ALPHA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("5 distinct alpha users");
    expect(result.stderr).toContain("3 distinct alpha users");
  });

  it("rejects alpha local setup evidence without command proof", async () => {
    const evidence = validAlphaEvidence();
    evidence.localSetups[0]!.commands = [];
    const path = await writeEvidence("alpha-missing-local-command", evidence);
    const result = runScript("scripts/verify-alpha-evidence.mjs", {
      CF_AUTH_REQUIRE_ALPHA_EVIDENCE: "1",
      CF_AUTH_ALPHA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cf-auth init");
    expect(result.stderr).toContain("cf-auth migrate --local");
  });

  it("accepts beta evidence for clean quickstart and opt-in production smoke", async () => {
    const path = await writeEvidence("beta", validBetaEvidence());
    const result = runScript("scripts/verify-beta-evidence.mjs", {
      CF_AUTH_REQUIRE_BETA_EVIDENCE: "1",
      CF_AUTH_BETA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("public-beta evidence verified");
  });

  it("rejects beta production smoke evidence without command proof", async () => {
    const evidence = validBetaEvidence();
    evidence.productionSmoke.commands = [];
    const path = await writeEvidence("beta-missing-command", evidence);
    const result = runScript("scripts/verify-beta-evidence.mjs", {
      CF_AUTH_REQUIRE_BETA_EVIDENCE: "1",
      CF_AUTH_BETA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cf-auth doctor --env production");
    expect(result.stderr).toContain(
      "cf-auth migrate --remote --env production",
    );
    expect(result.stderr).toContain("cf-auth deploy --env production");
  });

  it("accepts deploy button evidence for the documented template path", async () => {
    const path = await writeEvidence(
      "deploy-button",
      validDeployButtonEvidence(),
    );
    const result = runScript("scripts/verify-deploy-button-evidence.mjs", {
      CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE: "1",
      CF_AUTH_DEPLOY_BUTTON_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Deploy to Cloudflare button evidence verified",
    );
  });

  it("accepts package ownership evidence with private shim reservations", async () => {
    const path = await writeEvidence(
      "package-ownership",
      validPackageEvidence(),
    );
    const result = runScript("scripts/verify-package-ownership.mjs", {
      CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP: "1",
      CF_AUTH_PACKAGE_OWNERSHIP_PATH: path,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("package ownership evidence verified");
  });

  it("rejects private shim package names in publishable ownership evidence", async () => {
    const evidence = validPackageEvidence();
    evidence.packages.push({
      name: "cf-auth",
      registry: "https://registry.npmjs.org/",
      version: "0.0.0",
      ownershipConfirmed: true,
      publisherTwoFactorEnabled: true,
      provenancePublish: true,
    });
    const path = await writeEvidence("package-ownership-reserved", evidence);
    const result = runScript("scripts/verify-package-ownership.mjs", {
      CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP: "1",
      CF_AUTH_PACKAGE_OWNERSHIP_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reservedPackages");
  });

  it("accepts security tracker evidence with issue and advisory search proof", async () => {
    const path = await writeEvidence(
      "security-tracker",
      validSecurityTracker(),
    );
    const result = runScript("scripts/verify-security-release-tracker.mjs", {
      CF_AUTH_REQUIRE_SECURITY_TRACKER: "1",
      CF_AUTH_SECURITY_TRACKER_PATH: path,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("security release tracker verified");
  });

  it("rejects security tracker evidence without search URLs", async () => {
    const evidence = validSecurityTracker() as Partial<
      ReturnType<typeof validSecurityTracker>
    >;
    delete evidence.issueSearchUrl;
    delete evidence.advisorySearchUrl;
    const path = await writeEvidence("security-tracker-missing-url", evidence);
    const result = runScript("scripts/verify-security-release-tracker.mjs", {
      CF_AUTH_REQUIRE_SECURITY_TRACKER: "1",
      CF_AUTH_SECURITY_TRACKER_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("issueSearchUrl");
    expect(result.stderr).toContain("advisorySearchUrl");
  });
});

async function writeEvidence(name: string, value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `cf-auth-${name}-`));
  const path = join(dir, "evidence.json");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function runScript(script: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function validAlphaEvidence() {
  return {
    schemaVersion: 1,
    localSetups: Array.from({ length: 5 }, (_, index) => ({
      user: `alpha-user-${index + 1}`,
      completedAt: "2026-05-14T00:00:00.000Z",
      setupMinutes: 8,
      commands: [
        "npx --package @cf-auth/cli@alpha cf-auth init my-app --template hono-basic",
        "pnpm install",
        "npx --package @cf-auth/cli@alpha cf-auth migrate --local",
        "npm run dev",
      ],
      cleanDirectory: true,
      documentedCommandsOnly: true,
      signupLoginVerified: true,
    })),
    productionDeploys: Array.from({ length: 3 }, (_, index) => ({
      user: `alpha-user-${index + 1}`,
      completedAt: "2026-05-14T00:00:00.000Z",
      commands: [
        "npx --package @cf-auth/cli@alpha cf-auth doctor --env production",
        "npx --package @cf-auth/cli@alpha cf-auth migrate --remote --env production",
        "npx --package @cf-auth/cli@alpha cf-auth deploy --env production",
      ],
      doctorReportAttached: true,
      doctorReportSchemaValid: true,
      doctorReportRedactionChecked: true,
      doctorPassed: true,
      migratePassed: true,
      deployPassed: true,
      signupLoginVerified: true,
    })),
    failures: [],
  };
}

function validBetaEvidence() {
  return {
    schemaVersion: 1,
    reviewedAt: "2026-05-14T00:00:00.000Z",
    reviewedBy: "release-reviewer",
    publishedQuickstart: {
      workflowRunUrl:
        "https://github.com/acme/cloudflare-auth/actions/runs/123",
      packageTag: "beta",
      passed: true,
      cleanDirectory: true,
      documentedCommandsOnly: true,
      noWorkspaceDependencies: true,
      signupLoginVerified: true,
    },
    manualQuickstart: {
      maintainer: "release-reviewer",
      completedAt: "2026-05-14T00:00:00.000Z",
      packageTag: "beta",
      cleanDirectory: true,
      documentedCommandsOnly: true,
      signupLoginVerified: true,
    },
    productionSmoke: {
      workflowRunUrl:
        "https://github.com/acme/cloudflare-auth/actions/runs/124",
      packageTag: "beta",
      origin: "https://auth.acme.test",
      passed: true,
      documentedProductionPath: true,
      optInCloudflareAccountFixture: true,
      commands: [
        "npx --package @cf-auth/cli@beta cf-auth doctor --env production",
        "npx --package @cf-auth/cli@beta cf-auth migrate --remote --env production",
        "npx --package @cf-auth/cli@beta cf-auth deploy --env production",
      ],
      smokedEndpoints: [
        "/auth/signup",
        "/auth/login",
        "/auth/logout",
        "/auth/user",
      ],
    },
    deployButton: {
      evidencePath: "docs/deploy-button-evidence.json",
      verified: true,
      evidenceVerifierPassed: true,
    },
  };
}

function validDeployButtonEvidence() {
  return {
    schemaVersion: 1,
    status: "verified",
    verifiedAt: "2026-05-14T00:00:00.000Z",
    verifiedBy: "release-reviewer",
    templateRepositoryUrl: "https://github.com/acme/cloudflare-auth-template",
    deployButtonUrl:
      "https://deploy.workers.cloudflare.com/?url=https://github.com/acme/cloudflare-auth-template",
    deployedOrigin: "https://auth.acme.test",
    starterTemplateCreated: true,
    templateRepositoryPublic: true,
    templateHasNoWorkspaceDependencies: true,
    d1BindingConfigured: true,
    migrationsApplied: true,
    authSecretConfigured: true,
    publicOriginConfigured: true,
    documentedPathFollowed: true,
    signupLoginSmokePassed: true,
    smokedEndpoints: [
      "/auth/signup",
      "/auth/login",
      "/auth/logout",
      "/auth/user",
    ],
  };
}

function validPackageEvidence() {
  return {
    schemaVersion: 1,
    verifiedAt: "2026-05-14T00:00:00.000Z",
    verifiedBy: "release-reviewer",
    packages: [
      "@cf-auth/cli",
      "@cf-auth/client",
      "@cf-auth/core",
      "@cf-auth/email-cloudflare",
      "@cf-auth/hono",
      "@cf-auth/testing",
      "@cf-auth/worker",
    ].map((name) => ({
      name,
      registry: "https://registry.npmjs.org/",
      version: "0.0.0",
      ownershipConfirmed: true,
      publisherTwoFactorEnabled: true,
      provenancePublish: true,
    })),
    reservedPackages: [
      {
        name: "cf-auth",
        registry: "https://registry.npmjs.org/",
        registryVersion: "1.0.2",
        publishableAfterOwnershipConfirmed: true,
      },
      {
        name: "create-cloudflare-auth",
        registry: "https://registry.npmjs.org/",
        publishableAfterOwnershipConfirmed: true,
      },
    ],
  };
}

function validSecurityTracker() {
  return {
    schemaVersion: 1,
    reviewedAt: "2026-05-14T00:00:00.000Z",
    reviewedBy: "release-reviewer",
    issueSearchUrl:
      "https://github.com/acme/cloudflare-auth/issues?q=is%3Aissue%20is%3Aopen%20label%3Aauth%20label%3Ahigh%2Ccritical",
    advisorySearchUrl:
      "https://github.com/acme/cloudflare-auth/security/advisories",
    openHighCriticalAuthSecurityIssues: [],
    advisories: [
      {
        id: "GHSA-abcd-1234-5678",
        severity: "high",
        status: "resolved",
      },
    ],
  };
}
