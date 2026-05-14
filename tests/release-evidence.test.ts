import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
    expect(result.stderr).toContain("cf-auth doctor");
    expect(result.stderr).toContain("--report");
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
    expect(result.stderr).toContain("pnpm install");
    expect(result.stderr).toContain("npm run dev");
  });

  it("rejects alpha evidence without alpha package channel proof", async () => {
    const evidence = validAlphaEvidence();
    for (const setup of evidence.localSetups) {
      setup.commands = setup.commands.map((command) =>
        command.replace("@cf-auth/cli@alpha", "@cf-auth/cli@latest"),
      );
    }
    for (const deploy of evidence.productionDeploys) {
      deploy.commands = deploy.commands.map((command) =>
        command.replace("@cf-auth/cli@alpha", "@cf-auth/cli@latest"),
      );
    }
    const path = await writeEvidence("alpha-latest-channel", evidence);
    const result = runScript("scripts/verify-alpha-evidence.mjs", {
      CF_AUTH_REQUIRE_ALPHA_EVIDENCE: "1",
      CF_AUTH_ALPHA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@cf-auth/cli@alpha");
  });

  it("rejects alpha evidence with raw IPv6 addresses", async () => {
    const evidence = validAlphaEvidence();
    (evidence.localSetups[0] as Record<string, unknown>).notes =
      "observed from [2001:db8::1]";
    const path = await writeEvidence("alpha-ipv6", evidence);
    const result = runScript("scripts/verify-alpha-evidence.mjs", {
      CF_AUTH_REQUIRE_ALPHA_EVIDENCE: "1",
      CF_AUTH_ALPHA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not include raw secrets");
    expect(result.stderr).toContain("IPs");
  });

  it("rejects alpha evidence with raw user agents", async () => {
    const evidence = validAlphaEvidence();
    (evidence.localSetups[0] as Record<string, unknown>).userAgent =
      "Mozilla/5.0 Evidence Browser";
    const path = await writeEvidence("alpha-user-agent", evidence);
    const result = runScript("scripts/verify-alpha-evidence.mjs", {
      CF_AUTH_REQUIRE_ALPHA_EVIDENCE: "1",
      CF_AUTH_ALPHA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not include raw secrets");
    expect(result.stderr).toContain("user agents");
  });

  it("rejects non-ISO evidence dates", async () => {
    const alphaEvidence = validAlphaEvidence();
    alphaEvidence.localSetups[0]!.completedAt = "May 14, 2026";
    const alphaPath = await writeEvidence("alpha-non-iso-date", alphaEvidence);
    const alphaResult = runScript("scripts/verify-alpha-evidence.mjs", {
      CF_AUTH_REQUIRE_ALPHA_EVIDENCE: "1",
      CF_AUTH_ALPHA_EVIDENCE_PATH: alphaPath,
    });

    const betaEvidence = validBetaEvidence();
    betaEvidence.reviewedAt = "May 14, 2026";
    const betaPath = await writeEvidence("beta-non-iso-date", betaEvidence);
    const betaResult = runScript("scripts/verify-beta-evidence.mjs", {
      CF_AUTH_REQUIRE_BETA_EVIDENCE: "1",
      CF_AUTH_BETA_EVIDENCE_PATH: betaPath,
    });

    const packageEvidence = validPackageEvidence();
    packageEvidence.verifiedAt = "May 14, 2026";
    const packagePath = await writeEvidence(
      "package-ownership-non-iso-date",
      packageEvidence,
    );
    const packageResult = runScript("scripts/verify-package-ownership.mjs", {
      CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP: "1",
      CF_AUTH_PACKAGE_OWNERSHIP_PATH: packagePath,
    });

    const deployButtonEvidence = validDeployButtonEvidence();
    deployButtonEvidence.verifiedAt = "May 14, 2026";
    const deployButtonPath = await writeEvidence(
      "deploy-button-non-iso-date",
      deployButtonEvidence,
    );
    const deployButtonResult = runScript(
      "scripts/verify-deploy-button-evidence.mjs",
      {
        CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE: "1",
        CF_AUTH_DEPLOY_BUTTON_EVIDENCE_PATH: deployButtonPath,
      },
    );

    const securityTracker = validSecurityTracker();
    securityTracker.reviewedAt = "May 14, 2026";
    const securityTrackerPath = await writeEvidence(
      "security-tracker-non-iso-date",
      securityTracker,
    );
    const securityTrackerResult = runScript(
      "scripts/verify-security-release-tracker.mjs",
      {
        CF_AUTH_REQUIRE_SECURITY_TRACKER: "1",
        CF_AUTH_SECURITY_TRACKER_PATH: securityTrackerPath,
      },
    );

    for (const result of [
      alphaResult,
      betaResult,
      packageResult,
      deployButtonResult,
      securityTrackerResult,
    ]) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must be an ISO date string");
    }
  });

  it("rejects impossible ISO evidence dates", async () => {
    const evidence = validAlphaEvidence();
    evidence.localSetups[0]!.completedAt = "2026-02-31T00:00:00.000Z";
    const path = await writeEvidence("alpha-impossible-date", evidence);
    const result = runScript("scripts/verify-alpha-evidence.mjs", {
      CF_AUTH_REQUIRE_ALPHA_EVIDENCE: "1",
      CF_AUTH_ALPHA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must be an ISO date string");
  });

  it("rejects future evidence dates", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const alphaEvidence = validAlphaEvidence();
    alphaEvidence.localSetups[0]!.completedAt = future;
    const alphaPath = await writeEvidence("alpha-future-date", alphaEvidence);
    const alphaResult = runScript("scripts/verify-alpha-evidence.mjs", {
      CF_AUTH_REQUIRE_ALPHA_EVIDENCE: "1",
      CF_AUTH_ALPHA_EVIDENCE_PATH: alphaPath,
    });

    const betaEvidence = validBetaEvidence();
    betaEvidence.reviewedAt = future;
    const betaPath = await writeEvidence("beta-future-date", betaEvidence);
    const betaResult = runScript("scripts/verify-beta-evidence.mjs", {
      CF_AUTH_REQUIRE_BETA_EVIDENCE: "1",
      CF_AUTH_BETA_EVIDENCE_PATH: betaPath,
    });

    const packageEvidence = validPackageEvidence();
    packageEvidence.verifiedAt = future;
    const packagePath = await writeEvidence(
      "package-ownership-future-date",
      packageEvidence,
    );
    const packageResult = runScript("scripts/verify-package-ownership.mjs", {
      CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP: "1",
      CF_AUTH_PACKAGE_OWNERSHIP_PATH: packagePath,
    });

    const deployButtonEvidence = validDeployButtonEvidence();
    deployButtonEvidence.verifiedAt = future;
    const deployButtonPath = await writeEvidence(
      "deploy-button-future-date",
      deployButtonEvidence,
    );
    const deployButtonResult = runScript(
      "scripts/verify-deploy-button-evidence.mjs",
      {
        CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE: "1",
        CF_AUTH_DEPLOY_BUTTON_EVIDENCE_PATH: deployButtonPath,
      },
    );

    const securityTracker = validSecurityTracker();
    securityTracker.reviewedAt = future;
    const securityTrackerPath = await writeEvidence(
      "security-tracker-future-date",
      securityTracker,
    );
    const securityTrackerResult = runScript(
      "scripts/verify-security-release-tracker.mjs",
      {
        CF_AUTH_REQUIRE_SECURITY_TRACKER: "1",
        CF_AUTH_SECURITY_TRACKER_PATH: securityTrackerPath,
      },
    );

    for (const result of [
      alphaResult,
      betaResult,
      packageResult,
      deployButtonResult,
      securityTrackerResult,
    ]) {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must not be in the future");
    }
  });

  it("requires forced release evidence files to exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-auth-missing-evidence-"));
    const cases = [
      {
        script: "scripts/verify-alpha-evidence.mjs",
        env: {
          CF_AUTH_REQUIRE_ALPHA_EVIDENCE: "1",
          CF_AUTH_ALPHA_EVIDENCE_PATH: join(dir, "alpha.json"),
        },
        message: "private-alpha evidence is required",
      },
      {
        script: "scripts/verify-beta-evidence.mjs",
        env: {
          CF_AUTH_REQUIRE_BETA_EVIDENCE: "1",
          CF_AUTH_BETA_EVIDENCE_PATH: join(dir, "beta.json"),
        },
        message: "public-beta evidence is required",
      },
      {
        script: "scripts/verify-deploy-button-evidence.mjs",
        env: {
          CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE: "1",
          CF_AUTH_DEPLOY_BUTTON_EVIDENCE_PATH: join(dir, "deploy-button.json"),
        },
        message: "Deploy to Cloudflare button evidence is required",
      },
      {
        script: "scripts/verify-package-ownership.mjs",
        env: {
          CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP: "1",
          CF_AUTH_PACKAGE_OWNERSHIP_PATH: join(dir, "package-ownership.json"),
        },
        message: "package ownership evidence is required",
      },
      {
        script: "scripts/verify-security-release-tracker.mjs",
        env: {
          CF_AUTH_REQUIRE_SECURITY_TRACKER: "1",
          CF_AUTH_SECURITY_TRACKER_PATH: join(dir, "security-tracker.json"),
        },
        message: "security release tracker is required",
      },
    ];

    for (const item of cases) {
      const result = runScript(item.script, item.env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(item.message);
    }
  });

  it("requires alpha evidence for stable package versions", async () => {
    const cwd = await packageVersionFixture("1.0.0");
    const result = runScript("scripts/verify-alpha-evidence.mjs", {}, cwd);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "private-alpha evidence is required before public beta or stable release",
    );
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

  it("rejects beta production smoke commands without package tag proof", async () => {
    const evidence = validBetaEvidence();
    evidence.productionSmoke.commands = evidence.productionSmoke.commands.map(
      (command) => command.replace("@cf-auth/cli@beta", "@cf-auth/cli@latest"),
    );
    const path = await writeEvidence("beta-missing-package-command", evidence);
    const result = runScript("scripts/verify-beta-evidence.mjs", {
      CF_AUTH_REQUIRE_BETA_EVIDENCE: "1",
      CF_AUTH_BETA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@cf-auth/cli@beta");
  });

  it("rejects beta evidence that uses a non-beta package tag", async () => {
    const evidence = validBetaEvidence();
    evidence.publishedQuickstart.packageTag = "latest";
    evidence.manualQuickstart.packageTag = "latest";
    evidence.productionSmoke.packageTag = "latest";
    const path = await writeEvidence("beta-latest-tag", evidence);
    const result = runScript("scripts/verify-beta-evidence.mjs", {
      CF_AUTH_REQUIRE_BETA_EVIDENCE: "1",
      CF_AUTH_BETA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("publishedQuickstart.packageTag");
    expect(result.stderr).toContain("manualQuickstart.packageTag");
    expect(result.stderr).toContain("productionSmoke.packageTag");
  });

  it("rejects beta evidence without GitHub Actions workflow proof", async () => {
    const evidence = validBetaEvidence();
    evidence.publishedQuickstart.workflowRunUrl =
      "https://ci.example.test/runs/123";
    evidence.productionSmoke.workflowRunUrl =
      "https://github.com/acme/cloudflare-auth/actions";
    const path = await writeEvidence("beta-non-github-workflow", evidence);
    const result = runScript("scripts/verify-beta-evidence.mjs", {
      CF_AUTH_REQUIRE_BETA_EVIDENCE: "1",
      CF_AUTH_BETA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("publishedQuickstart.workflowRunUrl");
    expect(result.stderr).toContain("productionSmoke.workflowRunUrl");
    expect(result.stderr).toContain("GitHub Actions run URL");
  });

  it("rejects beta evidence with raw IPv6 addresses", async () => {
    const evidence = validBetaEvidence();
    (evidence.productionSmoke as Record<string, unknown>).notes =
      "deployment came from 2001:db8::1";
    const path = await writeEvidence("beta-ipv6", evidence);
    const result = runScript("scripts/verify-beta-evidence.mjs", {
      CF_AUTH_REQUIRE_BETA_EVIDENCE: "1",
      CF_AUTH_BETA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not include raw secrets");
    expect(result.stderr).toContain("IPs");
  });

  it("rejects beta evidence with raw user agents", async () => {
    const evidence = validBetaEvidence();
    (evidence.productionSmoke as Record<string, unknown>).userAgent =
      "Mozilla/5.0 Evidence Browser";
    const path = await writeEvidence("beta-user-agent", evidence);
    const result = runScript("scripts/verify-beta-evidence.mjs", {
      CF_AUTH_REQUIRE_BETA_EVIDENCE: "1",
      CF_AUTH_BETA_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not include raw secrets");
    expect(result.stderr).toContain("user agents");
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

  it("rejects deploy button evidence that uses a non-beta package tag", async () => {
    const evidence = validDeployButtonEvidence();
    evidence.packageTag = "latest";
    const path = await writeEvidence("deploy-button-latest-tag", evidence);
    const result = runScript("scripts/verify-deploy-button-evidence.mjs", {
      CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE: "1",
      CF_AUTH_DEPLOY_BUTTON_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packageTag");
  });

  it("rejects deploy button evidence whose button URL uses another template", async () => {
    const evidence = validDeployButtonEvidence();
    evidence.deployButtonUrl =
      "https://deploy.workers.cloudflare.com/?url=https://github.com/acme/other-template";
    const path = await writeEvidence(
      "deploy-button-template-mismatch",
      evidence,
    );
    const result = runScript("scripts/verify-deploy-button-evidence.mjs", {
      CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE: "1",
      CF_AUTH_DEPLOY_BUTTON_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("deployButtonUrl url parameter");
    expect(result.stderr).toContain("templateRepositoryUrl");
  });

  it("rejects deploy button evidence with unsupported repository and button URLs", async () => {
    const evidence = validDeployButtonEvidence();
    evidence.templateRepositoryUrl = "https://example.org/acme/template";
    evidence.deployButtonUrl =
      "https://deploy.workers.cloudflare.com/?url=https://example.org/acme/template&debug=true";
    const path = await writeEvidence("deploy-button-unsupported-url", evidence);
    const result = runScript("scripts/verify-deploy-button-evidence.mjs", {
      CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE: "1",
      CF_AUTH_DEPLOY_BUTTON_EVIDENCE_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("templateRepositoryUrl");
    expect(result.stderr).toContain("GitHub or GitLab repository URL");
    expect(result.stderr).toContain("deployButtonUrl");
    expect(result.stderr).toContain("only the url parameter");
  });

  it("rejects deploy button evidence with raw emails, IPs, and user agents", async () => {
    const emailEvidence = validDeployButtonEvidence();
    (emailEvidence as Record<string, unknown>).notes =
      "verified by person@example.com";
    const emailPath = await writeEvidence("deploy-button-email", emailEvidence);
    const emailResult = runScript("scripts/verify-deploy-button-evidence.mjs", {
      CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE: "1",
      CF_AUTH_DEPLOY_BUTTON_EVIDENCE_PATH: emailPath,
    });

    const ipEvidence = validDeployButtonEvidence();
    (ipEvidence as Record<string, unknown>).notes = "smoked from [2001:db8::1]";
    const ipPath = await writeEvidence("deploy-button-ipv6", ipEvidence);
    const ipResult = runScript("scripts/verify-deploy-button-evidence.mjs", {
      CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE: "1",
      CF_AUTH_DEPLOY_BUTTON_EVIDENCE_PATH: ipPath,
    });

    const userAgentEvidence = validDeployButtonEvidence();
    (userAgentEvidence as Record<string, unknown>).userAgent =
      "Mozilla/5.0 Evidence Browser";
    const userAgentPath = await writeEvidence(
      "deploy-button-user-agent",
      userAgentEvidence,
    );
    const userAgentResult = runScript(
      "scripts/verify-deploy-button-evidence.mjs",
      {
        CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE: "1",
        CF_AUTH_DEPLOY_BUTTON_EVIDENCE_PATH: userAgentPath,
      },
    );

    expect(emailResult.status).toBe(1);
    expect(emailResult.stderr).toContain("must not include raw secrets");
    expect(emailResult.stderr).toContain("emails");
    expect(ipResult.status).toBe(1);
    expect(ipResult.stderr).toContain("must not include raw secrets");
    expect(ipResult.stderr).toContain("IPs");
    expect(userAgentResult.status).toBe(1);
    expect(userAgentResult.stderr).toContain("must not include raw secrets");
    expect(userAgentResult.stderr).toContain("user agents");
  });

  it("requires deploy button evidence for stable package versions", async () => {
    const cwd = await packageVersionFixture("1.0.0");
    const result = runScript(
      "scripts/verify-deploy-button-evidence.mjs",
      {},
      cwd,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Deploy to Cloudflare button evidence is required",
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

  it("rejects reserved package evidence after a shim becomes publishable", async () => {
    const cwd = await packageOwnershipFixture({
      publishCfAuthShim: true,
      staleCfAuthReservation: true,
      publishCreatePackage: false,
      staleCreateReservation: false,
    });
    const result = runScript(
      "scripts/verify-package-ownership.mjs",
      {
        CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP: "1",
        CF_AUTH_PACKAGE_OWNERSHIP_PATH: join(
          cwd,
          "docs",
          "package-ownership.json",
        ),
      },
      cwd,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cf-auth");
    expect(result.stderr).toContain(
      "must not be listed under reservedPackages",
    );
  });

  it("rejects reserved package evidence after the create package becomes publishable", async () => {
    const cwd = await packageOwnershipFixture({
      publishCfAuthShim: false,
      staleCfAuthReservation: false,
      publishCreatePackage: true,
      staleCreateReservation: true,
    });
    const result = runScript(
      "scripts/verify-package-ownership.mjs",
      {
        CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP: "1",
        CF_AUTH_PACKAGE_OWNERSHIP_PATH: join(
          cwd,
          "docs",
          "package-ownership.json",
        ),
      },
      cwd,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("create-cloudflare-auth");
    expect(result.stderr).toContain(
      "must not be listed under reservedPackages",
    );
  });

  it("rejects package ownership evidence without target package versions", async () => {
    const evidence = validPackageEvidence();
    delete (evidence.packages[0] as Record<string, unknown>).version;
    const path = await writeEvidence(
      "package-ownership-missing-version",
      evidence,
    );
    const result = runScript("scripts/verify-package-ownership.mjs", {
      CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP: "1",
      CF_AUTH_PACKAGE_OWNERSHIP_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("packages[0].version");
  });

  it("rejects package ownership evidence with raw emails, IPs, and user agents", async () => {
    const emailEvidence = validPackageEvidence();
    (emailEvidence as Record<string, unknown>).notes =
      "verified by person@example.com";
    const emailPath = await writeEvidence(
      "package-ownership-email",
      emailEvidence,
    );
    const emailResult = runScript("scripts/verify-package-ownership.mjs", {
      CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP: "1",
      CF_AUTH_PACKAGE_OWNERSHIP_PATH: emailPath,
    });

    const ipEvidence = validPackageEvidence();
    (ipEvidence as Record<string, unknown>).notes = "verified from 2001:db8::1";
    const ipPath = await writeEvidence("package-ownership-ipv6", ipEvidence);
    const ipResult = runScript("scripts/verify-package-ownership.mjs", {
      CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP: "1",
      CF_AUTH_PACKAGE_OWNERSHIP_PATH: ipPath,
    });

    const userAgentEvidence = validPackageEvidence();
    (userAgentEvidence as Record<string, unknown>).userAgent =
      "Mozilla/5.0 Evidence Browser";
    const userAgentPath = await writeEvidence(
      "package-ownership-user-agent",
      userAgentEvidence,
    );
    const userAgentResult = runScript("scripts/verify-package-ownership.mjs", {
      CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP: "1",
      CF_AUTH_PACKAGE_OWNERSHIP_PATH: userAgentPath,
    });

    expect(emailResult.status).toBe(1);
    expect(emailResult.stderr).toContain("must not include raw secrets");
    expect(emailResult.stderr).toContain("emails");
    expect(ipResult.status).toBe(1);
    expect(ipResult.stderr).toContain("must not include raw secrets");
    expect(ipResult.stderr).toContain("IPs");
    expect(userAgentResult.status).toBe(1);
    expect(userAgentResult.stderr).toContain("must not include raw secrets");
    expect(userAgentResult.stderr).toContain("user agents");
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

  it("rejects security tracker evidence with raw IPv6 addresses", async () => {
    const evidence = validSecurityTracker();
    (evidence as Record<string, unknown>).reviewNotes =
      "triaged from 2001:db8::1";
    const path = await writeEvidence("security-tracker-ipv6", evidence);
    const result = runScript("scripts/verify-security-release-tracker.mjs", {
      CF_AUTH_REQUIRE_SECURITY_TRACKER: "1",
      CF_AUTH_SECURITY_TRACKER_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not include raw secrets");
    expect(result.stderr).toContain("IPs");
  });

  it("rejects security tracker evidence with raw user agents", async () => {
    const evidence = validSecurityTracker();
    (evidence as Record<string, unknown>).userAgent =
      "Mozilla/5.0 Evidence Browser";
    const path = await writeEvidence("security-tracker-user-agent", evidence);
    const result = runScript("scripts/verify-security-release-tracker.mjs", {
      CF_AUTH_REQUIRE_SECURITY_TRACKER: "1",
      CF_AUTH_SECURITY_TRACKER_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not include raw secrets");
    expect(result.stderr).toContain("user agents");
  });

  it("rejects security tracker evidence with incomplete search URLs", async () => {
    const evidence = validSecurityTracker();
    evidence.issueSearchUrl =
      "https://github.com/acme/cloudflare-auth/issues?q=is%3Aissue%20is%3Aopen%20label%3Aauth";
    evidence.advisorySearchUrl =
      "https://github.com/acme/cloudflare-auth/issues?q=is%3Aopen";
    const path = await writeEvidence(
      "security-tracker-incomplete-url",
      evidence,
    );
    const result = runScript("scripts/verify-security-release-tracker.mjs", {
      CF_AUTH_REQUIRE_SECURITY_TRACKER: "1",
      CF_AUTH_SECURITY_TRACKER_PATH: path,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("open high/critical auth issues");
    expect(result.stderr).toContain("GitHub repository security advisory URL");
  });

  it("rejects security tracker URLs that are not scoped to one repository", async () => {
    const rootIssueEvidence = validSecurityTracker();
    rootIssueEvidence.issueSearchUrl =
      "https://github.com/issues?q=is%3Aissue%20is%3Aopen%20label%3Aauth%20label%3Ahigh%2Ccritical";
    const rootIssuePath = await writeEvidence(
      "security-tracker-root-issues",
      rootIssueEvidence,
    );
    const rootIssueResult = runScript(
      "scripts/verify-security-release-tracker.mjs",
      {
        CF_AUTH_REQUIRE_SECURITY_TRACKER: "1",
        CF_AUTH_SECURITY_TRACKER_PATH: rootIssuePath,
      },
    );

    const mismatchEvidence = validSecurityTracker();
    mismatchEvidence.advisorySearchUrl =
      "https://github.com/acme/other-auth/security/advisories";
    const mismatchPath = await writeEvidence(
      "security-tracker-repo-mismatch",
      mismatchEvidence,
    );
    const mismatchResult = runScript(
      "scripts/verify-security-release-tracker.mjs",
      {
        CF_AUTH_REQUIRE_SECURITY_TRACKER: "1",
        CF_AUTH_SECURITY_TRACKER_PATH: mismatchPath,
      },
    );

    expect(rootIssueResult.status).toBe(1);
    expect(rootIssueResult.stderr).toContain(
      "GitHub repository issues search URL",
    );
    expect(mismatchResult.status).toBe(1);
    expect(mismatchResult.stderr).toContain("same GitHub repository");
  });
});

async function writeEvidence(name: string, value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `cf-auth-${name}-`));
  const path = join(dir, "evidence.json");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

async function packageVersionFixture(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cf-auth-package-version-"));
  const packageDir = join(root, "packages", "cli");
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    `${JSON.stringify({ name: "@cf-auth/cli", version })}\n`,
  );
  return root;
}

async function packageOwnershipFixture(options: {
  publishCfAuthShim: boolean;
  staleCfAuthReservation: boolean;
  publishCreatePackage: boolean;
  staleCreateReservation: boolean;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cf-auth-package-ownership-"));
  await mkdir(join(root, "packages", "cli"), { recursive: true });
  await mkdir(join(root, "packages", "cf-auth-shim"), { recursive: true });
  await mkdir(join(root, "packages", "create-cloudflare-auth"), {
    recursive: true,
  });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "packages", "cli", "package.json"),
    `${JSON.stringify({ name: "@cf-auth/cli", version: "0.1.0-beta.0" })}\n`,
  );
  await writeFile(
    join(root, "packages", "cf-auth-shim", "package.json"),
    `${JSON.stringify({
      name: "cf-auth",
      version: "0.1.0-beta.0",
      private: !options.publishCfAuthShim,
    })}\n`,
  );
  await writeFile(
    join(root, "packages", "create-cloudflare-auth", "package.json"),
    `${JSON.stringify({
      name: "create-cloudflare-auth",
      version: "0.1.0-beta.0",
      private: !options.publishCreatePackage,
    })}\n`,
  );
  await writeFile(
    join(root, "docs", "package-ownership.json"),
    `${JSON.stringify(packageOwnershipFixtureEvidence(options), null, 2)}\n`,
  );
  return root;
}

function packageOwnershipFixtureEvidence(options: {
  publishCfAuthShim: boolean;
  staleCfAuthReservation: boolean;
  publishCreatePackage: boolean;
  staleCreateReservation: boolean;
}) {
  const packages = ["@cf-auth/cli"];
  if (options.publishCfAuthShim) packages.push("cf-auth");
  if (options.publishCreatePackage) packages.push("create-cloudflare-auth");
  return {
    schemaVersion: 1,
    verifiedAt: "2026-05-14T00:00:00.000Z",
    verifiedBy: "release-reviewer",
    packages: packages.map((name) => ({
      name,
      registry: "https://registry.npmjs.org/",
      version: "0.1.0-beta.0",
      ownershipConfirmed: true,
      publisherTwoFactorEnabled: true,
      provenancePublish: true,
    })),
    reservedPackages: [
      ...(options.publishCfAuthShim && !options.staleCfAuthReservation
        ? []
        : [
            {
              name: "cf-auth",
              registry: "https://registry.npmjs.org/",
              registryVersion: "1.0.2",
              publishableAfterOwnershipConfirmed: true,
            },
          ]),
      ...(options.publishCreatePackage && !options.staleCreateReservation
        ? []
        : [
            {
              name: "create-cloudflare-auth",
              registry: "https://registry.npmjs.org/",
              publishableAfterOwnershipConfirmed: true,
            },
          ]),
    ],
  };
}

function runScript(
  script: string,
  env: Record<string, string>,
  cwd = process.cwd(),
) {
  return spawnSync(process.execPath, [join(process.cwd(), script)], {
    cwd,
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
        "npx --package @cf-auth/cli@alpha cf-auth doctor --report --env production",
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
    packageTag: "beta",
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
