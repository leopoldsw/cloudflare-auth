import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("release gates", () => {
  it("requires deploy button evidence when packages enter public beta", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: false });
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/deploy-button-evidence.json");
  });

  it("accepts beta package gates when deploy button evidence is present", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    const result = runReleaseGates(root);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release gates passed");
  });

  it("runs evidence verifiers instead of accepting marker-only files", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    const evidence = validDeployButtonEvidence();
    evidence.templateRepositoryUrl = "https://example.org/acme/template";
    evidence.deployButtonUrl =
      "https://deploy.workers.cloudflare.com/?url=https://example.org/acme/template";
    await writeFixtureFile(
      root,
      "docs/deploy-button-evidence.json",
      JSON.stringify(evidence, null, 2),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "scripts/verify-deploy-button-evidence.mjs",
    );
    expect(result.stderr).toContain("GitHub or GitLab repository URL");
  });

  it("runs local release verifiers instead of checking only that scripts exist", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "scripts/export-deploy-template.mjs",
      'process.stderr.write("deploy template broken"); process.exit(1);',
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-deploy-template.mjs");
    expect(result.stderr).toContain("deploy template broken");
  });

  it("runs example and template verifiers in release gates", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "examples/hono-basic/wrangler.jsonc",
      JSON.stringify(
        {
          $schema: "./node_modules/wrangler/config-schema.json",
          compatibility_date: "2026-05-14",
          compatibility_flags: ["nodejs_compat"],
          vars: {
            AUTH_ENV: "development",
            AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
          },
          d1_databases: [
            {
              binding: "AUTH_DB",
              database_name: "auth",
              database_id: "local-development",
            },
          ],
        },
        null,
        2,
      ),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-examples.mjs");
    expect(result.stderr).toContain("must enable observability");
  });

  it("runs public API docs coverage for root-export symbols", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    const docsPath = join(root, "docs", "api.md");
    const docs = await readFile(docsPath, "utf8");
    await writeFile(docsPath, docs.replace("hashPassword", "hash_password"));
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-docs-coverage.mjs");
    expect(result.stderr).toContain("docs/api.md: missing hashPassword");
  });

  it("derives public API docs coverage from package root exports", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "packages/cli/src/index.ts",
      "export function uncoveredRootExport() {}",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-docs-coverage.mjs");
    expect(result.stderr).toContain("docs/api.md: missing uncoveredRootExport");
    expect(result.stderr).toContain(
      "docs/api-report.md: missing uncoveredRootExport",
    );
  });

  it("requires config schema docs for every stable config key", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "docs/config-schema.md",
      "passwordHashing.queueTimeoutMs",
      "passwordHashing.timeoutMs",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-docs-coverage.mjs");
    expect(result.stderr).toContain(
      "docs/config-schema.md: missing passwordHashing.queueTimeoutMs",
    );
  });

  it("requires password benchmark evidence in release gates", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "docs/decisions/password-benchmark.md",
      [
        "workers-balanced",
        "warmupHashes",
        "measuredHashes",
        "p50Ms",
        "p95Ms",
        "pnpm benchmark:password",
      ].join("\n"),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/decisions/password-benchmark.md");
    expect(result.stderr).toContain("workers-local");
    expect(result.stderr).toContain("throughputHashesPerSecond");
  });

  it("requires security policy operational checks", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "SECURITY.md",
      "push protection",
      "push safeguards",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SECURITY.md");
    expect(result.stderr).toContain("push protection");
  });

  it("requires security model evidence links to resolve", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "docs/security-model.md",
      "| Bot pressure | mitigation | [tests](../tests/routes.test.ts) |",
      "| Bot pressure | mitigation | [tests](../tests/routes.test.ts), [docs](missing-turnstile.md) |",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-security-docs.mjs");
    expect(result.stderr).toContain("Bot pressure");
    expect(result.stderr).toContain("missing-turnstile.md");
  });

  it("requires production password hashing in examples and generated templates", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "templates/hono-basic/src/auth.config.ts",
      "export default defineAuthConfig({ appName: 'Template', basePath: '/auth' });",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-examples.mjs");
    expect(result.stderr).toContain(
      'templates/hono-basic: auth config missing profile: "workers-balanced"',
    );
  });

  it("requires production password hashing in examples", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "examples/hono-basic/src/auth.config.ts",
      "export default defineAuthConfig({ appName: 'Example', basePath: '/auth' });",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-examples.mjs");
    expect(result.stderr).toContain(
      'examples/hono-basic: auth config missing profile: "workers-balanced"',
    );
  });

  it("runs package-name registry checks for release packages", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFakeNpm(
      root,
      `const args = process.argv.slice(2);
const spec = args[1] ?? "";
if (spec === "@cf-auth/cli@0.1.0-beta.0") {
  console.log(JSON.stringify("0.1.0-beta.0"));
  process.exit(0);
}
console.error("npm error code E404");
process.exit(1);
`,
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/check-package-names.mjs");
    expect(result.stderr).toContain(
      "@cf-auth/cli@0.1.0-beta.0: target version already exists on npm",
    );
  });

  it("rejects release versions outside the planned alpha, beta, and stable channels", async () => {
    for (const packageVersion of ["0.1.0", "1.0.0-rc.0"]) {
      const root = await releaseGateFixture({
        deployButtonEvidence: true,
        packageVersion,
      });
      const result = runReleaseGates(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`@cf-auth/cli@${packageVersion}`);
      expect(result.stderr).toContain("alpha, beta, or stable 1.0+");
    }
  }, 20_000);

  it("accepts alpha package gates before beta evidence is required", async () => {
    const root = await releaseGateFixture({
      alphaEvidence: false,
      deployButtonEvidence: false,
      packageVersion: "0.1.0-alpha.0",
    });
    const result = runReleaseGates(root);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release gates passed");
  });

  it("requires stable release artifacts when packages enter 1.0", async () => {
    const root = await releaseGateFixture({
      deployButtonEvidence: true,
      packageVersion: "1.0.0",
      stableEvidence: false,
    });
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/beta-evidence.json");
    expect(result.stderr).toContain("docs/api-report.md");
    expect(result.stderr).toContain("docs/config-schema.md");
    expect(result.stderr).toContain("docs/decisions/security-review.md");
    expect(result.stderr).toContain("docs/security-release-tracker.json");
    expect(result.stderr).toContain(
      "tests/fixtures/upgrade/beta-schema-versions.json",
    );
  });

  it("requires alpha evidence when packages enter 1.0", async () => {
    const root = await releaseGateFixture({
      alphaEvidence: false,
      deployButtonEvidence: true,
      packageVersion: "1.0.0",
      stableEvidence: true,
    });
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/alpha-evidence.json");
  });

  it("accepts stable release gates when 1.0 artifacts are present", async () => {
    const root = await releaseGateFixture({
      deployButtonEvidence: true,
      packageVersion: "1.0.0",
      stableEvidence: true,
    });
    const result = runReleaseGates(root);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "stable gates checked for @cf-auth/cli@1.0.0",
    );
  });

  it("rejects malformed stable beta upgrade fixture manifests", async () => {
    const root = await releaseGateFixture({
      deployButtonEvidence: true,
      packageVersion: "1.0.0",
      stableEvidence: true,
    });
    await writeFixtureFile(
      root,
      "tests/fixtures/upgrade/beta-schema-versions.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          betaVersions: [
            { version: "1.0.0-beta.0" },
            {
              version: "not-a-version",
              schemaVersion: 1,
              fixture: "../outside",
            },
          ],
        },
        null,
        2,
      ),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("betaVersions[0].schemaVersion");
    expect(result.stderr).toContain("betaVersions[0].fixture");
    expect(result.stderr).toContain("betaVersions[1].version");
    expect(result.stderr).toContain("betaVersions[1].fixture");
  });
});

