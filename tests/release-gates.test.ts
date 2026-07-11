import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const authSmokeEndpoints = [
  "/auth/signup",
  "/auth/login",
  "/auth/logout",
  "/auth/user",
];

describe("release gates", () => {
  it("requires deploy button evidence when packages enter public beta", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: false });
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/deploy-button-evidence.json");
  });

  it("derives release checklist coverage from root package scripts", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    const packagePath = join(root, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      scripts: Record<string, string>;
    };
    pkg.scripts["verify:new-gate"] = "node scripts/verify-new-gate.mjs";
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/release-checklist.md");
    expect(result.stderr).toContain("pnpm verify:new-gate");
  });

  it("requires detailed release readiness audit sections", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "## Completion Audit",
      "## Summary Audit",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/release-readiness-audit.md");
    expect(result.stderr).toContain("## Completion Audit");
  });

  it("requires release readiness audit coverage for every implementation stage", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "| Stage 12 1.0 readiness",
      "| Stable readiness",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/release-readiness-audit.md");
    expect(result.stderr).toContain("Stage 12");
  });

  it("requires release readiness audit coverage for functional spec sections", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "## Functional Specification Audit",
      "## Functional Notes",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/release-readiness-audit.md");
    expect(result.stderr).toContain("## Functional Specification Audit");
  });

  it("requires release readiness audit coverage for testing and beta checklists", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "## Final Beta Definition Of Done Audit",
      "## Beta Notes",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/release-readiness-audit.md");
    expect(result.stderr).toContain("## Final Beta Definition Of Done Audit");
  });

  it("requires release readiness audit coverage for current local verification", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "Recent local verification has passed for:",
      "Recent verification:",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/release-readiness-audit.md");
    expect(result.stderr).toContain(
      "Recent local verification has passed for:",
    );
  });

  it("requires release readiness audit coverage for source notes and README draft", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "## Source Notes And README Draft Audit",
      "## Source Notes",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/release-readiness-audit.md");
    expect(result.stderr).toContain("## Source Notes And README Draft Audit");
  });

  it("requires release readiness audit coverage for blocking evidence gates", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "Published quickstart smoke",
      "Published quickstart",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/release-readiness-audit.md");
    expect(result.stderr).toContain("Published quickstart smoke");
  });

  it("derives evidence example endpoint coverage from the smoke script", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "scripts/custom-smoke.mjs",
      [
        "const origin = 'https://auth.acme.test';",
        "await fetch(`${origin}/auth/signup`);",
        "await fetch(`${origin}/auth/login`);",
        "await fetch(`${origin}/auth/logout`);",
        "await fetch(`${origin}/auth/user`);",
        "await fetch(`${origin}/auth/session/refresh`);",
      ].join("\n"),
    );
    const result = runReleaseGates(root, {
      CF_AUTH_SMOKE_ENDPOINTS_SOURCE: "scripts/custom-smoke.mjs",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/beta-evidence.example.json");
    expect(result.stderr).toContain("docs/deploy-button-evidence.example.json");
    expect(result.stderr).toContain("/auth/session/refresh");
  });

  it("accepts beta package gates when deploy button evidence is present", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    const result = runReleaseGates(root);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("release gates passed");
  });

  it("requires published quickstart smoke to assert local cookie policy", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "scripts/smoke-published-quickstart.mjs",
      "if (!cookie.includes('cfauth-session=')) throw new Error('missing');\n",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/smoke-published-quickstart.mjs");
    expect(result.stderr).toContain("assertLocalSessionCookie");
    expect(result.stderr).toContain("__Host-cfauth-session=");
    expect(result.stderr).toContain("Path=/");
  });

  it("requires wrangler dev smoke to assert local cookie policy", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "scripts/smoke-wrangler-dev.mjs",
      "if (!cookie.includes('cfauth-session=')) throw new Error('missing');\n",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/smoke-wrangler-dev.mjs");
    expect(result.stderr).toContain("assertLocalSessionCookie");
    expect(result.stderr).toContain("__Host-cfauth-session=");
    expect(result.stderr).toContain("Path=/");
  });

  it("requires production smoke to assert host-only production cookies", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "scripts/smoke-production-cloudflare.mjs",
      "if (!cookie.includes('cfauth-session=')) throw new Error('missing');\n",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/smoke-production-cloudflare.mjs");
    expect(result.stderr).toContain("__Host-cfauth-session=");
    expect(result.stderr).toContain("assertHostOnlySessionCookie");
    expect(result.stderr).toContain("Path=/");
  });

  it("requires production smoke to reject workspace dependencies", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "scripts/smoke-production-cloudflare.mjs",
      [
        'if (!cookie.includes("__Host-cfauth-session=")) throw new Error("missing");',
        'const packageSpecs = { "@cf-auth/hono": packageTag, "@cf-auth/worker": packageTag, "@cf-auth/cli": packageTag };',
      ].join("\n"),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/smoke-production-cloudflare.mjs");
    expect(result.stderr).toContain(
      'assertNoWorkspaceDependencies(pkg, "production smoke package.json")',
    );
    expect(result.stderr).toContain('"@cf-auth/email-cloudflare": packageTag');
    expect(result.stderr).toContain("CF_AUTH_ALLOW_LOCAL_PACKAGE_SPECS");
  });

  it("requires tarball smoke to apply every generated migration", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "scripts/smoke-local-tarballs.mjs",
      'await readFile(join(process.cwd(), "migrations", "0001_initial.sql"), "utf8");\n',
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/smoke-local-tarballs.mjs");
    expect(result.stderr).toContain(
      'readdir(join(process.cwd(), "migrations"))',
    );
    expect(result.stderr).toContain("migrationFiles.map");
  });

  it("requires tarball smoke to assert local cookie policy", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "scripts/smoke-local-tarballs.mjs",
      "expect(cookie).toContain('cfauth-session=');\n",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/smoke-local-tarballs.mjs");
    expect(result.stderr).toContain("assertLocalSessionCookie");
    expect(result.stderr).toContain("__Host-cfauth-session=");
    expect(result.stderr).toContain("Path=/");
  });

  it("rejects non-object root package manifests", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(root, "package.json", "null\n");
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "package.json: top-level JSON value must be an object",
    );
  });

  it("rejects non-object workspace package manifests", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(root, "packages/cli/package.json", "null\n");
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "packages/cli/package.json: top-level JSON value must be an object",
    );
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
          compatibility_date: "2026-05-15",
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
    await replaceFixtureText(
      root,
      "packages/cli/src/index.ts",
      "async function runCli",
      "export function hashPassword() {}\nasync function runCli",
    );
    await replaceFixtureText(
      root,
      "docs/api-report.md",
      "Public API Report",
      "Public API Report\nhashPassword",
    );
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

  it("derives public API docs coverage from aliased root exports", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "packages/cli/src/index.ts",
      "function commandGenerate",
      [
        "const internalName = 1;",
        "export { internalName as aliasedRootExport };",
        "function commandGenerate",
      ].join("\n"),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-docs-coverage.mjs");
    expect(result.stderr).toContain("docs/api.md: missing aliasedRootExport");
    expect(result.stderr).toContain(
      "docs/api-report.md: missing aliasedRootExport",
    );
  });

  it("derives package entrypoint docs coverage from workspace packages", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFixtureFile(
      root,
      "packages/custom-adapter/package.json",
      JSON.stringify({
        name: "@cf-auth/custom-adapter",
        version: "0.1.0-beta.0",
        private: true,
      }),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-docs-coverage.mjs");
    expect(result.stderr).toContain(
      "docs/api.md: missing @cf-auth/custom-adapter",
    );
  });

  it("derives CLI docs coverage from the runCli dispatcher", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "packages/cli/src/index.ts",
      '    case "sessions":',
      ['    case "tokens":', "      return 0;", '    case "sessions":'].join(
        "\n",
      ),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-docs-coverage.mjs");
    expect(result.stderr).toContain("docs/cli.md: missing cf-auth tokens");
  });

  it("derives generator docs coverage from commandGenerate", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "packages/cli/src/index.ts",
      '  return "";',
      ['  if (what === "svelte-client") return "";', '  return "";'].join("\n"),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-docs-coverage.mjs");
    expect(result.stderr).toContain(
      "docs/cli.md: missing cf-auth generate svelte-client",
    );
  });

  it("derives environment docs coverage from generated Env types", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "packages/cli/src/index.ts",
      '    "  AUTH_SECRET: string;",',
      [
        '    "  AUTH_SECRET: string;",',
        '    "  AUTH_AUDIT_LOG?: unknown;",',
      ].join("\n"),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-docs-coverage.mjs");
    expect(result.stderr).toContain(
      "docs/config-schema.md: missing AUTH_AUDIT_LOG",
    );
  });

  it("derives API endpoint docs coverage from worker routes", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "packages/worker/src/index.ts",
      '  return new Response("not found");',
      [
        '  if (path === "/session/refresh" && request.method === "POST")',
        '    return new Response("session refresh");',
        '  return new Response("not found");',
      ].join("\n"),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-docs-coverage.mjs");
    expect(result.stderr).toContain(
      "docs/api.md: missing POST /auth/session/refresh",
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

  it("derives config docs coverage from the AuthConfig interface", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "packages/worker/src/index.ts",
      "  redirects: {",
      ["  analytics: { samplingRate: number };", "  redirects: {"].join("\n"),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-docs-coverage.mjs");
    expect(result.stderr).toContain(
      "docs/configuration.md: missing analytics.samplingRate",
    );
    expect(result.stderr).toContain(
      "docs/config-schema.md: missing analytics.samplingRate",
    );
  });

  it("requires CLI docs for every shipped command variant", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "docs/cli.md",
      "cf-auth generate types",
      "cf-auth generate env-types",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-docs-coverage.mjs");
    expect(result.stderr).toContain(
      "docs/cli.md: missing cf-auth generate types",
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

  it("derives Turnstile docs coverage from runtime endpoint names", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "packages/worker/src/index.ts",
      '  "password_reset_confirm",',
      ['  "password_reset_confirm",', '  "new_turnstile_endpoint",'].join("\n"),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-security-docs.mjs");
    expect(result.stderr).toContain(
      "docs/turnstile.md: missing new_turnstile_endpoint",
    );
  });

  it("derives metrics docs coverage from runtime auth events", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "packages/worker/src/index.ts",
      '  return new Response("not found");',
      [
        '  queueAuthEvent(undefined as never, request, "new_auth_event");',
        '  return new Response("not found");',
      ].join("\n"),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-security-docs.mjs");
    expect(result.stderr).toContain("docs/metrics.md: missing new_auth_event");
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

  it("requires runnable D1 bindings in examples and generated templates", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      "templates/hono-basic/wrangler.jsonc",
      '"database_id": "local-development"',
      '"database_id": "REPLACE_WITH_DATABASE_ID"',
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("scripts/verify-examples.mjs");
    expect(result.stderr).toContain(
      "templates/hono-basic: AUTH_DB database_id must not be a placeholder",
    );
  });

  it("requires release package-name confirmation to be a required boolean input", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "        required: true\n        type: boolean",
      "        required: false\n        type: string",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: package_names_confirmed must be a required boolean workflow input",
    );
  });

  it("requires release package-name confirmation to fail before checkout", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      `      - name: Require package-name gate
        if: \${{ !inputs.package_names_confirmed }}
        run: |
          exit 1
      - uses: actions/checkout@v5`,
      `      - uses: actions/checkout@v5
      - name: Require package-name gate
        if: \${{ false }}
        run: |
          exit 1`,
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: package_names_confirmed must be enforced by an early failing gate step",
    );
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: package-name gate must run before checkout",
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
    for (const packageVersion of [
      "0.1.0",
      "0.1.0-alpha",
      "0.1.0-beta",
      "1.0.0-rc.0",
    ]) {
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

  it("rejects placeholder-based prerelease package versions", async () => {
    const root = await releaseGateFixture({
      deployButtonEvidence: false,
      packageVersion: "0.0.0-alpha.0",
    });
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@cf-auth/cli@0.0.0-alpha.0");
    expect(result.stderr).toContain("placeholder 0.0.0 base");
  }, 20_000);

  it("rejects publishable packages without string names and versions", async () => {
    const root = await releaseGateFixture({ deployButtonEvidence: true });
    await writeFile(
      join(root, "packages", "cli", "package.json"),
      `${JSON.stringify({ name: 1, version: 1 })}\n`,
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "packages/cli/package.json: name must be a non-empty string",
    );
    expect(result.stderr).toContain(
      "packages/cli/package.json: version must be a non-empty string",
    );
  });

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

  it("requires package ownership evidence before alpha packages publish", async () => {
    const root = await releaseGateFixture({
      alphaEvidence: false,
      deployButtonEvidence: false,
      packageVersion: "0.1.0-alpha.0",
    });
    await rm(join(root, "docs", "package-ownership.json"));
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("docs/package-ownership.json");
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

  it("rejects stable release evidence with mismatched deploy button package tags", async () => {
    const root = await releaseGateFixture({
      deployButtonEvidence: true,
      packageVersion: "1.0.0",
      stableEvidence: true,
    });
    const evidence = validDeployButtonEvidence();
    evidence.packageTag = "0.1.0-beta.1";
    await writeFixtureFile(
      root,
      "docs/deploy-button-evidence.json",
      JSON.stringify(evidence, null, 2),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/deploy-button-evidence.json: packageTag",
    );
    expect(result.stderr).toContain("docs/beta-evidence.json");
  });

  it("rejects incomplete or placeholder stable release signoffs", async () => {
    const root = await releaseGateFixture({
      deployButtonEvidence: true,
      packageVersion: "1.0.0",
      stableEvidence: true,
    });
    await writeFixtureFile(
      root,
      "docs/api-report.md",
      "Release approval: release-approved\n",
    );
    await writeFixtureFile(
      root,
      "docs/config-schema.md",
      configSchemaFixtureText(
        "Release approval: release-approved by release-reviewer on 9999-01-01",
      ),
    );
    await writeFixtureFile(
      root,
      "docs/decisions/security-review.md",
      [
        "Status: maintainer-signoff",
        "Signed by: maintainer",
        "Date: 9999-01-01",
      ].join("\n"),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/api-report.md: Public API report release approval must include non-placeholder approver and ISO date",
    );
    expect(result.stderr).toContain(
      "docs/config-schema.md: Config schema release approver must not be a placeholder",
    );
    expect(result.stderr).toContain(
      "docs/config-schema.md: Config schema release approval date must not be in the future",
    );
    expect(result.stderr).toContain(
      "docs/decisions/security-review.md: security review decision date must not be in the future",
    );
    expect(result.stderr).toContain(
      "docs/decisions/security-review.md: maintainer sign-off signer must not be a placeholder",
    );
    expect(result.stderr).toContain(
      "docs/decisions/security-review.md: maintainer sign-off must include Rationale:",
    );
    expect(result.stderr).toContain(
      "docs/decisions/security-review.md: maintainer sign-off must include Compensating controls:",
    );
  });

  it("rejects copied angle-bracket stable release signoff placeholders", async () => {
    const root = await releaseGateFixture({
      deployButtonEvidence: true,
      packageVersion: "1.0.0",
      stableEvidence: true,
    });
    await writeFixtureFile(
      root,
      "docs/api-report.md",
      "Release approval: release-approved by <approver> on 2026-05-15\n",
    );
    await writeFixtureFile(
      root,
      "docs/config-schema.md",
      configSchemaFixtureText(
        "Release approval: release-approved by <approver> on 2026-05-15",
      ),
    );
    await writeFixtureFile(
      root,
      "docs/decisions/security-review.md",
      [
        "Status: maintainer-signoff",
        "Signed by: <maintainer>",
        "Date: 2026-05-15",
        "Rationale: Stable release proceeds without external review after local security gates passed.",
        "Compensating controls: public security policy, dependency review, CodeQL, npm audit, and release tracker gates.",
      ].join("\n"),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/api-report.md: Public API report release approver must not be a placeholder",
    );
    expect(result.stderr).toContain(
      "docs/config-schema.md: Config schema release approver must not be a placeholder",
    );
    expect(result.stderr).toContain(
      "docs/decisions/security-review.md: maintainer sign-off signer must not be a placeholder",
    );
  });

  it("rejects slash stable release signoff placeholders", async () => {
    const root = await releaseGateFixture({
      deployButtonEvidence: true,
      packageVersion: "1.0.0",
      stableEvidence: true,
    });
    await writeFixtureFile(
      root,
      "docs/api-report.md",
      "Release approval: release-approved by n/a on 2026-05-15\n",
    );
    await writeFixtureFile(
      root,
      "docs/config-schema.md",
      configSchemaFixtureText(
        "Release approval: release-approved by not applicable on 2026-05-15",
      ),
    );
    await writeFixtureFile(
      root,
      "docs/decisions/security-review.md",
      [
        "Status: maintainer-signoff",
        "Signed by: N/A",
        "Date: 2026-05-15",
        "Rationale: Stable release proceeds without external review after local security gates passed.",
        "Compensating controls: public security policy, dependency review, CodeQL, npm audit, and release tracker gates.",
      ].join("\n"),
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/api-report.md: Public API report release approver must not be a placeholder",
    );
    expect(result.stderr).toContain(
      "docs/config-schema.md: Config schema release approver must not be a placeholder",
    );
    expect(result.stderr).toContain(
      "docs/decisions/security-review.md: maintainer sign-off signer must not be a placeholder",
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
              version: "1.0.0",
              schemaVersion: 1,
              fixture: "../outside",
            },
            {
              version: "1.0.0-beta",
              schemaVersion: 1,
              fixture: "beta-1",
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
    expect(result.stderr).toContain("betaVersions[2].version");
  });

  it("rejects non-object stable beta upgrade fixture manifests", async () => {
    const root = await releaseGateFixture({
      deployButtonEvidence: true,
      packageVersion: "1.0.0",
      stableEvidence: true,
    });
    await writeFixtureFile(
      root,
      "tests/fixtures/upgrade/beta-schema-versions.json",
      "null",
    );
    const result = runReleaseGates(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "tests/fixtures/upgrade/beta-schema-versions.json: top-level JSON value must be an object",
    );
  });
}, 20_000);

interface ReleaseGateFixtureOptions {
  alphaEvidence?: boolean;
  deployButtonEvidence: boolean;
  packageVersion?: string;
  stableEvidence?: boolean;
}

async function releaseGateFixture(options: ReleaseGateFixtureOptions) {
  const root = await mkdtemp(join(tmpdir(), "cf-auth-release-gates-"));
  await writeFakeNpm(root);
  await writeFakePnpm(root);
  await writeRootPackage(root);

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
    "docs/platform-assumptions.md",
    "docs/public-beta.md",
    "docs/release-readiness-audit.md",
    "docs/security-release-tracker.example.json",
    "schemas/doctor-report.schema.json",
    "scripts/evidence-commands.mjs",
    "scripts/export-deploy-template.mjs",
    "scripts/check-package-names.mjs",
    "scripts/release-readiness-audit-checks.mjs",
    "scripts/release-version-policy.mjs",
    "scripts/smoke-endpoints.mjs",
    "scripts/smoke-local-tarballs.mjs",
    "scripts/smoke-wrangler-dev.mjs",
    "scripts/smoke-published-quickstart.mjs",
    "scripts/smoke-production-cloudflare.mjs",
    "scripts/verify-alpha-evidence.mjs",
    "scripts/verify-beta-evidence.mjs",
    "scripts/verify-deploy-button-evidence.mjs",
    "scripts/verify-deploy-template.mjs",
    "scripts/verify-docs-coverage.mjs",
    "scripts/verify-examples.mjs",
    "scripts/verify-migrations.mjs",
    "scripts/verify-package-ownership.mjs",
    "scripts/verify-release-readiness-audit.mjs",
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
    ["docs/release-checklist.md", releaseChecklistFixtureText()],
    [
      "docs/platform-assumptions.md",
      [
        "Date rechecked:",
        "Wrangler environments",
        'withSession("first-primary")',
        "PRAGMA defer_foreign_keys",
        "Cloudflare Email Service",
        "Wrangler `4.36.0` or later",
        "`10` or `60` seconds",
        "`nodejs_compat`",
        "`2024-09-23`",
        "Workers Vitest",
        "Turnstile",
        "Deploy to Cloudflare",
        "binding name rather than the database name",
        "npm package execution",
        "npx --package <pkg> <bin>",
        "Cookie prefixes",
        "__Host-",
        "__Secure-",
        "Password storage",
        "N=2^17, r=8, p=1",
      ],
    ],
    ["docs/release-readiness-audit.md", releaseReadinessAuditFixtureText()],
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
        "CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership",
        "pnpm check:package-names",
        "Cloudflare API tokens",
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
        "cd my-app",
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
        "Cloudflare Email Service binding is configured for `AUTH_EMAIL`",
        "wrangler d1 migrations apply AUTH_DB --remote",
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
        "pnpm check:package-names",
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
        "cd my-app",
        "cf-auth migrate --local",
        "pnpm install",
        "npm run dev",
        ...authSmokeEndpoints,
      ],
    ],
    [
      "docs/deploy-button-evidence.example.json",
      [
        ...authSmokeEndpoints,
        '"starterTemplateCreated"',
        '"documentedPathFollowed"',
        '"emailBindingConfigured"',
        '"packageTag"',
      ],
    ],
    [".github/workflows/wrangler-dev-smoke.yml", ["pnpm smoke:wrangler-dev"]],
    [
      "scripts/smoke-wrangler-dev.mjs",
      [
        "assertLocalSessionCookie",
        "cfauth-session=",
        "__Host-cfauth-session=",
        "HttpOnly",
        "Path=/",
        "Secure",
        "Domain=",
      ],
    ],
    [
      "scripts/smoke-local-tarballs.mjs",
      [
        'readdir(join(process.cwd(), "migrations"))',
        'appName = "my-app"',
        "{ cwd: appDir }",
        "migrationFiles.map",
        "assertLocalSessionCookie",
        "cfauth-session=",
        "__Host-cfauth-session=",
        "HttpOnly",
        "Path=/",
        "Secure",
        "Domain=",
      ],
    ],
    [
      "scripts/verify-deploy-template.mjs",
      [
        "checkMigrations",
        "rootMigrationFiles",
        "deploy template must include every root migration",
        "must match root migration",
      ],
    ],
    [
      "scripts/smoke-published-quickstart.mjs",
      [
        "assertLocalSessionCookie",
        'appName = "my-app"',
        "{ cwd: temp }",
        "{ cwd: appDir }",
        "cfauth-session=",
        "__Host-cfauth-session=",
        "HttpOnly",
        "Path=/",
        "Secure",
        "Domain=",
      ],
    ],
    [
      "scripts/smoke-production-cloudflare.mjs",
      [
        "__Host-cfauth-session=",
        "assertHostOnlySessionCookie",
        "Secure",
        "HttpOnly",
        "Path=/",
        "Domain=",
        'assertNoWorkspaceDependencies(pkg, "production smoke package.json")',
        '"@cf-auth/email-cloudflare": packageTag',
        "CF_AUTH_ALLOW_LOCAL_PACKAGE_SPECS",
      ],
    ],
    [".github/workflows/release.yml", releaseWorkflowFixtureText()],
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

async function writeRootPackage(root: string) {
  await writeFixtureFile(
    root,
    "package.json",
    JSON.stringify({
      scripts: rootPackageScripts(),
    }),
  );
}

function rootPackageScripts() {
  return {
    "format:check": "prettier --check .",
    lint: "node scripts/lint.mjs",
    typecheck: "tsc -p tsconfig.base.json --noEmit",
    test: "vitest run",
    "test:workers": "vitest run -c vitest.workers.config.ts",
    build:
      "pnpm -r --filter './packages/**' --sort --workspace-concurrency=1 build",
    "check:package-names": "node scripts/check-package-names.mjs",
    "package:check": "node scripts/package-check.mjs",
    "version-matrix:check": "node scripts/version-matrix-check.mjs",
    "export:deploy-template": "node scripts/export-deploy-template.mjs",
    "verify:alpha-evidence": "node scripts/verify-alpha-evidence.mjs",
    "verify:beta-evidence": "node scripts/verify-beta-evidence.mjs",
    "verify:deploy-button-evidence":
      "node scripts/verify-deploy-button-evidence.mjs",
    "verify:deploy-template": "node scripts/verify-deploy-template.mjs",
    "verify:docs-coverage": "node scripts/verify-docs-coverage.mjs",
    "verify:examples": "node scripts/verify-examples.mjs",
    "verify:migrations": "node scripts/verify-migrations.mjs",
    "verify:package-ownership": "node scripts/verify-package-ownership.mjs",
    "verify:release-audit": "node scripts/verify-release-readiness-audit.mjs",
    "verify:security-docs": "node scripts/verify-security-docs.mjs",
    "verify:security-tracker":
      "node scripts/verify-security-release-tracker.mjs",
    "release:gates": "node scripts/release-gates.mjs",
    "publish:dry-run":
      "pnpm -r --filter './packages/**' publish --dry-run --access public --no-git-checks --report-summary",
    "smoke:wrangler-dev": "node scripts/smoke-wrangler-dev.mjs",
    "smoke:cloudflare-production":
      "node scripts/smoke-production-cloudflare.mjs",
    "smoke:published-quickstart": "node scripts/smoke-published-quickstart.mjs",
    "smoke:tarballs": "node scripts/smoke-local-tarballs.mjs",
    "benchmark:password": "tsx scripts/benchmark-password-worker.ts",
  };
}

function releaseChecklistFixtureText() {
  return [
    "unresolved high/critical",
    "public API report reviewed",
    "config schema reviewed",
    "security review decision",
    "docs/platform-assumptions.md",
    "release-readiness-audit.md",
    "CF_AUTH_REQUIRE_ALPHA_EVIDENCE=1 pnpm verify:alpha-evidence",
    "CF_AUTH_REQUIRE_BETA_EVIDENCE=1 pnpm verify:beta-evidence",
    "CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE=1 pnpm verify:deploy-button-evidence",
    "CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership",
    "CF_AUTH_REQUIRE_SECURITY_TRACKER=1 pnpm verify:security-tracker",
    "pnpm install --frozen-lockfile",
    "pnpm audit --audit-level high",
    ...Object.keys(rootPackageScripts())
      .filter(
        (script) =>
          [
            "format:check",
            "lint",
            "typecheck",
            "test",
            "test:workers",
            "build",
            "check:package-names",
            "package:check",
            "version-matrix:check",
            "release:gates",
            "benchmark:password",
            "publish:dry-run",
          ].includes(script) ||
          script.startsWith("verify:") ||
          script.startsWith("smoke:"),
      )
      .map((script) => `pnpm ${script}`),
    "opt-in Wrangler dev smoke workflow passes",
  ];
}

function releaseWorkflowFixtureText() {
  return [
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      package_names_confirmed:",
    "        required: true",
    "        type: boolean",
    "jobs:",
    "  release:",
    "    steps:",
    "      - name: Require package-name gate",
    "        if: ${{ !inputs.package_names_confirmed }}",
    "        run: |",
    "          exit 1",
    "      - uses: actions/checkout@v5",
    "      - run: pnpm install --frozen-lockfile",
    "      - run: pnpm package:check",
    "      - run: pnpm release:gates",
    "      - run: pnpm publish:dry-run",
    "      - uses: actions/upload-artifact@v4",
    "        with:",
    "          path: pnpm-publish-summary.json",
    "      - run: pnpm changeset publish --provenance",
  ];
}

function releaseReadinessAuditFixtureText() {
  return [
    "cloudflare_auth_implementation_plan.md",
    "## Completion Audit",
    ...Array.from(
      { length: 13 },
      (_, stage) =>
        `| Stage ${stage}${stage === 12 ? " 1.0 readiness" : ""} | evidence | evidence | status |`,
    ),
    "## Non-Negotiable Rules Audit",
    ...Array.from(
      { length: 28 },
      (_, index) =>
        `| ${String(index + 1).padEnd(4)} | ${
          index === 27
            ? "Repositories never generate raw auth tokens."
            : `Rule ${index + 1}`
        } | evidence |`,
    ),
    "## V1 Exclusion Audit",
    "role/permission framework",
    "peppering",
    "## Functional Specification Audit",
    "Section 0 execution contract",
    "Sections 1-4 product and user experience",
    "Sections 5-8 architecture, repo, and packages",
    "Sections 9-11 bindings, config, and Wrangler",
    "Sections 12-13 D1 schema and repositories",
    "Sections 14-17 tokens, passwords, identity, and cookies",
    "Sections 18-20 HTTP, CSRF/CORS, and redirects",
    "Sections 21-22 API contract and D1 atomicity",
    "Sections 23-24 rate limiting and email",
    "Sections 25-27 SDK, integrations, and CLI",
    "Sections 28-29 security model and Turnstile",
    "## Current Local Evidence",
    "Recent local verification has passed for:",
    "pnpm install --frozen-lockfile",
    "pnpm format:check",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm test:workers",
    "pnpm build",
    "pnpm package:check",
    "pnpm version-matrix:check",
    "pnpm verify:docs-coverage",
    "pnpm verify:security-docs",
    "pnpm verify:migrations",
    "pnpm verify:deploy-template",
    "pnpm verify:examples",
    "pnpm release:gates",
    "pnpm audit --audit-level high",
    "pnpm smoke:wrangler-dev",
    "CF_AUTH_TARBALL_INSTALL=1 pnpm smoke:tarballs",
    "pnpm benchmark:password",
    "pnpm publish:dry-run",
    "## Testing, CI, And Docs Plan Audit",
    "Section 31.1 unit tests",
    "Section 31.2 repository tests",
    "Section 31.3 route tests",
    "Section 31.4 concurrency/security tests",
    "Section 31.5 CLI tests",
    "Section 31.6 example tests",
    "Section 32.1 CI command set",
    "Section 32.2 examples workflow",
    "Section 32.3 release workflow",
    "Section 32.4 security automation",
    "Section 33.1 README",
    "Section 33.2 docs directory",
    "Section 33.3 troubleshooting matrix",
    "## Source Notes And README Draft Audit",
    "Section 34 source notes",
    "Section 35 README draft",
    "docs/platform-assumptions.md",
    "Package-owner-safe fallback wording",
    "## Final Beta Definition Of Done Audit",
    "Section 36 create-package quickstart command",
    "Section 36 unscoped init command",
    "Local magic link works without email setup.",
    "Remote deploy works with documented Cloudflare setup.",
    "Packages can be published with Changesets.",
    "No known high-severity auth bug is open.",
    "## Blocking Evidence",
    "maintainer, npm, GitHub, or Cloudflare evidence",
    "not be fabricated in the repo",
    "Private alpha evidence",
    "Public beta evidence",
    "Published quickstart smoke",
    "Deploy to Cloudflare evidence",
    "Production Cloudflare smoke",
    "Package ownership",
    "Security release tracker",
    "API approval",
    "Config schema approval",
    "Security review decision",
    "Published package versions",
    "## Release Rule",
    "not ready for public beta or stable 1.0",
    "scripts/lint.mjs",
    "interpolated D1 `prepare`/`exec` template SQL",
    "tests/lint.test.ts",
    "docs/metrics.md",
    "runtime auth-event metrics docs",
    "pnpm verify:release-audit",
    "CF_AUTH_REQUIRE_ALPHA_EVIDENCE=1 pnpm verify:alpha-evidence",
    "CF_AUTH_REQUIRE_BETA_EVIDENCE=1 pnpm verify:beta-evidence",
    "CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE=1 pnpm verify:deploy-button-evidence",
    "CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership",
    "pnpm check:package-names",
    "CF_AUTH_REQUIRE_SECURITY_TRACKER=1 pnpm verify:security-tracker",
    "docs/api-report.md",
    "docs/config-schema.md",
    "docs/decisions/security-review.md",
    "0.0.0",
    "0.0.0-*",
  ];
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
  "signup.username.minLength",
  "signup.username.maxLength",
  "login.emailPassword",
  "login.usernamePassword",
  "login.magicLink",
  "login.requireVerifiedEmail",
  "magicLink.allowSignups",
  "magicLink.expiresInMinutes",
  "magicLink.consumeMethod",
  "magicLink.activeTokenPolicy",
  "passwordReset.enabled",
  "passwordReset.expiresInMinutes",
  "passwordReset.resetPage.mode",
  "passwordReset.resetPage.path",
  "passwordReset.revokeExistingSessions",
  "passwordReset.createSessionAfterReset",
  "passwordReset.markEmailVerifiedOnReset",
  "passwordReset.activeTokenPolicy",
  "emailVerification.enabled",
  "emailVerification.expiresInHours",
  "emailVerification.consumeMethod",
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
  "rateLimit.adapter",
  "rateLimit.edgePrefilter",
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
    "packages/cli/src/index.ts",
    [
      "async function runCli(parsed: { command: string }) {",
      "  switch (parsed.command) {",
      '    case "help":',
      '    case "--help":',
      '    case "-h":',
      "      return 0;",
      '    case "init":',
      '    case "migrate":',
      '    case "doctor":',
      '    case "deploy":',
      '    case "generate":',
      '    case "rotate-secret":',
      '    case "clean":',
      '    case "users":',
      '    case "sessions":',
      "      return 0;",
      "    default:",
      "      return 1;",
      "  }",
      "}",
      "function commandGenerate(parsed: { positionals: string[] }) {",
      '  const what = parsed.positionals[0] ?? "hono";',
      '  if (what === "types")',
      "    return [",
      '      "export interface Env {",',
      '      "  AUTH_DB: D1Database;",',
      '      "  AUTH_EMAIL?: unknown;",',
      '      "  AUTH_RATE_LIMITER?: unknown;",',
      '      "  AUTH_SECRET: string;",',
      '      "  AUTH_SECRET_PREVIOUS?: string;",',
      '      "  AUTH_ENV: \\"development\\" | \\"preview\\" | \\"production\\";",',
      '      "  AUTH_PUBLIC_ORIGIN?: string;",',
      '      "  TURNSTILE_SECRET_KEY?: string;",',
      '      "}",',
      '    ].join("\\n");',
      '  return "";',
      "}",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "packages/worker/package.json",
    JSON.stringify({
      name: "@cf-auth/worker",
      version: "0.1.0-beta.0",
      private: true,
    }),
  );
  await writeFixtureFile(
    root,
    "packages/worker/src/index.ts",
    [
      "const turnstileEndpointNames = [",
      '  "signup",',
      '  "password_login",',
      '  "magic_link_request",',
      '  "magic_link_consume",',
      '  "email_verification_request",',
      '  "email_verification_consume",',
      '  "password_reset_request",',
      '  "password_reset_confirm",',
      "] as const;",
      "interface MinimalAuthConfig {",
      "  appName: string;",
      "  basePath: string;",
      "  email?: AuthEmailAdapter;",
      "}",
      "interface AuthConfig extends MinimalAuthConfig {",
      "  runtime: {",
      "    mode: string;",
      "    publicOrigin: string;",
      "    trustedHosts: string[];",
      "  };",
      "  database: { binding: string };",
      "  session: {",
      "    cookieName: string;",
      "    maxAgeDays: number;",
      "    sameSite: string;",
      "    secure: string;",
      "    domain?: string;",
      "    requireVerifiedEmail: boolean;",
      "  };",
      "  request: {",
      "    maxBodyBytes: number;",
      "    requireOriginOnUnsafeMethods: boolean;",
      "    enumerationMinResponseMs: number;",
      "    enumerationJitterMs: number;",
      "  };",
      "  security: {",
      "    allowedRequestOrigins: string[];",
      "    allowedPreviewRequestOrigins: string[];",
      "  };",
      "  passwordHashing: {",
      "    profile: string;",
      "    maxConcurrentHashesPerIsolate: number;",
      "    queueTimeoutMs: number;",
      "  };",
      "  signup: {",
      "    enabled: boolean;",
      "    requireEmailVerificationBeforeSession: boolean;",
      "    enumerationSafe: boolean;",
      "    username: {",
      "      enabled: boolean;",
      "      required: boolean;",
      "      minLength: number;",
      "      maxLength: number;",
      "    };",
      "  };",
      "  login: {",
      "    emailPassword: boolean;",
      "    usernamePassword: boolean;",
      "    magicLink: boolean;",
      "    requireVerifiedEmail: boolean;",
      "  };",
      "  magicLink: {",
      "    allowSignups: boolean;",
      "    expiresInMinutes: number;",
      "    activeTokenPolicy: string;",
      "  };",
      "  passwordReset: {",
      "    enabled: boolean;",
      "    expiresInMinutes: number;",
      "    revokeExistingSessions: boolean;",
      "    createSessionAfterReset: boolean;",
      "    markEmailVerifiedOnReset: boolean;",
      "    activeTokenPolicy: string;",
      "  };",
      "  emailVerification: {",
      "    enabled: boolean;",
      "    expiresInHours: number;",
      "    createSessionAfterVerification: boolean;",
      "    activeTokenPolicy: string;",
      "  };",
      "  turnstile: {",
      "    mode: string;",
      "    endpoints: string[];",
      "    verify?: () => Promise<boolean>;",
      "  };",
      "  redirects: {",
      "    defaultAfterLogin: string;",
      "    defaultAfterLogout: string;",
      "    defaultAfterEmailVerification: string;",
      "    defaultAfterPasswordReset: string;",
      "    allowedOrigins: string[];",
      "    allowedPreviewOrigins: string[];",
      "  };",
      "  rateLimit: {",
      "    adapter: string;",
      "    edgePrefilter: string;",
      "  };",
      "}",
      "async function dispatchAuthRequest(path: string, request: Request) {",
      '  if (path === "/dev/emails" && request.method === "GET")',
      '    return new Response("dev emails");',
      '  if (path === "/signup" && request.method === "POST")',
      '    return new Response("signup");',
      '  if (path === "/login" && request.method === "POST")',
      '    return new Response("login");',
      '  if (path === "/logout" && request.method === "POST")',
      '    return new Response("logout");',
      '  if (path === "/user" && request.method === "GET")',
      '    return new Response("user");',
      '  if (path === "/magic-link/request" && request.method === "POST")',
      '    return new Response("magic link request");',
      '  if (path === "/magic-link/verify" && request.method === "GET")',
      '    return new Response("magic link verify");',
      '  if (path === "/magic-link/consume" && request.method === "POST")',
      '    return new Response("magic link consume");',
      '  if (path === "/email/verify/request" && request.method === "POST")',
      '    return new Response("email verify request");',
      '  if (path === "/email/verify" && request.method === "GET")',
      '    return new Response("email verify");',
      '  if (path === "/email/verify/consume" && request.method === "POST")',
      '    return new Response("email verify consume");',
      '  if (path === "/password/reset/request" && request.method === "POST")',
      '    return new Response("password reset request");',
      '  if (path === "/password/reset" && request.method === "GET")',
      '    return new Response("password reset");',
      '  if (path === "/password/reset/confirm" && request.method === "POST")',
      '    return new Response("password reset confirm");',
      '  return new Response("not found");',
      "}",
      "function emitAuthEventExamples(runtime: never, request: Request) {",
      '  queueAuthEvent(runtime, request, "signup_success");',
      '  queueAuthEvent(runtime, request, "signup_failed");',
      '  queueAuthEvent(runtime, request, "password_login_success");',
      '  queueAuthEvent(runtime, request, "password_login_failed");',
      '  queueAuthEvent(runtime, request, "dummy_password_verification");',
      '  queueAuthEvent(runtime, request, "magic_link_request");',
      '  queueAuthEvent(runtime, request, "magic_link_consume_failed");',
      '  queueAuthEvent(runtime, request, "email_verification_request");',
      '  queueAuthEvent(runtime, request, "email_verification_consume_failed");',
      '  queueAuthEvent(runtime, request, "password_reset_request");',
      '  queueAuthEvent(runtime, request, "password_reset_confirm_failed");',
      '  queueAuthEvent(runtime, request, "session_revoked");',
      '  queueAuthEvent(runtime, request, "disabled_user_auth_attempt");',
      '  queueAuthEvent(runtime, request, "rate_limit_hit");',
      '  tokenConsumeEventInput(runtime, request, "magic_link_consume_success");',
      '  tokenConsumeEventInput(runtime, request, "email_verification_consume_success");',
      '  tokenConsumeEventInput(runtime, request, "password_reset_confirm_success");',
      '  runtime.repos.events.writeAuthEvent({ eventType: "email_send_failed" });',
      '  runtime.repos.events.writeAuthEvent({ eventType: "config_error" });',
      "}",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/cli.md",
    [
      "cf-auth init",
      "cf-auth migrate",
      "cf-auth doctor",
      "cf-auth deploy",
      "cf-auth generate",
      "cf-auth generate hono",
      "cf-auth generate worker-snippet",
      "cf-auth generate react-client",
      "cf-auth generate types",
      "cf-auth rotate-secret",
      "cf-auth rotate-secret --print",
      "cf-auth rotate-secret --apply --env production",
      "cf-auth clean",
      "cf-auth clean --local",
      "cf-auth clean --remote --env production",
      "cf-auth users disable",
      "cf-auth users enable",
      "cf-auth sessions revoke",
      "cf-auth sessions revoke --user",
      "cf-auth sessions list",
      "cf-auth sessions list --user",
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
      ...authSmokeEndpoints,
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
      "signup",
      "password_login",
      "magic_link_request",
      "magic_link_consume",
      "email_verification_request",
      "email_verification_consume",
      "password_reset_request",
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
      "Cloudflare Rate Limiting API prefilter",
      "WAF rule",
      "signup, magic-link request, password-reset request, and token consume endpoints",
      "Raw emails, identifiers, and IP addresses are never stored",
      "tests/routes.test.ts",
      "tests/security-hardening.test.ts",
    ].join("\n"),
  );
  await writeFixtureFile(
    root,
    "docs/metrics.md",
    [
      "Operational Metric Map",
      "signup_success",
      "password_login_success",
      "password_login_failed",
      "dummy_password_verification",
      "signup_failed",
      "duplicate email or username attempts",
      "magic_link_request",
      "magic_link_consume_failed",
      "email_verification_request",
      "email_verification_consume_failed",
      "password_reset_request",
      "password_reset_confirm_failed",
      "rate_limit_hit",
      "email_send_failed",
      "magic_link_consume_success",
      "email_verification_consume_success",
      "password_reset_confirm_success",
      "invalid_or_replayed",
      "session_revoked",
      "disabled_user_auth_attempt",
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
          node: ">=22.13.0",
        },
      }),
    );
    await writeFixtureFile(
      root,
      `${dir}/wrangler.jsonc`,
      JSON.stringify(
        {
          $schema: "./node_modules/wrangler/config-schema.json",
          compatibility_date: "2026-05-15",
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
              migrations_dir: dir.startsWith("examples/")
                ? "../../migrations"
                : "migrations",
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
        "  rateLimit: {",
        '    adapter: "d1",',
        '    edgePrefilter: "optional",',
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
      node: ">=22.13.0",
      pnpm: "11.1.1",
      hono: "4.12.18",
      typescript: "6.0.3",
      vitest: "4.1.6",
      wrangler: "4.90.1",
      workersCompatibilityDate: "2026-05-15",
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
await writeFile(dir + "/migrations/0001_initial.sql", ${JSON.stringify(
      `${[
        "CREATE TABLE auth_schema_migrations(version TEXT);",
        "CREATE TABLE auth_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        "INSERT INTO auth_schema_migrations (version, name, applied_at) VALUES ('0001', 'initial', 0);",
        "INSERT INTO auth_meta (key, value) VALUES ('schema_version', '1');",
      ].join("\n")}\n`,
    )});
await writeFile(dir + "/migrations/0002_indexes.sql", ${JSON.stringify(
      `${[
        "INSERT INTO auth_schema_migrations (version, name, applied_at) VALUES ('0002', 'indexes', 0);",
        "UPDATE auth_meta SET value = '2' WHERE key = 'schema_version';",
      ].join("\n")}\n`,
    )});
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
      AUTH_PUBLIC_ORIGIN: { description: "Public origin" },
      AUTH_EMAIL: { description: "Email binding" }
    }
  }
}, null, 2));
await writeFile(dir + "/wrangler.jsonc", JSON.stringify({
  $schema: "./node_modules/wrangler/config-schema.json",
  compatibility_date: "2026-05-15",
  compatibility_flags: ["nodejs_compat"],
  observability: { enabled: true, head_sampling_rate: 1 },
  vars: { AUTH_ENV: "production", AUTH_PUBLIC_ORIGIN: "https://auth.example.test" },
  d1_databases: [{ binding: "AUTH_DB", database_name: "auth", database_id: "auth", migrations_dir: "migrations" }],
  send_email: [{ name: "AUTH_EMAIL", remote: true }]
}, null, 2));
await writeFile(dir + "/README.md", "https://deploy.workers.cloudflare.com/?url=https://github.com/acme/cloudflare-auth-template\\nAUTH_PUBLIC_ORIGIN\\nAUTH_SECRET\\nAUTH_EMAIL\\nnpx --package @cf-auth/cli@beta cf-auth rotate-secret --print\\n");
await writeFile(dir + "/.dev.vars.example", "AUTH_SECRET=k1.REPLACE_WITH_32_BYTE_BASE64URL_SECRET\\n");
await writeFile(dir + "/.gitignore", "node_modules/\\n.wrangler/\\n.dev.vars\\n.env\\n.env.*\\n*.log\\n");
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
    "Release approval: release-approved by release-captain-ada on 2026-05-15\n",
  );
  await writeFixtureFile(
    root,
    "docs/config-schema.md",
    configSchemaFixtureText(
      "Release approval: release-approved by release-captain-ada on 2026-05-15",
    ),
  );
  await writeFixtureFile(
    root,
    "docs/decisions/security-review.md",
    [
      "Status: maintainer-signoff",
      "Signed by: release-captain-ada",
      "Date: 2026-05-15",
      "Rationale: Stable release proceeds without external review after local security gates passed.",
      "Compensating controls: public security policy, dependency review, CodeQL, npm audit, and release tracker gates.",
    ].join("\n"),
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

async function writeFakePnpm(root: string) {
  const pnpmPath = join(root, "bin", "pnpm");
  await mkdir(dirname(pnpmPath), { recursive: true });
  await writeFile(
    pnpmPath,
    `#!/usr/bin/env node
process.exit(0);
`,
  );
  await chmod(pnpmPath, 0o755);
}

function validPackageEvidence(version: string) {
  return {
    schemaVersion: 1,
    verifiedAt: "2026-05-15T00:00:00.000Z",
    verifiedBy: "release-captain-ada",
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
  const alphaUsers = [
    "pilot-ada",
    "pilot-ben",
    "pilot-cy",
    "pilot-dee",
    "pilot-eli",
  ];
  return {
    schemaVersion: 1,
    localSetups: Array.from({ length: 5 }, (_, index) => ({
      user: alphaUsers[index],
      completedAt: "2026-05-15T00:00:00.000Z",
      setupMinutes: 8,
      commands: [
        "npx --package @cf-auth/cli@alpha cf-auth init my-app --template hono-basic",
        "cd my-app",
        "pnpm install",
        "npx --package @cf-auth/cli@alpha cf-auth migrate --local",
        "npm run dev",
      ],
      cleanDirectory: true,
      documentedCommandsOnly: true,
      signupLoginVerified: true,
    })),
    productionDeploys: Array.from({ length: 3 }, (_, index) => ({
      user: alphaUsers[index],
      completedAt: "2026-05-15T00:00:00.000Z",
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
    verifiedAt: "2026-05-15T00:00:00.000Z",
    verifiedBy: "release-captain-ada",
    templateRepositoryUrl:
      "https://github.com/cf-auth-release/cloudflare-auth-template",
    deployButtonUrl:
      "https://deploy.workers.cloudflare.com/?url=https://github.com/cf-auth-release/cloudflare-auth-template",
    packageTag: "beta",
    deployedOrigin: "https://auth.cf-auth-release.dev",
    starterTemplateCreated: true,
    templateRepositoryPublic: true,
    templateHasNoWorkspaceDependencies: true,
    d1BindingConfigured: true,
    emailBindingConfigured: true,
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
    reviewedAt: "2026-05-15T00:00:00.000Z",
    reviewedBy: "release-captain-ada",
    publishedQuickstart: {
      workflowRunUrl:
        "https://github.com/cf-auth-release/cloudflare-auth/actions/runs/123",
      packageTag: "beta",
      passed: true,
      cleanDirectory: true,
      documentedCommandsOnly: true,
      noWorkspaceDependencies: true,
      signupLoginVerified: true,
    },
    manualQuickstart: {
      maintainer: "release-captain-ada",
      completedAt: "2026-05-15T00:00:00.000Z",
      packageTag: "beta",
      commands: [
        "npx --package @cf-auth/cli@beta cf-auth init my-app --template hono-basic",
        "cd my-app",
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
        "https://github.com/cf-auth-release/cloudflare-auth/actions/runs/124",
      packageTag: "beta",
      origin: "https://auth.cf-auth-release.dev",
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
    reviewedAt: "2026-05-15T00:00:00.000Z",
    reviewedBy: "release-captain-ada",
    issueSearchUrl:
      "https://github.com/cf-auth-release/cloudflare-auth/issues?q=is%3Aissue%20is%3Aopen%20label%3Aauth%20label%3Ahigh%2Ccritical",
    advisorySearchUrl:
      "https://github.com/cf-auth-release/cloudflare-auth/security/advisories",
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

function runReleaseGates(cwd: string, env: Record<string, string> = {}) {
  const root = process.cwd();
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", "release-gates.mjs")],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        PATH: `${join(cwd, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      },
    },
  );
}
