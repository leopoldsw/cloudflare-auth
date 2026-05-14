import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const packageDirs = (await readdir("packages", { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("packages", entry.name))
  .sort();

const packages = [];
for (const dir of packageDirs) {
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  if (!pkg.private)
    packages.push({ dir, name: pkg.name, version: pkg.version });
}

const failures = [];
await requireFile(".github/dependabot.yml");
await requireFile(".github/workflows/ci.yml");
await requireFile(".github/workflows/codeql.yml");
await requireFile(".github/workflows/cloudflare-production-smoke.yml");
await requireFile(".github/workflows/dependency-review.yml");
await requireFile(".github/workflows/examples.yml");
await requireFile(".github/workflows/published-quickstart-smoke.yml");
await requireFile(".github/workflows/wrangler-dev-smoke.yml");
await requireFile(".github/ISSUE_TEMPLATE/alpha-feedback.yml");
await requireFile(".github/ISSUE_TEMPLATE/bug.yml");
await requireFile(".github/ISSUE_TEMPLATE/feature-request.yml");
await requireFile(".github/ISSUE_TEMPLATE/security-contact.md");
await requireFile("docs/alpha-evidence.example.json");
await requireFile("docs/alpha.md");
await requireFile("docs/beta-evidence.example.json");
await requireFile("docs/deploy-button-evidence.example.json");
await requireFile("docs/deploy-to-cloudflare.md");
await requireFile("docs/known-limitations.md");
await requireFile("docs/package-ownership.example.json");
await requireFile("docs/public-beta.md");
await requireFile("docs/security-release-tracker.example.json");
await requireFile("schemas/doctor-report.schema.json");
await requireFile("scripts/export-deploy-template.mjs");
await requireFile("scripts/check-package-names.ts");
await requireFile("scripts/verify-alpha-evidence.mjs");
await requireFile("scripts/verify-beta-evidence.mjs");
await requireFile("scripts/verify-deploy-button-evidence.mjs");
await requireFile("scripts/verify-deploy-template.mjs");
await requireFile("scripts/verify-docs-coverage.mjs");
await requireFile("scripts/verify-package-ownership.mjs");
await requireFile("scripts/verify-security-docs.mjs");
await requireFile("scripts/verify-security-release-tracker.mjs");
await requireText("README.md", "SECURITY.md");
await requireText("SECURITY.md", "Expected Response Window");
await requireText("docs/release-checklist.md", "unresolved high/critical");
await requireText("docs/release-checklist.md", "public API report reviewed");
await requireText("docs/release-checklist.md", "config schema reviewed");
await requireText("docs/release-checklist.md", "security review decision");
await requireText("SECURITY.md", "secret scanning");
await requireText("SECURITY.md", "advisory evidence only");
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
  "docs/decisions/package-naming.md",
  "CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership",
);
await requireText("docs/alpha.md", "doctor --report");
await requireText(
  "docs/deploy-to-cloudflare.md",
  "Deploy to Cloudflare button is a public-beta gate",
);
await requireText(
  "docs/deploy-to-cloudflare.md",
  "CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE=1 pnpm verify:deploy-button-evidence",
);
await requireText(
  "docs/public-beta.md",
  "CF_AUTH_REQUIRE_BETA_EVIDENCE=1 pnpm verify:beta-evidence",
);
await requireText("docs/public-beta.md", "docs/known-limitations.md");
await requireText("docs/public-beta.md", "pnpm verify:beta-evidence");
await requireText("docs/public-beta.md", "pnpm verify:deploy-button-evidence");
await requireText("docs/public-beta.md", "pnpm verify:package-ownership");
await requireText("docs/release-checklist.md", "pnpm verify:security-docs");
await requireText(
  "docs/public-beta.md",
  ".github/workflows/published-quickstart-smoke.yml",
);
await requireText(
  "docs/public-beta.md",
  ".github/workflows/cloudflare-production-smoke.yml",
);
await requireText(
  ".github/workflows/wrangler-dev-smoke.yml",
  "pnpm smoke:wrangler-dev",
);
await requireText(
  "docs/release-checklist.md",
  "opt-in Wrangler dev smoke workflow passes",
);

const stablePackages = packages.filter((pkg) =>
  isStableOneOrLater(pkg.version),
);
const betaPackages = packages.filter((pkg) => isPublicBeta(pkg.version));
const publishedReleasePackages = packages.filter((pkg) =>
  isPublishedReleaseVersion(pkg.version),
);
if (publishedReleasePackages.length > 0) {
  await requireFile("docs/package-ownership.json");
  await requireText("docs/package-ownership.json", '"ownershipConfirmed"');
  await requirePackageChangelogs(publishedReleasePackages);
}
if (betaPackages.length > 0) {
  await requireFile("docs/alpha-evidence.json");
  await requireText("docs/alpha-evidence.json", '"localSetups"');
  await requireText("docs/alpha-evidence.json", '"productionDeploys"');
}
if (stablePackages.length > 0) {
  await requireFile("docs/beta-evidence.json");
  await requireText("docs/beta-evidence.json", '"publishedQuickstart"');
  await requireText("docs/beta-evidence.json", '"productionSmoke"');
  await requireReleaseApproval("docs/api-report.md", "Public API report");
  await requireReleaseApproval("docs/config-schema.md", "Config schema");
  await requireSecurityReviewDecision();
  await requireFile("docs/security-release-tracker.json");
  await requireText(
    "docs/security-release-tracker.json",
    '"openHighCriticalAuthSecurityIssues"',
  );
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

async function requireReleaseApproval(path, label) {
  const text = await requireText(path, "Release approval:");
  if (!/^Release approval:\s*release-approved\b/im.test(text)) {
    failures.push(`${path}: ${label} must be release-approved before 1.0`);
  }
}

async function requireSecurityReviewDecision() {
  const text = await requireText(
    "docs/decisions/security-review.md",
    "Status:",
  );
  if (
    !/^Status:\s*(external-review-completed|maintainer-signoff)\b/im.test(text)
  ) {
    failures.push(
      "docs/decisions/security-review.md: security review decision must be completed before 1.0",
    );
  }
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
  const betaVersions = Array.isArray(manifest.betaVersions)
    ? manifest.betaVersions
    : [];
  if (betaVersions.length === 0) {
    failures.push(
      "tests/fixtures/upgrade/beta-schema-versions.json: stable 1.0 release requires beta schema upgrade fixtures",
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

function isPublishedReleaseVersion(version) {
  if (typeof version !== "string") return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/u);
  if (!match) return false;
  return (
    Number(match[1]) !== 0 || Number(match[2]) !== 0 || Number(match[3]) !== 0
  );
}