interface ReleaseGateFixtureOptions {
  alphaEvidence?: boolean;
  deployButtonEvidence: boolean;
  packageVersion?: string;
  stableEvidence?: boolean;
}

async function releaseGateFixture(options: ReleaseGateFixtureOptions) {
  const root = await mkdtemp(join(tmpdir(), "cf-auth-release-gates-"));
  await writeFakeNpm(root);

  const requiredFiles = [
    ".github/dependabot.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/codeql.yml",
    ".github/workflows/cloudflare-production-smoke.yml",
    ".github/workflows/dependency-review.yml",
    ".github/workflows/examples.yml",
    ".github/workflows/published-quickstart-smoke.yml",
    ".github/workflows/release.yml",
    ".github/workflows/wrangler-dev-smoke.yml",
    ".github/ISSUE_TEMPLATE/alpha-feedback.yml",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/ISSUE_TEMPLATE/feature-request.yml",
    ".github/ISSUE_TEMPLATE/security-contact.md",
    "docs/alpha-evidence.example.json",
    "docs/alpha.md",
    "docs/beta-evidence.example.json",
    "docs/decisions/password-benchmark.md",
    "docs/deploy-button-evidence.example.json",
    "docs/deploy-to-cloudflare.md",
    "docs/known-limitations.md",
    "docs/package-ownership.example.json",
    "docs/public-beta.md",
    "docs/security-release-tracker.example.json",
    "schemas/doctor-report.schema.json",
    "scripts/export-deploy-template.mjs",
    "scripts/check-package-names.mjs",
    "scripts/verify-alpha-evidence.mjs",
    "scripts/verify-beta-evidence.mjs",
    "scripts/verify-deploy-button-evidence.mjs",
    "scripts/verify-deploy-template.mjs",
    "scripts/verify-docs-coverage.mjs",
    "scripts/verify-examples.mjs",
    "scripts/verify-migrations.mjs",
    "scripts/verify-package-ownership.mjs",
    "scripts/verify-security-docs.mjs",
    "scripts/verify-security-release-tracker.mjs",
  ];

  const requiredText = new Map<string, string[]>([
    ["README.md", ["SECURITY.md", "docs/known-limitations.md"]],
    [
      "SECURITY.md",
      [
        "Supported Versions",
        "Reporting A Vulnerability",
        "Expected Response Window",
        "secret scanning",
        "push protection",
        "advisory evidence only",
      ],
    ],
    [
      "docs/decisions/password-benchmark.md",
      [
        "workers-local",
        "p95Ms",
        "throughputHashesPerSecond",
        "pnpm benchmark:password",
      ],
    ],
    [
      "docs/release-checklist.md",
      [
        "unresolved high/critical",
        "public API report reviewed",
        "config schema reviewed",
        "security review decision",
        "pnpm verify:security-docs",
        "opt-in Wrangler dev smoke workflow passes",
      ],
    ],
    [
      ".github/workflows/dependency-review.yml",
      ["actions/dependency-review-action"],
    ],
    [".github/workflows/codeql.yml", ["javascript-typescript"]],
    [
      ".github/dependabot.yml",
      ["package-ecosystem: npm", "package-ecosystem: github-actions"],
    ],
    [".github/ISSUE_TEMPLATE/alpha-feedback.yml", ["doctor --report"]],
    [
      "docs/alpha.md",
      [
        "CF_AUTH_REQUIRE_ALPHA_EVIDENCE=1 pnpm verify:alpha-evidence",
        "doctor --report",
      ],
    ],
    [
      "docs/decisions/package-naming.md",
      ["CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership"],
    ],
    [
      "docs/alpha-evidence.example.json",
      [
        '"commands"',
        "cf-auth init",
        "cf-auth migrate --local",
        "pnpm install",
        "npm run dev",
        '"doctorReportSchemaValid"',
        '"doctorReportRedactionChecked"',
      ],
    ],
    [
      "docs/deploy-to-cloudflare.md",
      [
        "Deploy to Cloudflare button is a public-beta gate",
        "CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE=1 pnpm verify:deploy-button-evidence",
      ],
    ],
    [
      "docs/public-beta.md",
      [
        "CF_AUTH_REQUIRE_BETA_EVIDENCE=1 pnpm verify:beta-evidence",
        "docs/known-limitations.md",
        "pnpm verify:beta-evidence",
        "pnpm verify:deploy-button-evidence",
        "pnpm verify:package-ownership",
        ".github/workflows/published-quickstart-smoke.yml",
        ".github/workflows/cloudflare-production-smoke.yml",
      ],
    ],
    [
      "docs/beta-evidence.example.json",
      [
        '"cleanDirectory"',
        '"documentedCommandsOnly"',
        '"optInCloudflareAccountFixture"',
        '"commands"',
        "cf-auth init",
        "cf-auth migrate --local",
        "pnpm install",
        "npm run dev",
        "/auth/logout",
      ],
    ],
    [
      "docs/deploy-button-evidence.example.json",
      [
        "/auth/logout",
        '"starterTemplateCreated"',
        '"documentedPathFollowed"',
        '"packageTag"',
      ],
    ],
    [".github/workflows/wrangler-dev-smoke.yml", ["pnpm smoke:wrangler-dev"]],
    [
      ".github/workflows/release.yml",
      [
        "package_names_confirmed",
        "pnpm install --frozen-lockfile",
        "pnpm package:check",
        "pnpm release:gates",
        "pnpm publish:dry-run",
        "pnpm-publish-summary.json",
        "pnpm changeset publish --provenance",
      ],
    ],
  ]);

  for (const file of new Set([...requiredFiles, ...requiredText.keys()])) {
    await writeFixtureFile(
      root,
      file,
      requiredText.get(file)?.join("\n") ?? "",
    );
  }
  await writeLocalVerifierFixtures(root);

  const packageVersion = options.packageVersion ?? "0.1.0-beta.0";
  await writePackage(root, packageVersion);
  await writeFixtureFile(
    root,
    "docs/package-ownership.json",
    JSON.stringify(validPackageEvidence(packageVersion), null, 2),
  );
  if (options.alphaEvidence ?? true) {
    await writeFixtureFile(
      root,
      "docs/alpha-evidence.json",
      JSON.stringify(validAlphaEvidence(), null, 2),
    );
  }
  if (options.deployButtonEvidence) {
    await writeFixtureFile(
      root,
      "docs/deploy-button-evidence.json",
      JSON.stringify(validDeployButtonEvidence(), null, 2),
    );
  }
  if (options.stableEvidence) {
    await writeStableEvidence(root);
  }

  return root;
}

