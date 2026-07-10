import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("package checks", () => {
  it("accepts the release workflow fixture", async () => {
    const root = await packageCheckFixture();
    const result = runPackageCheck(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects non-object root package manifests", async () => {
    const root = await packageCheckFixture();
    await writeFile(join(root, "package.json"), "null\n");
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "package.json: top-level JSON value must be an object",
    );
  });

  it("rejects non-object workspace package manifests", async () => {
    const root = await packageCheckFixture();
    await writeFile(join(root, "packages", "cli", "package.json"), "null\n");
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "packages/cli/package.json: top-level JSON value must be an object",
    );
  });

  it("requires explicit root export map fields to match package entrypoints", async () => {
    const root = await packageCheckFixture();
    const manifestPath = join(root, "packages", "client", "package.json");
    const pkg = JSON.parse(await readFile(manifestPath, "utf8"));
    delete pkg.exports["."].types;
    pkg.exports["."].import = "./dist/other.js";
    pkg.exports["."].require = "./dist/other.cjs";
    await writeFile(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`);
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "@cf-auth/client: root export map missing types",
    );
    expect(result.stderr).toContain(
      "@cf-auth/client: root export import must match module field",
    );
    expect(result.stderr).toContain(
      "@cf-auth/client: root export require must match main field",
    );
  });

  it("rejects non-object version matrix manifests", async () => {
    const root = await packageCheckFixture();
    await writeFile(join(root, "scripts", "version-matrix.json"), "null\n");
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "scripts/version-matrix.json: top-level JSON value must be an object",
    );
  });

  it("requires the release readiness audit", async () => {
    const root = await packageCheckFixture();
    await rm(join(root, "docs", "release-readiness-audit.md"));
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/release-readiness-audit.md: required documentation file is missing",
    );
  });

  it("requires README to cover every plan-required reader path", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "README.md",
      "## Supported Frameworks",
      "## Frameworks",
    );
    await replaceFixtureText(
      root,
      "README.md",
      "## Troubleshooting",
      "## Help",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "README.md: missing README requirement supported frameworks",
    );
    expect(result.stderr).toContain(
      "README.md: missing README requirement troubleshooting links",
    );
  });

  it("requires package READMEs to carry the independent-project disclaimer", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "packages/core/README.md",
      "Cloudflare Auth is an independent open-source project and is not affiliated with, endorsed by, or sponsored by Cloudflare.",
      "Cloudflare Auth is an authentication package.",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "@cf-auth/core: README must include independent-project disclaimer",
    );
  });

  it("requires detailed release readiness audit sections", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "## Non-Negotiable Rules Audit",
      "## Rule Notes",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/release-readiness-audit.md: missing ## Non-Negotiable Rules Audit",
    );
  });

  it("requires release readiness audit coverage for functional spec sections", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "## Functional Specification Audit",
      "## Functional Notes",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/release-readiness-audit.md: missing ## Functional Specification Audit",
    );
  });

  it("requires release readiness audit coverage for testing and beta checklists", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "## Testing, CI, And Docs Plan Audit",
      "## Verification Notes",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/release-readiness-audit.md: missing ## Testing, CI, And Docs Plan Audit",
    );
  });

  it("requires release readiness audit coverage for current local verification", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "Recent local verification has passed for:",
      "Recent verification:",
    );
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "- `pnpm smoke:wrangler-dev`",
      "- `pnpm smoke:local-worker`",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/release-readiness-audit.md: missing Recent local verification has passed for:",
    );
  });

  it("requires release readiness audit coverage for source notes and README draft", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "## Source Notes And README Draft Audit",
      "## Source Notes",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/release-readiness-audit.md: missing ## Source Notes And README Draft Audit",
    );
  });

  it("requires release readiness audit coverage for every blocking evidence gate", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "| Published quickstart smoke",
      "| Published quickstart",
    );
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "not be fabricated in the repo",
      "not be copied from examples",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/release-readiness-audit.md: missing Published quickstart smoke",
    );
    expect(result.stderr).toContain(
      "docs/release-readiness-audit.md: missing not be fabricated in the repo",
    );
  });

  it("requires release readiness audit coverage for every non-negotiable rule", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "| 28   | Repositories never generate raw auth tokens.",
      "| --   | Repositories never generate raw auth tokens.",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/release-readiness-audit.md: missing Rule 28",
    );
  });

  it("requires release readiness audit to mention SQL interpolation lint coverage", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/release-readiness-audit.md",
      "interpolated D1 `prepare`/`exec` template SQL",
      "D1 SQL templates",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/release-readiness-audit.md: missing interpolated D1 `prepare`/`exec` template SQL",
    );
  });

  it("requires public non-goal summaries to include every v1 exclusion", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/roadmap.md",
      "password peppering",
      "password hardening",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/roadmap.md: missing v1 exclusion password peppering",
    );
  });

  it("requires troubleshooting docs to keep raw Wrangler commands secondary", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/troubleshooting.md",
      "Use `cf-auth` commands first.",
      "Use either tool.",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/troubleshooting.md: missing Wrangler fallback note",
    );
  });

  it("requires troubleshooting docs to cover the plan matrix", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/troubleshooting.md",
      "JSON request returns `415`",
      "JSON request fails",
    );
    await replaceFixtureText(
      root,
      "docs/troubleshooting.md",
      "Magic link redirect rejected",
      "Magic redirect rejected",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/troubleshooting.md: missing exact fix for JSON request returns `415`",
    );
    expect(result.stderr).toContain(
      "docs/troubleshooting.md: missing exact fix for Magic link redirect rejected",
    );
  });

  it("blocks unavailable package commands in package READMEs", async () => {
    const root = await packageCheckFixture();
    await writeFile(
      join(root, "packages", "cli", "README.md"),
      "# @cf-auth/cli\n\nRun `npx cf-auth@latest init`.\n",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "packages/cli/README.md: npx cf-auth commands are blocked until package ownership is confirmed",
    );
  });

  it("blocks unowned package manager shortcuts in public docs", async () => {
    const root = await packageCheckFixture();
    await writeFile(
      join(root, "docs", "package-shortcuts-fixture.md"),
      [
        "# Roadmap",
        "",
        "Do not publish `npm init cloudflare-auth my-app`.",
        "Do not publish `pnpm dlx cf-auth@latest init`.",
        "Do not publish `pnpm create cloudflare-auth@latest my-app`.",
        "Do not publish `yarn dlx cf-auth init`.",
        "Do not publish `yarn create cloudflare-auth my-app`.",
        "Do not publish `bunx cf-auth init`.",
        "Do not publish `bun create cloudflare-auth my-app`.",
      ].join("\n"),
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    for (const label of [
      "npm init cloudflare-auth",
      "pnpm dlx cf-auth",
      "pnpm create cloudflare-auth",
      "yarn dlx cf-auth",
      "yarn create cloudflare-auth",
      "bunx cf-auth",
      "bun create cloudflare-auth",
    ]) {
      expect(result.stderr).toContain(
        `docs/package-shortcuts-fixture.md: ${label} commands are blocked until package ownership is confirmed`,
      );
    }
  });

  it("allows similarly named package manager commands in public docs", async () => {
    const root = await packageCheckFixture();
    await writeFile(
      join(root, "docs", "package-shortcuts-allowlist.md"),
      [
        "# Roadmap",
        "",
        "The blocklist should not catch `npx cf-authentication init`.",
        "The blocklist should not catch `npm create cloudflare-auth-app`.",
        "The blocklist should not catch `npm init cloudflare-auth-app`.",
        "The blocklist should not catch `pnpm dlx cf-auth-helper init`.",
        "The blocklist should not catch `pnpm create cloudflare-auth-app`.",
        "The blocklist should not catch `yarn dlx cf-auth-helper init`.",
        "The blocklist should not catch `yarn create cloudflare-auth-app`.",
        "The blocklist should not catch `bunx cf-auth-helper init`.",
        "The blocklist should not catch `bun create cloudflare-auth-app`.",
      ].join("\n"),
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("blocks unsupported v1 command aliases in public docs", async () => {
    const root = await packageCheckFixture();
    await writeFile(
      join(root, "docs", "roadmap.md"),
      "# Roadmap\n\nRun `cf-auth upgrade` or `cf-auth add turnstile`.\n",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/roadmap.md: unsupported v1 command alias cf-auth upgrade",
    );
    expect(result.stderr).toContain(
      "docs/roadmap.md: unsupported v1 command alias cf-auth add turnstile",
    );
  });

  it("requires the production smoke workflow safety gate", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/cloudflare-production-smoke.yml",
      'CF_AUTH_PRODUCTION_SMOKE: "1"',
      'CF_AUTH_PRODUCTION_SMOKE: "0"',
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '.github/workflows/cloudflare-production-smoke.yml: missing CF_AUTH_PRODUCTION_SMOKE: "1"',
    );
  });

  it("requires the published quickstart package tag input", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/published-quickstart-smoke.yml",
      "CF_AUTH_PUBLISHED_QUICKSTART_PACKAGE_TAG",
      "CF_AUTH_PUBLISHED_QUICKSTART_VERSION",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/published-quickstart-smoke.yml: missing CF_AUTH_PUBLISHED_QUICKSTART_PACKAGE_TAG",
    );
  });

  it("requires beta-only smoke package tag descriptions", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/published-quickstart-smoke.yml",
      "Beta npm dist-tag or x.y.z-beta.* prerelease version to smoke.",
      "npm dist-tag or version to smoke, for example beta.",
    );
    await replaceFixtureText(
      root,
      ".github/workflows/cloudflare-production-smoke.yml",
      "Optional beta npm dist-tag or x.y.z-beta.* prerelease version to smoke. Empty uses local package tarballs.",
      "Optional npm dist-tag or version to smoke, for example beta. Empty uses local package tarballs.",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/published-quickstart-smoke.yml: missing Beta npm dist-tag or x.y.z-beta.* prerelease version to smoke.",
    );
    expect(result.stderr).toContain(
      ".github/workflows/cloudflare-production-smoke.yml: missing Optional beta npm dist-tag or x.y.z-beta.* prerelease version to smoke. Empty uses local package tarballs.",
    );
  });

  it("rejects invalid changesets config JSON", async () => {
    const root = await packageCheckFixture();
    await writeFile(join(root, ".changeset", "config.json"), "not json\n");
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".changeset/config.json: must be valid JSON",
    );
  });

  it("rejects non-object changesets config", async () => {
    const root = await packageCheckFixture();
    await writeFile(join(root, ".changeset", "config.json"), "null\n");
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".changeset/config.json: top-level JSON value must be an object",
    );
  });

  it("rejects placeholder package ownership example versions", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/package-ownership.example.json",
      '"version": "0.1.0-beta.0"',
      '"version": "0.0.0"',
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/package-ownership.example.json: package examples must use non-placeholder target versions",
    );
  });

  it("rejects non-object package ownership examples", async () => {
    const root = await packageCheckFixture();
    await writeFile(
      join(root, "docs", "package-ownership.example.json"),
      "null\n",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/package-ownership.example.json: top-level JSON value must be an object",
    );
  });

  it("requires documented release version channels", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/decisions/package-naming.md",
      "private alpha: `x.y.z-alpha.N`",
      "private alpha releases",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/decisions/package-naming.md: missing private alpha: `x.y.z-alpha.N`",
    );
  });

  it("requires docs to reject placeholder prerelease versions", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/decisions/package-naming.md",
      "`0.0.0-alpha.*`",
      "`0.0.0-preview.*`",
    );
    await replaceFixtureText(
      root,
      "docs/release-checklist.md",
      "never `0.0.0-*`",
      "never placeholder prereleases",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/decisions/package-naming.md: missing 0.0.0-alpha.*",
    );
    expect(result.stderr).toContain(
      "docs/release-checklist.md: missing never `0.0.0-*`",
    );
  });

  it("requires fallback scope availability docs to avoid treating E404 as ownership", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/decisions/package-naming.md",
      "@cloudflare-auth/email-cloudflare",
      "@cloudflare-auth/email",
    );
    await replaceFixtureText(
      root,
      "docs/decisions/package-naming.md",
      "availability signal only",
      "availability evidence",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/decisions/package-naming.md: missing package naming evidence @cloudflare-auth/email-cloudflare",
    );
    expect(result.stderr).toContain(
      "docs/decisions/package-naming.md: missing package naming evidence availability signal only",
    );
  });

  it("requires primary package availability docs to stay explicit", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/decisions/package-naming.md",
      "cf-auth@1.0.2",
      "cf-auth exists",
    );
    await replaceFixtureText(
      root,
      "docs/decisions/package-naming.md",
      "public docs must not use `npm create cloudflare-auth`",
      "public docs must use the create package carefully",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/decisions/package-naming.md: missing package naming evidence cf-auth@1.0.2",
    );
    expect(result.stderr).toContain(
      "docs/decisions/package-naming.md: missing package naming evidence public docs must not use `npm create cloudflare-auth`",
    );
  });

  it("requires alternate package manager command docs to stay explicit", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/decisions/package-naming.md",
      "public docs must also not use `npm init cloudflare-auth`",
      "public docs must avoid equivalent create commands",
    );
    await replaceFixtureText(
      root,
      "docs/decisions/package-naming.md",
      "`yarn create cloudflare-auth`",
      "`yarn create cloudflare-auth-app`",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/decisions/package-naming.md: missing package naming evidence public docs must also not use `npm init cloudflare-auth`",
    );
    expect(result.stderr).toContain(
      "docs/decisions/package-naming.md: missing package naming evidence `yarn create cloudflare-auth`",
    );
  });

  it("requires package ownership docs to cover redaction rules", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/decisions/package-naming.md",
      "raw secrets, auth tokens, cookies, emails, IPs, user agents",
      "raw secrets and tokens",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/decisions/package-naming.md: missing package naming evidence raw secrets, auth tokens, cookies, emails, IPs, user agents",
    );
  });

  it("requires the root test script to avoid Vitest file parallelism", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "package.json",
      "vitest run --no-file-parallelism",
      "vitest run",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "package.json: test must run vitest with --no-file-parallelism",
    );
  });

  it("requires the root test script to keep running Vitest", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "package.json",
      "vitest run --no-file-parallelism",
      "echo vitest run --no-file-parallelism",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "package.json: test must run vitest with --no-file-parallelism",
    );
  });

  it("requires release gates before package publication", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "      - run: pnpm release:gates",
      "      - run: pnpm changeset publish --provenance\n      - run: pnpm release:gates",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: pnpm changeset publish --provenance must appear after pnpm publish:dry-run",
    );
  });

  it("requires dry-run publish before package publication", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "      - run: pnpm publish:dry-run",
      "      - run: pnpm package:check",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: missing pnpm publish:dry-run",
    );
  });

  it("requires deploy button evidence before beta evidence", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "      - run: pnpm verify:deploy-button-evidence\n      - run: pnpm verify:beta-evidence",
      "      - run: pnpm verify:beta-evidence\n      - run: pnpm verify:deploy-button-evidence",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: pnpm verify:beta-evidence must appear after pnpm verify:deploy-button-evidence",
    );
  });

  it("requires release audit verification before security docs verification", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "      - run: pnpm verify:release-audit\n      - run: pnpm verify:security-docs",
      "      - run: pnpm verify:security-docs\n      - run: pnpm verify:release-audit",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: pnpm verify:security-docs must appear after pnpm verify:release-audit",
    );
  });

  it("requires package-name checks in the every-release checklist", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/release-checklist.md",
      "- `pnpm check:package-names`\n- `pnpm verify:release-audit`",
      "- `pnpm verify:release-audit`",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/release-checklist.md: Every Release missing pnpm check:package-names",
    );
  });

  it("requires every-release checklist commands to stay in release order", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/release-checklist.md",
      "- `pnpm verify:deploy-button-evidence`\n- `pnpm verify:beta-evidence`",
      "- `pnpm verify:beta-evidence`\n- `pnpm verify:deploy-button-evidence`",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/release-checklist.md Every Release: pnpm verify:beta-evidence must appear after pnpm verify:deploy-button-evidence",
    );
  });

  it("derives release workflow coverage from verifier scripts", async () => {
    const root = await packageCheckFixture();
    const packagePath = join(root, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      scripts: Record<string, string>;
    };
    pkg.scripts["verify:new-gate"] = "node scripts/verify-new-gate.mjs";
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: missing pnpm verify:new-gate",
    );
  });

  it("requires dry-run publish artifact upload", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "pnpm-publish-summary.json",
      "publish-summary.json",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: missing pnpm-publish-summary.json",
    );
  });

  it("requires tarball smoke to run in install mode", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      [
        "      - run: pnpm smoke:tarballs",
        "        env:",
        '          CF_AUTH_TARBALL_INSTALL: "1"',
        "      - run: pnpm benchmark:password",
      ].join("\n"),
      [
        "      - run: pnpm smoke:tarballs",
        "      - run: pnpm benchmark:password",
        "        env:",
        '          CF_AUTH_TARBALL_INSTALL: "1"',
      ].join("\n"),
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '.github/workflows/release.yml: pnpm smoke:tarballs must run with CF_AUTH_TARBALL_INSTALL: "1"',
    );
  });

  it("requires publish dry-run script to emit a summary artifact", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(root, "package.json", " --report-summary", "");
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "package.json: publish:dry-run missing --report-summary",
    );
  });

  it("requires tests before package publication", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "      - run: pnpm typecheck",
      "      - run: pnpm test\n      - run: pnpm typecheck",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: pnpm test must appear after pnpm typecheck",
    );
  });

  it("requires workflow toolchain versions to match the version matrix", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/ci.yml",
      "node-version: 22.13.0",
      "node-version: 20.0.0",
    );
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "version: 11.1.1",
      "version: 10.0.0",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/ci.yml: node-version must be 22.13.0",
    );
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: pnpm/action-setup version must be 11.1.1",
    );
  });

  it("requires security automation workflow controls", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/dependency-review.yml",
      "actions/dependency-review-action@v5",
      "actions/checkout@v5",
    );
    await replaceFixtureText(
      root,
      ".github/workflows/codeql.yml",
      "languages: javascript-typescript",
      "languages: csharp",
    );
    await replaceFixtureText(
      root,
      ".github/dependabot.yml",
      "package-ecosystem: github-actions",
      "package-ecosystem: docker",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/dependency-review.yml: missing actions/dependency-review-action@v5",
    );
    expect(result.stderr).toContain(
      ".github/workflows/codeql.yml: missing languages: javascript-typescript",
    );
    expect(result.stderr).toContain(
      ".github/dependabot.yml: missing package-ecosystem: github-actions",
    );
  });

  it("requires npm auth token wiring for publication", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "NODE_AUTH_TOKEN",
      "NODE_PACKAGE_TOKEN",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: missing NODE_AUTH_TOKEN",
    );
  });

  it("requires package-name confirmation to be a required boolean input", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "        required: true\n        type: boolean",
      "        required: false\n        type: string",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: package_names_confirmed must be a required boolean workflow input",
    );
  });

  it("requires the package-name confirmation gate to fail before checkout", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "        if: ${{ !inputs.package_names_confirmed }}",
      "        if: ${{ false }}",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: package_names_confirmed must be enforced by an early failing gate step",
    );
  });

  it("requires the package-name confirmation gate to run before checkout", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      `      - name: Require package-name gate
        if: \${{ !inputs.package_names_confirmed }}
        run: |
          echo "Set package_names_confirmed=true only after npm package names and public docs are verified."
          exit 1
      - uses: actions/checkout@v5`,
      `      - uses: actions/checkout@v5
      - name: Require package-name gate
        if: \${{ !inputs.package_names_confirmed }}
        run: |
          echo "Set package_names_confirmed=true only after npm package names and public docs are verified."
          exit 1`,
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: package-name gate must run before checkout",
    );
  });

  it("requires checked-in password benchmark evidence", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      "docs/decisions/password-benchmark.md",
      "workers-local",
      "node-local",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/decisions/password-benchmark.md: missing benchmark evidence text workers-local",
    );
  });

  it("rejects publishable package version drift", async () => {
    const root = await packageCheckFixture();
    await updatePackageJson(root, "packages/client/package.json", {
      privateValue: false,
      version: "0.0.1",
    });
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "publishable packages must share one version",
    );
    expect(result.stderr).toContain("@cf-auth/client@0.0.1");
    expect(result.stderr).toContain("@cf-auth/cli@0.0.0");
  });

  it("rejects placeholder prerelease publishable package versions", async () => {
    for (const packageVersion of ["0.0.0-alpha.0", "0.0.0-beta.0"]) {
      const root = await packageCheckFixture();
      for (const packageDir of defaultPublishablePackageDirs) {
        await updatePackageJson(root, `packages/${packageDir}/package.json`, {
          privateValue: false,
          version: packageVersion,
        });
      }

      const result = runPackageCheck(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `@cf-auth/cli@${packageVersion}: release version must not use placeholder 0.0.0 base`,
      );
    }
  }, 20_000);

  it("rejects unsupported publishable package release channels", async () => {
    for (const packageVersion of [
      "0.1.0",
      "0.1.0-alpha",
      "0.1.0-beta",
      "1.0.0-rc.0",
    ]) {
      const root = await packageCheckFixture();
      for (const packageDir of defaultPublishablePackageDirs) {
        await updatePackageJson(root, `packages/${packageDir}/package.json`, {
          privateValue: false,
          version: packageVersion,
        });
      }

      const result = runPackageCheck(root);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        `@cf-auth/cli@${packageVersion}: release versions must use alpha, beta, or stable 1.0+`,
      );
    }
  }, 20_000);

  it("rejects workspace dependency ranges in packed manifests", async () => {
    const root = await packageCheckFixture();
    await writeFakePackTools(root);
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "packed package.json must not contain workspace: dependency ranges",
    );
  });

  it("rejects non-object pnpm pack JSON output", async () => {
    const root = await packageCheckFixture();
    await writeFakePackTools(root, { packOutput: "null\n" });
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pnpm pack JSON output must be an object");
  });

  it("rejects publishing reserved package shims without ownership evidence", async () => {
    const root = await packageCheckFixture();
    await updatePackageJson(root, "packages/cf-auth-shim/package.json", {
      privateValue: false,
      version: "0.1.0-beta.0",
    });
    await writeChangesetFixedGroup(root, [
      ...defaultPublishablePackages,
      "cf-auth",
    ]);
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/package-ownership.json: required before publishing reserved packages",
    );
    expect(result.stderr).toContain(
      "cf-auth: docs/package-ownership.json must include ownership evidence before removing private: true",
    );
  });

  it("rejects malformed package ownership evidence before publishing reserved shims", async () => {
    const root = await packageCheckFixture();
    await updatePackageJson(root, "packages/cf-auth-shim/package.json", {
      privateValue: false,
      version: "0.1.0-beta.0",
    });
    await writeChangesetFixedGroup(root, [
      ...defaultPublishablePackages,
      "cf-auth",
    ]);
    await writeFile(join(root, "docs", "package-ownership.json"), "null\n");
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/package-ownership.json: top-level JSON value must be an object",
    );
  });

  it("rejects malformed package ownership evidence entries before publishing reserved shims", async () => {
    const root = await packageCheckFixture();
    await updatePackageJson(root, "packages/cf-auth-shim/package.json", {
      privateValue: false,
      version: "0.1.0-beta.0",
    });
    await writeChangesetFixedGroup(root, [
      ...defaultPublishablePackages,
      "cf-auth",
    ]);
    await writeFile(
      join(root, "docs", "package-ownership.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          packages: [null],
          reservedPackages: [null],
        },
        null,
        2,
      )}\n`,
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/package-ownership.json: packages[0] must be an object",
    );
    expect(result.stderr).toContain(
      "docs/package-ownership.json: reservedPackages[0] must be an object",
    );
  });

  it("rejects malformed package ownership evidence names before publishing reserved shims", async () => {
    const root = await packageCheckFixture();
    await updatePackageJson(root, "packages/cf-auth-shim/package.json", {
      privateValue: false,
      version: "0.1.0-beta.0",
    });
    await writeOwnershipEvidence(root, ["cf-auth"]);
    await writeChangesetFixedGroup(root, [
      ...defaultPublishablePackages,
      "cf-auth",
    ]);
    const target = join(root, "docs", "package-ownership.json");
    const evidence = JSON.parse(await readFile(target, "utf8")) as {
      packages: unknown[];
      reservedPackages: unknown[];
    };
    evidence.packages.push(
      {
        name: "   ",
        registry: "https://registry.npmjs.org/",
        version: "0.1.0-beta.0",
        ownershipConfirmed: true,
        publisherTwoFactorEnabled: true,
        provenancePublish: true,
      },
      {
        name: "@cf-auth/unknown",
        registry: "https://registry.npmjs.org/",
        version: "0.1.0-beta.0",
        ownershipConfirmed: true,
        publisherTwoFactorEnabled: true,
        provenancePublish: true,
      },
      {
        name: "create-cloudflare-auth",
        registry: "https://registry.npmjs.org/",
        version: "0.1.0-beta.0",
        ownershipConfirmed: true,
        publisherTwoFactorEnabled: true,
        provenancePublish: true,
      },
    );
    evidence.reservedPackages.push(
      {
        name: 1,
        registry: "https://registry.npmjs.org/",
        publishableAfterOwnershipConfirmed: true,
      },
      {
        name: "not-a-workspace-package",
        registry: "https://registry.npmjs.org/",
        publishableAfterOwnershipConfirmed: true,
      },
    );
    await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`);
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/package-ownership.json: packages[1].name must be a non-empty string",
    );
    expect(result.stderr).toContain(
      "docs/package-ownership.json: @cf-auth/unknown must match a publishable workspace package",
    );
    expect(result.stderr).toContain(
      "docs/package-ownership.json: create-cloudflare-auth must match a publishable workspace package",
    );
    expect(result.stderr).toContain(
      "docs/package-ownership.json: reservedPackages[0].name must be a non-empty string",
    );
    expect(result.stderr).toContain(
      "docs/package-ownership.json: not-a-workspace-package must not be listed under reservedPackages unless its workspace package is private",
    );
  });

  it("rejects package ownership evidence without explicit arrays before publishing reserved shims", async () => {
    const root = await packageCheckFixture();
    await updatePackageJson(root, "packages/cf-auth-shim/package.json", {
      privateValue: false,
      version: "0.1.0-beta.0",
    });
    await writeChangesetFixedGroup(root, [
      ...defaultPublishablePackages,
      "cf-auth",
    ]);
    await writeFile(
      join(root, "docs", "package-ownership.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          verifiedAt: "2026-05-15T00:00:00.000Z",
          verifiedBy: "release-captain-ada",
        },
        null,
        2,
      )}\n`,
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/package-ownership.json: packages must be an array",
    );
    expect(result.stderr).toContain(
      "docs/package-ownership.json: reservedPackages must be an array",
    );
  });

  it("rejects duplicate package ownership evidence before publishing reserved shims", async () => {
    const root = await packageCheckFixture();
    await updatePackageJson(root, "packages/cf-auth-shim/package.json", {
      privateValue: false,
      version: "0.1.0-beta.0",
    });
    await writeOwnershipEvidence(root, ["cf-auth"]);
    await writeChangesetFixedGroup(root, [
      ...defaultPublishablePackages,
      "cf-auth",
    ]);
    const target = join(root, "docs", "package-ownership.json");
    const evidence = JSON.parse(await readFile(target, "utf8")) as {
      packages: unknown[];
      reservedPackages: unknown[];
    };
    evidence.packages.push(evidence.packages[0]);
    evidence.reservedPackages.push({
      name: "create-cloudflare-auth",
      registry: "https://registry.npmjs.org/",
      publishableAfterOwnershipConfirmed: true,
    });
    evidence.reservedPackages.push(evidence.reservedPackages[0]);
    await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`);
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/package-ownership.json: duplicate package evidence for cf-auth",
    );
    expect(result.stderr).toContain(
      "docs/package-ownership.json: duplicate reserved package evidence for create-cloudflare-auth",
    );
  });

  it("allows reserved package shims to publish after ownership evidence", async () => {
    const root = await packageCheckFixture();
    for (const packageDir of defaultPublishablePackageDirs) {
      await updatePackageJson(root, `packages/${packageDir}/package.json`, {
        privateValue: false,
        version: "0.1.0-beta.0",
      });
    }
    await updatePackageJson(root, "packages/cf-auth-shim/package.json", {
      privateValue: false,
      version: "0.1.0-beta.0",
    });
    await updatePackageJson(
      root,
      "packages/create-cloudflare-auth/package.json",
      {
        privateValue: false,
        version: "0.1.0-beta.0",
      },
    );
    await writeOwnershipEvidence(root, ["cf-auth", "create-cloudflare-auth"]);
    await writeChangesetFixedGroup(root, [
      ...defaultPublishablePackages,
      "cf-auth",
      "create-cloudflare-auth",
    ]);
    const result = runPackageCheck(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

const defaultPublishablePackages = [
  "@cf-auth/cli",
  "@cf-auth/client",
  "@cf-auth/core",
  "@cf-auth/email-cloudflare",
  "@cf-auth/hono",
  "@cf-auth/testing",
  "@cf-auth/worker",
];

const defaultPublishablePackageDirs = [
  "cli",
  "client",
  "core",
  "email-cloudflare",
  "hono",
  "testing",
  "worker",
];

async function packageCheckFixture() {
  const sourceRoot = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "cf-auth-package-check-"));
  for (const file of [
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "tsconfig.build.json",
    "tsup.config.ts",
    "vitest.config.ts",
    "vitest.workers.config.ts",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
  ]) {
    await cp(join(sourceRoot, file), join(root, file));
  }
  for (const dir of [
    "docs",
    "examples",
    "migrations",
    "packages",
    "schemas",
    "scripts",
    "tests",
    ".github",
    ".changeset",
  ]) {
    await cp(join(sourceRoot, dir), join(root, dir), { recursive: true });
  }
  return root;
}

async function replaceFixtureText(
  root: string,
  path: string,
  search: string,
  replacement: string,
) {
  const target = join(root, path);
  const text = await readFile(target, "utf8");
  if (!text.includes(search)) {
    throw new Error(`${path}: missing fixture text ${search}`);
  }
  await writeFile(target, text.replace(search, replacement));
}

async function updatePackageJson(
  root: string,
  path: string,
  options: { privateValue: boolean; version: string },
) {
  const target = join(root, path);
  const pkg = JSON.parse(await readFile(target, "utf8"));
  pkg.private = options.privateValue;
  pkg.version = options.version;
  await writeFile(target, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function writeChangesetFixedGroup(root: string, packageNames: string[]) {
  const target = join(root, ".changeset", "config.json");
  const config = JSON.parse(await readFile(target, "utf8"));
  config.fixed = [[...packageNames].sort()];
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeOwnershipEvidence(root: string, packageNames: string[]) {
  await writeFile(
    join(root, "docs", "package-ownership.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        verifiedAt: "2026-05-15T00:00:00.000Z",
        verifiedBy: "release-captain-ada",
        packages: packageNames.map((name) => ({
          name,
          registry: "https://registry.npmjs.org/",
          version: "0.1.0-beta.0",
          ownershipConfirmed: true,
          publisherTwoFactorEnabled: true,
          provenancePublish: true,
        })),
        reservedPackages: [],
      },
      null,
      2,
    )}\n`,
  );
}

