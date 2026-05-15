import { existsSync } from "node:fs";
import { join } from "node:path";

export const releaseReadinessAuditPath = "docs/release-readiness-audit.md";

const allowedMissingReleaseReadinessAuditPaths = new Set([
  "docs/alpha-evidence.json",
  "docs/beta-evidence.json",
  "docs/deploy-button-evidence.json",
  "docs/package-ownership.json",
  "docs/security-release-tracker.json",
]);

export const requiredReleaseReadinessAuditText = [
  "cloudflare_auth_implementation_plan.md",
  "## Completion Audit",
  "## Non-Negotiable Rules Audit",
  "Repositories never generate raw auth tokens",
  "scripts/lint.mjs",
  "interpolated D1 `prepare`/`exec` template SQL",
  "tests/lint.test.ts",
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
  "0.0.0-*",
  "## Release Rule",
  "not ready for public beta or stable 1.0",
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
];

export function collectReleaseReadinessAuditFailures(audit, options = {}) {
  const {
    path = releaseReadinessAuditPath,
    missingTextMessage = (needle) => `${path}: missing ${needle}`,
    missingStageMessage = (stage) => `${path}: missing Stage ${stage}`,
    missingRuleMessage = (rule) => `${path}: missing Rule ${rule}`,
  } = options;
  const failures = [];

  for (const needle of requiredReleaseReadinessAuditText) {
    if (!audit.includes(needle)) {
      failures.push(missingTextMessage(needle));
    }
  }
  for (let stage = 0; stage <= 12; stage += 1) {
    if (!audit.includes(`Stage ${stage}`)) {
      failures.push(missingStageMessage(stage));
    }
  }
  for (let rule = 1; rule <= 28; rule += 1) {
    if (!new RegExp(`\\|\\s*${rule}\\s*\\|`, "u").test(audit)) {
      failures.push(missingRuleMessage(rule));
    }
  }

  return failures;
}

export function collectReleaseReadinessAuditTestReferenceFailures(
  audit,
  options = {},
) {
  const {
    root = process.cwd(),
    path = releaseReadinessAuditPath,
    missingTestMessage = (testPath) =>
      `${path}: referenced test file does not exist: ${testPath}`,
  } = options;
  const failures = [];
  const testReferences = new Set(
    [...audit.matchAll(/`(tests\/[^`\s]+\.test\.ts)`/gu)].map(
      (match) => match[1],
    ),
  );

  for (const testPath of [...testReferences].sort()) {
    if (!existsSync(join(root, testPath))) {
      failures.push(missingTestMessage(testPath));
    }
  }

  return failures;
}

export function collectReleaseReadinessAuditPathReferenceFailures(
  audit,
  options = {},
) {
  const {
    root = process.cwd(),
    path = releaseReadinessAuditPath,
    missingPathMessage = (repoPath) =>
      `${path}: referenced repo path does not exist: ${repoPath}`,
  } = options;
  const failures = [];

  for (const repoPath of releaseReadinessAuditPathReferences(audit)) {
    if (allowedMissingReleaseReadinessAuditPaths.has(repoPath)) continue;
    if (/^tests\/[^`\s]+\.test\.ts$/u.test(repoPath)) continue;
    if (!existsSync(join(root, repoPath))) {
      failures.push(missingPathMessage(repoPath));
    }
  }

  return failures;
}

export function releaseReadinessAuditPathReferences(audit) {
  const pathPrefix =
    /^(?:\.changeset\/|\.github\/|docs\/|examples\/|migrations\/|packages\/|schemas\/|scripts\/|templates\/|tests\/|CONTRIBUTING\.md$|LICENSE$|README\.md$|SECURITY\.md$|package\.json$|pnpm-workspace\.yaml$|tsconfig[\w.-]*$|tsup\.config\.ts$|vitest[\w.-]*$)/u;
  return [
    ...new Set(
      [...audit.matchAll(/`([^`]+)`/gu)]
        .map((match) => match[1])
        .filter((value) => pathPrefix.test(value))
        .filter((value) => !/[\s*]/u.test(value)),
    ),
  ].sort();
}