async function writePackage(root: string, version: string) {
  const packageDir = join(root, "packages", "cli");
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    `${JSON.stringify({
      name: "@cf-auth/cli",
      version,
    })}\n`,
  );
  await writeFile(join(packageDir, "CHANGELOG.md"), `${version}\n`);
}

async function writeLocalVerifierFixtures(root: string) {
  await writeDocsCoverageFixtures(root);
  await writeSecurityDocsFixtures(root);
  await writeMigrationFixtures(root);
  await writeExamplesFixtures(root);
  await writeDeployTemplateFixtures(root);
}

const configFixtureKeys = [
  "appName",
  "basePath",
  "runtime.mode",
  "runtime.publicOrigin",
  "runtime.trustedHosts",
  "database.binding",
  "session.cookieName",
  "session.maxAgeDays",
  "session.sameSite",
  "session.secure",
  "session.domain",
  "session.requireVerifiedEmail",
  "request.maxBodyBytes",
  "request.requireOriginOnUnsafeMethods",
  "request.enumerationMinResponseMs",
  "request.enumerationJitterMs",
  "security.allowedRequestOrigins",
  "security.allowedPreviewRequestOrigins",
  "passwordHashing.profile",
  "passwordHashing.maxConcurrentHashesPerIsolate",
  "passwordHashing.queueTimeoutMs",
  "signup.enabled",
  "signup.requireEmailVerificationBeforeSession",
  "signup.enumerationSafe",
  "signup.username.enabled",
  "signup.username.required",
  "login.emailPassword",
  "login.usernamePassword",
  "login.magicLink",
  "login.requireVerifiedEmail",
  "magicLink.allowSignups",
  "magicLink.expiresInMinutes",
  "magicLink.activeTokenPolicy",
  "passwordReset.enabled",
  "passwordReset.expiresInMinutes",
  "passwordReset.revokeExistingSessions",
  "passwordReset.createSessionAfterReset",
  "passwordReset.markEmailVerifiedOnReset",
  "passwordReset.activeTokenPolicy",
  "emailVerification.enabled",
  "emailVerification.expiresInHours",
  "emailVerification.createSessionAfterVerification",
  "emailVerification.activeTokenPolicy",
  "turnstile.mode",
  "turnstile.endpoints",
  "turnstile.verify",
  "email",
  "redirects.defaultAfterLogin",
  "redirects.defaultAfterLogout",
  "redirects.defaultAfterEmailVerification",
  "redirects.defaultAfterPasswordReset",
  "redirects.allowedOrigins",
  "redirects.allowedPreviewOrigins",
];