async function writeFakePackTools(
  root: string,
  options: { packOutput?: string } = {},
) {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const pnpmPath = join(binDir, "pnpm");
  await writeFile(
    pnpmPath,
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const forcedOutput = ${JSON.stringify(options.packOutput ?? "")};
if (forcedOutput) {
  process.stdout.write(forcedOutput);
  process.exit(0);
}
const args = process.argv.slice(2);
const dir = args[args.indexOf("--dir") + 1];
const destination = args[args.indexOf("--pack-destination") + 1];
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
mkdirSync(destination, { recursive: true });
const filename = join(destination, basename(dir) + ".tgz");
writeFileSync(filename, "");
writeFileSync(filename + ".package.json", JSON.stringify(pkg));
const paths = new Set(["package.json", "README.md", "LICENSE"]);
for (const value of [pkg.types, pkg.main, pkg.module]) {
  if (value) paths.add(String(value).replace(/^\\.\\//, ""));
}
for (const entry of Object.values(pkg.exports?.["."] ?? {})) {
  if (entry) paths.add(String(entry).replace(/^\\.\\//, ""));
}
for (const entry of Object.values(pkg.bin ?? {})) {
  if (entry) paths.add(String(entry).replace(/^\\.\\//, ""));
}
console.log(JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  filename,
  files: [...paths].map((path) => ({ path }))
}));
`,
  );
  await chmod(pnpmPath, 0o755);

  const tarPath = join(binDir, "tar");
  await writeFile(
    tarPath,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const filename = process.argv[3];
process.stdout.write(readFileSync(filename + ".package.json", "utf8"));
`,
  );
  await chmod(tarPath, 0o755);
}

function runPackageCheck(cwd: string) {
  const root = process.cwd();
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", "package-check.mjs")],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(cwd, "bin")}:${process.env.PATH ?? ""}`,
      },
    },
  );
}
