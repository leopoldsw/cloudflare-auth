import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isPlaceholderEvidenceIdentity } from "./evidence-validation.mjs";
import { requiredAuthSmokeEndpoints } from "./smoke-endpoints.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(scriptDir);
const failures = [];

const packageDirs = (await readdir("packages", { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("packages", entry.name))
  .sort();
const rootPackage = await readJsonObject("package.json");
const rootScripts =
  rootPackage && isRecord(rootPackage.scripts) ? rootPackage.scripts : {};

const packages = [];
for (const dir of packageDirs) {
  const pkg = await readJsonObject(join(dir, "package.json"));
  if (!pkg) continue;
  if (!pkg.private) {
    let validPackageIdentity = true;
    if (typeof pkg.name !== "string" || pkg.name.trim().length === 0) {
      failures.push(`${dir}/package.json: name must be a non-empty string`);
      validPackageIdentity = false;
    }
    if (typeof pkg.version !== "string" || pkg.version.trim().length === 0) {
      failures.push(`${dir}/package.json: version must be a non-empty string`);
      validPackageIdentity = false;
    }
    if (validPackageIdentity) {
      packages.push({ dir, name: pkg.name, version: pkg.version });
    }
  }
}

await requireFile(".github/dependabot.yml");
await requireFile(".github/workflows/ci.yml");
await requireFile(".github/workflows/codeql.yml");
await requireFile(".github/workflows/cloudflare-production-smoke.yml");
await requireFile(".github/workflows/dependency-review.yml");
await requireFile(".github/workflows/examples.yml");
await requireFile(".github/workflows/published-quickstart-smoke.yml");
await requireFile(".github/workflows/release.yml");
await requireFile(".github/workflows/wrangler-dev-smoke.yml");
await requireFile(".github/ISSUE_TEMPLATE/alpha-feedback.yml");
await requireFile(".github/ISSUE_TEMPLATE/bug.yml");
await requireFile(".github/ISSUE_TEMPLATE/feature-request.yml");
await requireFile(".github/ISSUE_TEMPLATE/security-contact.md");
await requireFile("docs/alpha-evidence.example.json");
await requireFile("docs/alpha.md");
await requireFile("docs/beta-evidence.example.json");
await requireFile("docs/decisions/password-benchmark.md");
await requireFile("docs/deploy-button-evidence.example.json");
await requireFile("docs/deploy-to-cloudflare.md");
await requireFile("docs/known-limitations.md");
await requireFile("docs/package-ownership.example.json");
await requireFile("docs/platform-assumptions.md");
await requireFile("docs/public-beta.md");
await requireFile("docs/release-readiness-audit.md");
await requireFile("docs/security-release-tracker.example.json");
await requireFile("schemas/doctor-report.schema.json");
await requireFile("scripts/export-deploy-template.mjs");
await requireFile("scripts/check-package-names.mjs");
await requireFile("scripts/smoke-endpoints.mjs");
await requireFile("scripts/smoke-production-cloudflare.mjs");
await requireFile("scripts/verify-alpha-evidence.mjs");
await requireFile("scripts/verify-beta-evidence.mjs");
await requireFile("scripts/verify-deploy-button-evidence.mjs");
await requireFile("scripts/verify-deploy-template.mjs");
await requireFile("scripts/verify-docs-coverage.mjs");
await requireFile("scripts/verify-examples.mjs");
await requireFile("scripts/verify-migrations.mjs");
await requireFile("scripts/verify-package-ownership.mjs");
await requireFile("scripts/verify-security-docs.mjs");
await requireFile("scripts/verify-security-release-tracker.mjs");
await requireText("README.md", "SECURITY.md");
await requireText("SECURITY.md", "Expected Response Window");
await requireText("docs/release-checklist.md", "unresolved high/critical");
await requireText("docs/release-checklist.md", "public API report reviewed");
await requireText("docs/release-checklist.md", "config schema reviewed");
await requireText("docs/release-checklist.md", "security review decision");
await requireText("docs/release-checklist.md", "docs/platform-assumptions.md");
await requireText("docs/release-checklist.md", "release-readiness-audit.md");
await requireText(
  "docs/release-checklist.md",
  "pnpm install --frozen-lockfile",
);
await requireText("docs/release-checklist.md", "pnpm audit --audit-level high");
for (const script of releaseChecklistScripts(rootScripts)) {
  await requireText("docs/release-checklist.md", `pnpm ${script}`);
}
await requireText("docs/decisions/password-benchmark.md", "workers-local");
await requireText("docs/decisions/password-benchmark.md", "p95Ms");
await requireText(
  "docs/decisions/password-benchmark.md",
  "throughputHashesPerSecond",
);
await requireText(
  "docs/decisions/password-benchmark.md",
  "pnpm benchmark:password",
);
await requireText(
  "docs/release-readiness-audit.md",
  "cloudflare_auth_implementation_plan.md",
);
for (const text of [
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
  "npm package execution",
  "npx --package <pkg> <bin>",
  "Cookie prefixes",
  "__Host-",
  "__Secure-",
  "Password storage",
  "N=2^17, r=8, p=1",
]) {
  await requireText("docs/platform-assumptions.md", text);
}
for (const text of [
  "## Completion Audit",
  "## Non-Negotiable Rules Audit",
  "Repositories never generate raw auth tokens",
  "## V1 Exclusion Audit",
  "role/permission framework",
  "peppering",
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
]) {
  await requireText("docs/release-readiness-audit.md", text);
}
await requireReleaseReadinessAuditCoverage();
await requireText("SECURITY.md", "secret scanning");
await requireText("SECURITY.md", "push protection");
await requireText("SECURITY.md", "advisory evidence only");
await requireText(
  ".github/workflows/dependency-review.yml",
  "actions/dependency-review-action",
);
await requireText(".github/workflows/codeql.yml", "javascript-typescript");
await requireText(".github/dependabot.yml", "package-ecosystem: npm");
await requireText(
  ".github/dependabot.yml",
  "package-ecosystem: github-actions",
);
await requireText("README.md", "docs/known-limitations.md");
await requireText(
  ".github/ISSUE_TEMPLATE/alpha-feedback.yml",
  "doctor --report",
);
await requireText(
  "docs/alpha.md",
  "CF_AUTH_REQUIRE_ALPHA_EVIDENCE=1 pnpm verify:alpha-evidence",
);
await requireText(
  "docs/alpha.md",
  "CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership",
);
await requireText("docs/alpha.md", "pnpm check:package-names");
await requireText(
  "docs/decisions/package-naming.md",
  "CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership",
);
await requireText("docs/alpha.md", "doctor --report");
await requireText("docs/alpha-evidence.example.json", '"commands"');
await requireText("docs/alpha-evidence.example.json", "cf-auth init");
await requireText(
  "docs/alpha-evidence.example.json",
  "cf-auth migrate --local",
);
await requireText("docs/alpha-evidence.example.json", "pnpm install");
await requireText("docs/alpha-evidence.example.json", "npm run dev");
await requireText(
  "docs/alpha-evidence.example.json",
  '"doctorReportSchemaValid"',
);
await requireText(
  "docs/alpha-evidence.example.json",
  '"doctorReportRedactionChecked"',
);
await requireText(
  "docs/deploy-to-cloudflare.md",
  "Deploy to Cloudflare button is a public-beta gate",
);
await requireText(
  "docs/deploy-to-cloudflare.md",
  "CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE=1 pnpm verify:deploy-button-evidence",
);
await requireText(
  "docs/deploy-to-cloudflare.md",
  "Cloudflare Email Service binding is configured for `AUTH_EMAIL`",
);
await requireText(
  "docs/public-beta.md",
  "CF_AUTH_REQUIRE_BETA_EVIDENCE=1 pnpm verify:beta-evidence",
);
await requireText("docs/public-beta.md", "docs/known-limitations.md");
await requireText("docs/public-beta.md", "pnpm verify:beta-evidence");
await requireText("docs/public-beta.md", "pnpm verify:deploy-button-evidence");
await requireText("docs/public-beta.md", "pnpm verify:package-ownership");
await requireText("docs/public-beta.md", "pnpm check:package-names");
await requireText("docs/beta-evidence.example.json", '"cleanDirectory"');
await requireText(
  "docs/beta-evidence.example.json",
  '"documentedCommandsOnly"',
);
await requireText(
  "docs/beta-evidence.example.json",
  '"optInCloudflareAccountFixture"',
);
await requireText("docs/beta-evidence.example.json", '"commands"');
await requireText("docs/beta-evidence.example.json", "cf-auth init");
await requireText("docs/beta-evidence.example.json", "cf-auth migrate --local");
await requireText("docs/beta-evidence.example.json", "pnpm install");
await requireText("docs/beta-evidence.example.json", "npm run dev");
await requireText("docs/release-checklist.md", "pnpm verify:security-docs");
await requireText(
  "docs/public-beta.md",
  ".github/workflows/published-quickstart-smoke.yml",
);
await requireText(
  "docs/public-beta.md",
  ".github/workflows/cloudflare-production-smoke.yml",
);
const authSmokeEndpoints = await releaseAuthSmokeEndpoints();
for (const endpoint of authSmokeEndpoints) {
  await requireText("docs/beta-evidence.example.json", endpoint);
  await requireText("docs/deploy-button-evidence.example.json", endpoint);
}
await requireText(
  "docs/deploy-button-evidence.example.json",
  '"starterTemplateCreated"',
);
await requireText(
  "docs/deploy-button-evidence.example.json",
  '"documentedPathFollowed"',
);
await requireText(
  "docs/deploy-button-evidence.example.json",
  '"emailBindingConfigured"',
);
await requireText("docs/deploy-button-evidence.example.json", '"packageTag"');
await requireText(
  ".github/workflows/wrangler-dev-smoke.yml",
  "pnpm smoke:wrangler-dev",
);
await requireText(
  "scripts/smoke-production-cloudflare.mjs",
  "__Host-cfauth-session=",
);
await requireText(
  "scripts/smoke-production-cloudflare.mjs",
  "assertHostOnlySessionCookie",
);
for (const cookieAttribute of ["Secure", "HttpOnly", "Path=/", "Domain="]) {
  await requireText("scripts/smoke-production-cloudflare.mjs", cookieAttribute);
}
await requireText(
  "scripts/smoke-production-cloudflare.mjs",
  'assertNoWorkspaceDependencies(pkg, "production smoke package.json")',
);
await requireText(
  "scripts/smoke-production-cloudflare.mjs",
  '"@cf-auth/email-cloudflare": packageTag',
);
await requireText(
  "scripts/smoke-production-cloudflare.mjs",
  "CF_AUTH_ALLOW_LOCAL_PACKAGE_SPECS",
);
await requireText(".github/workflows/release.yml", "package_names_confirmed");
await requireText(
  ".github/workflows/release.yml",
  "pnpm install --frozen-lockfile",
);
await requireText(".github/workflows/release.yml", "pnpm package:check");
await requireText(".github/workflows/release.yml", "pnpm release:gates");
await requireText(".github/workflows/release.yml", "pnpm publish:dry-run");
await requireText(".github/workflows/release.yml", "pnpm-publish-summary.json");
await requireText(
  ".github/workflows/release.yml",
  "pnpm changeset publish --provenance",
);
await requireText(
  "docs/release-checklist.md",
  "opt-in Wrangler dev smoke workflow",
);

requireVerifier("scripts/verify-deploy-template.mjs");
requireVerifier("scripts/verify-docs-coverage.mjs");
requireVerifier("scripts/verify-examples.mjs");
requireVerifier("scripts/verify-migrations.mjs");
requireVerifier("scripts/verify-security-docs.mjs");

const stablePackages = packages.filter((pkg) =>
  isStableOneOrLater(pkg.version),
);
const betaPackages = packages.filter((pkg) => isPublicBeta(pkg.version));
const unsupportedReleasePackages = packages.filter(
  (pkg) =>
    isPublishedReleaseVersion(pkg.version) &&
    !isPrivateAlpha(pkg.version) &&
    !isPublicBeta(pkg.version) &&
    !isStableOneOrLater(pkg.version),
);
const betaOrStablePackages = packages.filter(
  (pkg) => isPublicBeta(pkg.version) || isStableOneOrLater(pkg.version),
);
const publishedReleasePackages = packages.filter((pkg) =>
  isPublishedReleaseVersion(pkg.version),
);
for (const pkg of unsupportedReleasePackages) {
  failures.push(
    `${pkg.name}@${pkg.version}: release versions must use alpha, beta, or stable 1.0+ channels from the implementation plan`,
  );
}
if (publishedReleasePackages.length > 0) {
  await requireFile("docs/package-ownership.json");
  await requireText("docs/package-ownership.json", '"ownershipConfirmed"');
  requireVerifier("scripts/verify-package-ownership.mjs", {
    CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP: "1",
  });
  requireVerifier("scripts/check-package-names.mjs");
  await requirePackageChangelogs(publishedReleasePackages);
}
if (betaOrStablePackages.length > 0) {
  await requireFile("docs/alpha-evidence.json");
  await requireText("docs/alpha-evidence.json", '"localSetups"');
  await requireText("docs/alpha-evidence.json", '"productionDeploys"');
  requireVerifier("scripts/verify-alpha-evidence.mjs", {
    CF_AUTH_REQUIRE_ALPHA_EVIDENCE: "1",
  });
}
if (betaOrStablePackages.length > 0) {
  await requireFile("docs/deploy-button-evidence.json");
  await requireText("docs/deploy-button-evidence.json", '"status": "verified"');
  await requireText(
    "docs/deploy-button-evidence.json",
    '"templateRepositoryUrl"',
  );
  await requireText("docs/deploy-button-evidence.json", '"deployButtonUrl"');
  await requireText("docs/deploy-button-evidence.json", '"packageTag"');
  requireVerifier("scripts/verify-deploy-button-evidence.mjs", {
    CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE: "1",
  });
}
if (stablePackages.length > 0) {
  await requireFile("docs/beta-evidence.json");
  await requireText("docs/beta-evidence.json", '"publishedQuickstart"');
  await requireText("docs/beta-evidence.json", '"productionSmoke"');
  requireVerifier("scripts/verify-beta-evidence.mjs", {
    CF_AUTH_REQUIRE_BETA_EVIDENCE: "1",
  });
  await requireReleaseApproval("docs/api-report.md", "Public API report");
  await requireReleaseApproval("docs/config-schema.md", "Config schema");
  await requireSecurityReviewDecision();
  await requireFile("docs/security-release-tracker.json");
  await requireText(
    "docs/security-release-tracker.json",
    '"openHighCriticalAuthSecurityIssues"',
  );
  await requireText("docs/security-release-tracker.json", '"issueSearchUrl"');
  await requireText(
    "docs/security-release-tracker.json",
    '"advisorySearchUrl"',
  );
  requireVerifier("scripts/verify-security-release-tracker.mjs", {
    CF_AUTH_REQUIRE_SECURITY_TRACKER: "1",
  });
  await requireFile("tests/upgrade.test.ts");
  await requireFile("tests/fixtures/upgrade/beta-schema-versions.json");
  await requireUpgradeFixtures();
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

const stableMessage =
  stablePackages.length > 0
    ? `stable gates checked for ${stablePackages
        .map((pkg) => `${pkg.name}@${pkg.version}`)
        .join(", ")}`
    : "stable 1.0 gates not required for current package versions";
console.log(`release gates passed: ${stableMessage}`);

async function requireFile(path) {
  try {
    await access(path);
  } catch {
    failures.push(`${path}: required release gate file is missing`);
  }
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    failures.push(`${path}: could not be read as JSON`);
    return undefined;
  }
}

async function readJsonObject(path) {
  const value = await readJsonFile(path);
  if (value === undefined) return null;
  if (!isRecord(value)) {
    failures.push(`${path}: top-level JSON value must be an object`);
    return null;
  }
  return value;
}

async function requireText(path, needle) {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    failures.push(`${path}: could not be read`);
    return "";
  }
  if (!text.includes(needle)) {
    failures.push(`${path}: missing required release gate text: ${needle}`);
  }
  return text;
}

async function requireReleaseReadinessAuditCoverage() {
  let audit = "";
  try {
    audit = await readFile("docs/release-readiness-audit.md", "utf8");
  } catch {
    failures.push("docs/release-readiness-audit.md: could not be read");
    return;
  }
  for (let stage = 0; stage <= 12; stage += 1) {
    if (!audit.includes(`Stage ${stage}`)) {
      failures.push(`docs/release-readiness-audit.md: missing Stage ${stage}`);
    }
  }
  for (let rule = 1; rule <= 28; rule += 1) {
    if (!new RegExp(`\\|\\s*${rule}\\s*\\|`, "u").test(audit)) {
      failures.push(`docs/release-readiness-audit.md: missing Rule ${rule}`);
    }
  }
}

async function requireReleaseApproval(path, label) {
  const text = await requireText(path, "Release approval:");
  const match = text.match(
    /^Release approval:\s*release-approved\s+by\s+(.+?)\s+on\s+(\S+)\s*$/im,
  );
  if (!match) {
    failures.push(`${path}: ${label} must be release-approved before 1.0`);
    failures.push(
      `${path}: ${label} release approval must include non-placeholder approver and ISO date`,
    );
    return;
  }
  const approver = match[1]?.trim() ?? "";
  const approvalDate = match[2]?.trim() ?? "";
  if (isPlaceholderEvidenceIdentity(approver)) {
    failures.push(
      `${path}: ${label} release approver must not be a placeholder`,
    );
  }
  if (!isIsoDateOnly(approvalDate)) {
    failures.push(
      `${path}: ${label} release approval date must be a valid ISO date`,
    );
  } else if (isFutureIsoDateOnly(approvalDate)) {
    failures.push(
      `${path}: ${label} release approval date must not be in the future`,
    );
  }
}

function requireVerifier(script, env) {
  const result = spawnSync(process.execPath, [join(repoRoot, script)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    failures.push(
      `${script}: verifier failed\n${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function releaseChecklistScripts(scripts) {
  const required = new Set([
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
  ]);
  const scriptsToCheck = Object.keys(scripts).filter(
    (script) =>
      required.has(script) ||
      script.startsWith("verify:") ||
      script.startsWith("smoke:"),
  );
  for (const script of required) {
    if (!(script in scripts))
      failures.push(`package.json: missing release checklist script ${script}`);
  }
  return scriptsToCheck.sort();
}

async function releaseAuthSmokeEndpoints() {
  try {
    return await requiredAuthSmokeEndpoints(
      process.env.CF_AUTH_SMOKE_ENDPOINTS_SOURCE || undefined,
    );
  } catch (error) {
    failures.push(
      `scripts/smoke-production-cloudflare.mjs: could not derive auth smoke endpoints: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requireSecurityReviewDecision() {
  const decisionPath = "docs/decisions/security-review.md";
  const text = await requireText(decisionPath, "Status:");
  const status = text
    .match(/^Status:\s*(external-review-completed|maintainer-signoff)\b/im)?.[1]
    ?.toLowerCase();
  if (!status) {
    failures.push(
      `${decisionPath}: security review decision must be completed before 1.0`,
    );
    return;
  }
  const decisionDate = releaseFieldValue(text, "Date");
  if (!decisionDate || !isIsoDateOnly(decisionDate)) {
    failures.push(
      `${decisionPath}: security review decision must include a valid ISO date`,
    );
  } else if (isFutureIsoDateOnly(decisionDate)) {
    failures.push(
      `${decisionPath}: security review decision date must not be in the future`,
    );
  }
  if (status === "external-review-completed") {
    const reviewer = requireReleaseField(
      text,
      decisionPath,
      "external review decision",
      "Reviewer",
    );
    for (const field of ["Scope", "Unresolved findings"]) {
      requireReleaseField(
        text,
        decisionPath,
        "external review decision",
        field,
      );
    }
    if (reviewer && isPlaceholderEvidenceIdentity(reviewer)) {
      failures.push(
        `${decisionPath}: external review reviewer must not be a placeholder`,
      );
    }
  } else {
    const signer = requireReleaseField(
      text,
      decisionPath,
      "maintainer sign-off",
      "Signed by",
    );
    if (signer && isPlaceholderEvidenceIdentity(signer)) {
      failures.push(
        `${decisionPath}: maintainer sign-off signer must not be a placeholder`,
      );
    }
    for (const field of ["Rationale", "Compensating controls"]) {
      requireReleaseField(text, decisionPath, "maintainer sign-off", field);
    }
  }
}

function requireReleaseField(text, path, context, field) {
  const value = releaseFieldValue(text, field);
  if (!value) {
    failures.push(`${path}: ${context} must include ${field}:`);
  }
  return value;
}

function releaseFieldValue(text, field) {
  return text.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, "im"))?.[1]?.trim();
}

function isIsoDateOnly(value) {
  return parseIsoDateOnly(value) !== null;
}

function isFutureIsoDateOnly(value, nowMs = Date.now()) {
  const date = parseIsoDateOnly(value);
  if (!date) return false;
  const now = new Date(nowMs);
  const today = new Date(Date.UTC(0, now.getUTCMonth(), now.getUTCDate()));
  today.setUTCFullYear(now.getUTCFullYear());
  return date.getTime() > today.getTime();
}

function parseIsoDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(0, month - 1, day));
  date.setUTCFullYear(year);
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

async function requireUpgradeFixtures() {
  const text = await requireText(
    "tests/fixtures/upgrade/beta-schema-versions.json",
    '"betaVersions"',
  );
  if (!text) return;
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    failures.push(
      "tests/fixtures/upgrade/beta-schema-versions.json: must be valid JSON",
    );
    return;
  }
  if (!isRecord(manifest)) {
    failures.push(
      "tests/fixtures/upgrade/beta-schema-versions.json: top-level JSON value must be an object",
    );
    return;
  }
  const betaVersions = Array.isArray(manifest.betaVersions)
    ? manifest.betaVersions
    : [];
  if (betaVersions.length === 0) {
    failures.push(
      "tests/fixtures/upgrade/beta-schema-versions.json: stable 1.0 release requires beta schema upgrade fixtures",
    );
  }
  for (const [index, beta] of betaVersions.entries()) {
    const path = `tests/fixtures/upgrade/beta-schema-versions.json: betaVersions[${index}]`;
    if (!beta || typeof beta !== "object" || Array.isArray(beta)) {
      failures.push(`${path} must be an object`);
      continue;
    }
    if (
      typeof beta.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(beta.version)
    ) {
      failures.push(`${path}.version must be a package version string`);
    }
    if (!Number.isSafeInteger(beta.schemaVersion) || beta.schemaVersion <= 0) {
      failures.push(`${path}.schemaVersion must be a positive integer`);
    }
    if (
      typeof beta.fixture !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(beta.fixture) ||
      beta.fixture.includes("..")
    ) {
      failures.push(`${path}.fixture must be a safe fixture directory name`);
      continue;
    }
    await requireFile(
      join("tests", "fixtures", "upgrade", beta.fixture, "schema.sql"),
    );
    await requireFile(
      join("tests", "fixtures", "upgrade", beta.fixture, "expected.json"),
    );
  }
}

async function requirePackageChangelogs(releasePackages) {
  for (const pkg of releasePackages) {
    const changelog = join(pkg.dir, "CHANGELOG.md");
    await requireFile(changelog);
    await requireText(changelog, pkg.version);
  }
}

function isStableOneOrLater(version) {
  if (typeof version !== "string") return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/);
  if (!match) return false;
  if (version.includes("-")) return false;
  return Number(match[1]) >= 1;
}

function isPublicBeta(version) {
  if (typeof version !== "string") return false;
  return /^\d+\.\d+\.\d+-beta(?:[.-].*)?$/u.test(version);
}

function isPrivateAlpha(version) {
  if (typeof version !== "string") return false;
  return /^\d+\.\d+\.\d+-alpha(?:[.-].*)?$/u.test(version);
}

function isPublishedReleaseVersion(version) {
  if (typeof version !== "string") return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/u);
  if (!match) return false;
  return (
    Number(match[1]) !== 0 || Number(match[2]) !== 0 || Number(match[3]) !== 0
  );
}