function configSchemaFixtureText(releaseApproval: string) {
  return [
    releaseApproval,
    "AUTH_DB",
    "AUTH_SECRET",
    "AUTH_SECRET_PREVIOUS",
    "AUTH_ENV",
    "AUTH_PUBLIC_ORIGIN",
    "TURNSTILE_SECRET_KEY",
    "AUTH_RATE_LIMITER",
    "AUTH_EMAIL",
    ...configFixtureKeys,
  ].join("\n");
}

async function writeDocsCoverageFixtures(root: string) {
  await writeFixtureFile(
    root,
    "docs/cli.md",
    [
      "cf-auth init",
      "cf-auth migrate",
      "cf-auth doctor",
      "cf-auth deploy",
      "cf-auth generate",
      "cf-auth rotate-secret",
      "cf-auth clean",
      "cf-auth users disable",
      "cf-auth users enable",
      "cf-auth sessions revoke",
      "cf-auth sessions list",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/configuration.md",
    configFixtureKeys.join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/config-schema.md",
    configSchemaFixtureText("Release approval: pending."),
  );
  await writeFixtureFile(root, "docs/api-report.md", "Public API Report");
  await writeFixtureFile(
    root,
    "docs/api.md",
    [
      "POST /auth/signup",
      "POST /auth/login",
      "POST /auth/logout",
      "GET /auth/user",
      "POST /auth/magic-link/request",
      "GET /auth/magic-link/verify",
      "POST /auth/magic-link/consume",
      "POST /auth/email/verify/request",
      "GET /auth/email/verify",
      "POST /auth/email/verify/consume",
      "POST /auth/password/reset/request",
      "GET /auth/password/reset",
      "POST /auth/password/reset/confirm",
      "GET /auth/dev/emails",
      "Referrer-Policy: no-referrer",
      "history entry",
      "cf-auth",
      "@cf-auth/cli",
      "create-cloudflare-auth",
      "@cf-auth/core",
      "@cf-auth/worker",
      "@cf-auth/hono",
      "@cf-auth/client",
      "@cf-auth/email-cloudflare",
      "@cf-auth/testing",
      "runCli",
      "createAuthClient",
      "AuthClientError",
      "normalizeEmail",
      "validateRedirectTarget",
      "parseAuthKeyRing",
      "hashPassword",
      "resolveSessionCookie",
      "defineAuthConfig",
      "createAuthHandler",
      "getSession",
      "getUser",
      "requireUser",
      "requireVerifiedUser",
      "getAuthSessionFromRequest",
      "createD1Repositories",
      "cleanCfAuth",
      "terminalEmail",
      "byEnvironment",
      "verifyTurnstileToken",
      "turnstileEndpointNames",
      "cloudflareRateLimitPrefilter",
      "redactLogValue",
      "createAuthRoutes",
      "getAuthUser",
      "optionalUser",
      "cloudflareEmail",
      "defaultMagicLinkTemplate",
      "defaultEmailVerificationTemplate",
      "defaultPasswordResetTemplate",
      "createSqliteD1Database",
      "applyD1Migrations",
      "createMockEmailAdapter",
      "Default retention windows",
      "non-negative integer",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/migrations.md",
    [
      "cf-auth migrate --local",
      "cf-auth migrate --remote --env production",
      "cf-auth migrate --status --local",
      "cf-auth migrate --status --remote --env production",
      "cleanCfAuth",
      "ctx.waitUntil",
      "non-negative integer",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/deployment.md",
    [
      "cf-auth doctor --env production",
      "cf-auth migrate --remote --env production",
      "cf-auth deploy --env production",
      "AUTH_PUBLIC_ORIGIN",
      "AUTH_SECRET",
      "AUTH_DB.database_id",
      "AUTH_EMAIL",
      "/auth/logout",
    ].join("\n"),
  );
}

async function writeSecurityDocsFixtures(root: string) {
  const threatRows = [
    "Account enumeration",
    "Credential stuffing",
    "Brute-force login",
    "Reset email abuse",
    "Magic-link abuse",
    "Email link scanners",
    "Token replay",
    "Token leakage",
    "Open redirects",
    "CSRF",
    "Session theft",
    "Session fixation",
    "D1 consistency/concurrency",
    "Email delivery failure",
    "Secret rotation",
    "Permissive CORS middleware",
    "Raw PII in logs",
    "Bot pressure",
    "Edge floods",
    "Operational blind spots",
  ].map(
    (threat) => `| ${threat} | mitigation | [tests](../tests/routes.test.ts) |`,
  );
  await writeFixtureFile(root, "tests/routes.test.ts", "route tests\n");
  await writeFixtureFile(
    root,
    "docs/security-model.md",
    [
      ...threatRows,
      "Optional Turnstile checks before account-specific branching",
      "Optional Cloudflare rate-limit binding before D1 counters",
      "scrub browser history",
      "Known residual risks",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/turnstile.md",
    [
      'mode: "required"',
      "before schema validation, account lookup, token lookup, token consume, or password hashing",
      "tests/security-hardening.test.ts",
      "magic_link_consume",
      "password_reset_confirm",
      "transport errors and malformed responses are treated as failed challenges",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/rate-limiting.md",
    [
      "AUTH_RATE_LIMITER",
      "D1 remains authoritative",
      "fails open to the D1 limiter",
      "Raw emails, identifiers, and IP addresses are never stored",
      "tests/routes.test.ts",
      "tests/security-hardening.test.ts",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/metrics.md",
    [
      "dummy_password_verification",
      "rate_limit_hit",
      "email_send_failed",
      "config_error",
      "malformed_token",
      "invalid_or_expired",
      "disabled_user",
      "GROUP BY reason",
    ].join("\n"),
  );
}

async function writeMigrationFixtures(root: string) {
  await writeFixtureFile(
    root,
    "migrations/0001_initial.sql",
    [
      "CREATE TABLE auth_schema_migrations(version TEXT);",
      "CREATE TABLE auth_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
      "INSERT INTO auth_schema_migrations (version, name, applied_at) VALUES ('0001', 'initial', 0);",
      "INSERT INTO auth_meta (key, value) VALUES ('schema_version', '1');",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "migrations/0002_indexes.sql",
    [
      "INSERT INTO auth_schema_migrations (version, name, applied_at) VALUES ('0002', 'indexes', 0);",
      "UPDATE auth_meta SET value = '2' WHERE key = 'schema_version';",
    ].join("\n"),
  );
}

async function writeExamplesFixtures(root: string) {
  const devVarsExample = [
    "AUTH_ENV=development",
    "AUTH_PUBLIC_ORIGIN=http://localhost:8787",
    "AUTH_SECRET=k_dev.REPLACE_WITH_GENERATED_BASE64URL_SECRET",
  ].join("\n");
  for (const dir of [
    "examples/hono-basic",
    "examples/react-vite-worker",
    "examples/worker-basic",
    "templates/hono-basic",
    "templates/react-vite-worker",
    "templates/worker-basic",
  ]) {
    await writeFixtureFile(
      root,
      `${dir}/package.json`,
      JSON.stringify({
        name: dir.replace("/", "-"),
        packageManager: "pnpm@11.1.1",
        scripts: {
          build: 'node -e ""',
          test: 'node -e ""',
        },
        dependencies: {
          hono: "4.12.18",
        },
        devDependencies: {
          typescript: "6.0.3",
          vitest: "4.1.6",
          wrangler: "4.90.1",
        },
        engines: {
          node: ">=22.12.0",
        },
      }),
    );
    await writeFixtureFile(
      root,
      `${dir}/wrangler.jsonc`,
      JSON.stringify(
        {
          $schema: "./node_modules/wrangler/config-schema.json",
          compatibility_date: "2026-05-14",
          compatibility_flags: ["nodejs_compat"],
          observability: { enabled: true, head_sampling_rate: 1 },
          vars: {
            AUTH_ENV: "development",
            AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
          },
          d1_databases: [
            {
              binding: "AUTH_DB",
              database_name: "auth",
              database_id: "local-development",
            },
          ],
        },
        null,
        2,
      ),
    );
    await writeFixtureFile(root, `${dir}/.dev.vars.example`, devVarsExample);
  }
  for (const project of [
    "examples/hono-basic",
    "examples/react-vite-worker",
    "examples/worker-basic",
    "templates/hono-basic",
    "templates/react-vite-worker",
    "templates/worker-basic",
  ]) {
    await writeFixtureFile(
      root,
      `${project}/src/auth.config.ts`,
      [
        "export default defineAuthConfig({",
        "  passwordHashing: {",
        '    profile: "workers-balanced",',
        "    maxConcurrentHashesPerIsolate: 1,",
        "    queueTimeoutMs: 2000,",
        "  },",
        "});",
      ].join("\n"),
    );
  }
  for (const template of [
    "templates/hono-basic",
    "templates/react-vite-worker",
    "templates/worker-basic",
  ]) {
    await writeFixtureFile(
      root,
      `${template}/migrations/0001_initial.sql`,
      [
        "CREATE TABLE auth_schema_migrations(version TEXT);",
        "CREATE TABLE auth_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        "INSERT INTO auth_schema_migrations (version, name, applied_at) VALUES ('0001', 'initial', 0);",
        "INSERT INTO auth_meta (key, value) VALUES ('schema_version', '1');",
      ].join("\n"),
    );
    await writeFixtureFile(
      root,
      `${template}/migrations/0002_indexes.sql`,
      [
        "INSERT INTO auth_schema_migrations (version, name, applied_at) VALUES ('0002', 'indexes', 0);",
        "UPDATE auth_meta SET value = '2' WHERE key = 'schema_version';",
      ].join("\n"),
    );
  }
}

async function writeDeployTemplateFixtures(root: string) {
  await writeFixtureFile(
    root,
    "scripts/version-matrix.json",
    JSON.stringify({
      node: ">=22.12.0",
      pnpm: "11.1.1",
      hono: "4.12.18",
      typescript: "6.0.3",
      vitest: "4.1.6",
      wrangler: "4.90.1",
      workersCompatibilityDate: "2026-05-14",
      workersCompatibilityDateFloor: "2024-09-23",
    }),
  );
  await writeFixtureFile(
    root,
    "scripts/export-deploy-template.mjs",
    `import { mkdir, writeFile } from "node:fs/promises";
const dir = process.argv[2];
await mkdir(dir + "/src", { recursive: true });
await mkdir(dir + "/migrations", { recursive: true });
await writeFile(dir + "/package.json", JSON.stringify({
  name: "cloudflare-auth-template",
  private: true,
  packageManager: "pnpm@11.1.1",
  scripts: {
    dev: "wrangler dev",
    build: "tsc -p tsconfig.json --noEmit",
    test: "vitest run --passWithNoTests",
    "db:migrations:apply": "wrangler d1 migrations apply AUTH_DB --remote",
    deploy: "npm run db:migrations:apply && wrangler deploy"
  },
  dependencies: {
    "@cf-auth/email-cloudflare": "beta",
    "@cf-auth/hono": "beta",
    "@cf-auth/worker": "beta",
    hono: "4.12.18"
  },
  devDependencies: {
    "@cf-auth/cli": "beta",
    typescript: "6.0.3",
    vitest: "4.1.6",
    wrangler: "4.90.1"
  },
  cloudflare: {
    bindings: {
      AUTH_DB: { description: "D1 database" },
      AUTH_SECRET: { description: "Generate with \`npx --package @cf-auth/cli@beta cf-auth rotate-secret --print\`." },
      AUTH_PUBLIC_ORIGIN: { description: "Public origin" }
    }
  }
}, null, 2));
await writeFile(dir + "/wrangler.jsonc", JSON.stringify({
  $schema: "./node_modules/wrangler/config-schema.json",
  compatibility_date: "2026-05-14",
  compatibility_flags: ["nodejs_compat"],
  observability: { enabled: true, head_sampling_rate: 1 },
  vars: { AUTH_ENV: "production", AUTH_PUBLIC_ORIGIN: "https://auth.example.test" },
  d1_databases: [{ binding: "AUTH_DB", database_name: "auth", database_id: "auth", migrations_dir: "migrations" }]
}, null, 2));
await writeFile(dir + "/README.md", "https://deploy.workers.cloudflare.com/?url=https://github.com/acme/cloudflare-auth-template\\nAUTH_PUBLIC_ORIGIN\\nAUTH_SECRET\\nnpx --package @cf-auth/cli@beta cf-auth rotate-secret --print\\n");
await writeFile(dir + "/.dev.vars.example", "AUTH_SECRET=k1.REPLACE_WITH_32_BYTE_BASE64URL_SECRET\\n");
`,
  );
}

async function writeStableEvidence(root: string) {
  await writeFixtureFile(
    root,
    "docs/beta-evidence.json",
    JSON.stringify(validBetaEvidence(), null, 2),
  );
  await writeFixtureFile(
    root,
    "docs/api-report.md",
    "Release approval: release-approved by maintainer on 2026-05-14\n",
  );
  await writeFixtureFile(
    root,
    "docs/config-schema.md",
    configSchemaFixtureText(
      "Release approval: release-approved by maintainer on 2026-05-14",
    ),
  );
  await writeFixtureFile(
    root,
    "docs/decisions/security-review.md",
    "Status: maintainer-signoff\n",
  );
  await writeFixtureFile(
    root,
    "docs/security-release-tracker.json",
    JSON.stringify(validSecurityTracker(), null, 2),
  );
  await writeFixtureFile(
    root,
    "tests/fixtures/upgrade/beta-schema-versions.json",
    JSON.stringify({
      schemaVersion: 1,
      betaVersions: [
        {
          version: "1.0.0-beta.0",
          schemaVersion: 1,
          fixture: "beta-1",
        },
      ],
    }),
  );
  await writeFixtureFile(
    root,
    "tests/fixtures/upgrade/beta-1/schema.sql",
    "-- beta schema fixture\n",
  );
  await writeFixtureFile(
    root,
    "tests/fixtures/upgrade/beta-1/expected.json",
    "{}\n",
  );
  await writeFixtureFile(root, "tests/upgrade.test.ts", "upgrade tests\n");
}

async function writeFakeNpm(
  root: string,
  body = `console.error("npm error code E404");
process.exit(1);
`,
) {
  const npmPath = join(root, "bin", "npm");
  await mkdir(dirname(npmPath), { recursive: true });
  await writeFile(npmPath, `#!/usr/bin/env node\n${body}`);
  await chmod(npmPath, 0o755);
}

function validPackageEvidence(version: string) {
  return {
    schemaVersion: 1,
    verifiedAt: "2026-05-14T00:00:00.000Z",
    verifiedBy: "release-reviewer",
    packages: [
      {
        name: "@cf-auth/cli",
        registry: "https://registry.npmjs.org/",
        version,
        ownershipConfirmed: true,
        publisherTwoFactorEnabled: true,
        provenancePublish: true,
      },
    ],
    reservedPackages: [],
  };
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
      commands: [
        "npx --package @cf-auth/cli@beta cf-auth init my-app --template hono-basic",
        "pnpm install",
        "npx --package @cf-auth/cli@beta cf-auth migrate --local",
        "npm run dev",
      ],
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

async function writeFixtureFile(root: string, path: string, content: string) {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${content}\n`);
}

async function replaceFixtureText(
  root: string,
  path: string,
  search: string,
  replacement: string,
) {
  const target = join(root, path);
  const text = await readFile(target, "utf8");
  await writeFile(target, text.replace(search, replacement));
}

function runReleaseGates(cwd: string) {
  const root = process.cwd();
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", "release-gates.mjs")],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(cwd, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      },
    },
  );
}
