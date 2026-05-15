import { spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { isJsonObject } from "./evidence-validation.mjs";

const failures = [];
const rootPackage = (await readJsonObject("package.json")) ?? {};
const rootLicense = await readFile("LICENSE", "utf8");
const expectedPackages = new Map([
  [
    "cf-auth-shim",
    {
      name: "cf-auth",
      bin: "cf-auth",
      privateUntilOwnershipConfirmed: true,
    },
  ],
  ["cli", { name: "@cf-auth/cli", bin: "cf-auth" }],
  ["client", { name: "@cf-auth/client" }],
  ["core", { name: "@cf-auth/core" }],
  [
    "create-cloudflare-auth",
    {
      name: "create-cloudflare-auth",
      bin: "create-cloudflare-auth",
      privateUntilOwnershipConfirmed: true,
    },
  ],
  ["email-cloudflare", { name: "@cf-auth/email-cloudflare" }],
  ["hono", { name: "@cf-auth/hono" }],
  ["testing", { name: "@cf-auth/testing" }],
  ["worker", { name: "@cf-auth/worker" }],
]);
const v1Exclusions = [
  "OAuth/social login",
  "SAML/enterprise SSO",
  "passkeys",
  "MFA",
  "organizations/teams",
  "role/permission framework",
  "hosted dashboard",
  "hosted auth service",
  "billing integration",
  "admin impersonation",
  "multi-project control plane",
  "password peppering",
];
const packageDirs = (await readdir("packages", { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("packages", entry.name))
  .sort();
const packDir = await mkdtemp(join(tmpdir(), "cf-auth-package-check-"));

const publishablePackageNames = [];
let ownershipEvidence;
for (const expectedDir of expectedPackages.keys()) {
  if (!packageDirs.includes(join("packages", expectedDir))) {
    failures.push(
      `packages/${expectedDir}: expected package directory missing`,
    );
  }
}

for (const dir of packageDirs) {
  const expected = expectedPackages.get(basename(dir));
  const pkg = await readJsonObject(join(dir, "package.json"));
  if (!pkg) continue;
  if (!pkg.name) failures.push(`${dir}: missing name`);
  if (!expected) {
    failures.push(`${dir}: unexpected package directory`);
  } else if (pkg.name !== expected.name) {
    failures.push(`${dir}: package name must be ${expected.name}`);
  }
  if (!pkg.license) failures.push(`${pkg.name}: missing license`);
  try {
    const packageLicense = await readFile(join(dir, "LICENSE"), "utf8");
    if (packageLicense !== rootLicense) {
      failures.push(`${pkg.name}: LICENSE must match root LICENSE`);
    }
  } catch {
    failures.push(`${pkg.name}: LICENSE file missing`);
  }
  if (!pkg.exports?.["."])
    failures.push(`${pkg.name}: missing root export map`);
  if (!pkg.types) failures.push(`${pkg.name}: missing types field`);
  if (!pkg.files?.includes("dist"))
    failures.push(`${pkg.name}: package files must include dist`);
  if (pkg.private !== true) {
    publishablePackageNames.push(pkg.name);
  }
  if (expected?.privateUntilOwnershipConfirmed) {
    if (pkg.private !== true) {
      await requireOwnershipEvidenceForUnreservedPackage(pkg);
    }
  } else if (pkg.private) {
    failures.push(`${pkg.name}: publishable packages must not be private`);
  }
  if (pkg.engines?.node !== ">=22.12.0")
    failures.push(`${pkg.name}: node engine mismatch`);
  if (expected?.bin && !pkg.bin?.[expected.bin]) {
    failures.push(`${pkg.name}: missing ${expected.bin} bin`);
  }
  for (const file of pkg.files ?? []) {
    try {
      await access(join(dir, file));
    } catch {
      failures.push(`${pkg.name}: files entry ${file} does not exist`);
    }
  }
  if (pkg.bin) {
    for (const [name, target] of Object.entries(pkg.bin)) {
      if (!String(target).startsWith("./dist/"))
        failures.push(`${pkg.name}: bin ${name} must point into dist`);
      if (pkg.exports?.["."]?.import === target) {
        failures.push(
          `${pkg.name}: bin ${name} must use a dedicated bin entrypoint, not the root export`,
        );
      }
      try {
        const bin = await readFile(join(dir, String(target)), "utf8");
        if (!bin.startsWith("#!/usr/bin/env node")) {
          failures.push(`${pkg.name}: bin ${name} is missing node shebang`);
        }
      } catch {
        failures.push(`${pkg.name}: bin ${name} target ${target} missing`);
      }
    }
  }
  const pack = packArtifact(dir, pkg.name);
  if (pack) {
    const packedPaths = new Set(pack.files.map((file) => file.path));
    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      packagePath(pkg.types),
      packagePath(pkg.main),
      packagePath(pkg.module),
      packagePath(pkg.exports?.["."]?.types),
      packagePath(pkg.exports?.["."]?.import),
      packagePath(pkg.exports?.["."]?.require),
      ...Object.values(pkg.bin ?? {}).map((target) => packagePath(target)),
    ].filter(Boolean)) {
      if (!packedPaths.has(required)) {
        failures.push(`${pkg.name}: packed artifact missing ${required}`);
      }
    }
    const packedManifest = readPackedPackageJson(pack.filename, pkg.name);
    if (packedManifest) {
      verifyPackedManifest(pkg, packedManifest);
    }
  }
}

await verifyPackageNamingDocs();
await verifyReadmeAndNonGoals();
await verifyDocsManifest();
await verifyReleaseReadinessAudit();
await verifyPlatformAssumptionsDocs();
await verifyBenchmarkDocs();
await verifyToolchainDocs();
await verifyTroubleshootingDocs();
await verifyRootScripts();
await verifyCiControls();
await verifyReleaseControls();

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

function packArtifact(dir, name) {
  const result = spawnSync(
    "pnpm",
    ["--dir", dir, "pack", "--pack-destination", packDir, "--json"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    failures.push(`${name}: pnpm pack failed`);
    if (result.stderr.trim()) failures.push(result.stderr.trim());
    return null;
  }
  try {
    const pack = JSON.parse(result.stdout);
    if (!isJsonObject(pack)) {
      failures.push(`${name}: pnpm pack JSON output must be an object`);
      return null;
    }
    if (pack.name !== name) {
      failures.push(`${name}: packed artifact name was ${pack.name}`);
    }
    if (typeof pack.filename !== "string" || pack.filename.length === 0) {
      failures.push(`${name}: pnpm pack did not report a tarball filename`);
    }
    if (!Array.isArray(pack.files)) {
      failures.push(`${name}: pnpm pack JSON output must include files array`);
      return null;
    }
    return pack;
  } catch {
    failures.push(`${name}: pnpm pack did not emit JSON`);
    return null;
  }
}

function readPackedPackageJson(filename, name) {
  if (!filename) return null;
  const result = spawnSync("tar", ["-xOf", filename, "package/package.json"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failures.push(`${name}: packed package.json could not be read`);
    if (result.stderr.trim()) failures.push(result.stderr.trim());
    return null;
  }
  try {
    const manifest = JSON.parse(result.stdout);
    if (!isJsonObject(manifest)) {
      failures.push(
        `${name}: packed package.json top-level JSON value must be an object`,
      );
      return null;
    }
    return manifest;
  } catch {
    failures.push(`${name}: packed package.json must be valid JSON`);
    return null;
  }
}

function verifyPackedManifest(sourcePackage, packedPackage) {
  if (packedPackage.name !== sourcePackage.name) {
    failures.push(
      `${sourcePackage.name}: packed package.json name was ${String(
        packedPackage.name,
      )}`,
    );
  }
  if (packedPackage.version !== sourcePackage.version) {
    failures.push(
      `${sourcePackage.name}: packed package.json version was ${String(
        packedPackage.version,
      )}`,
    );
  }
  const packedText = JSON.stringify(packedPackage);
  if (packedText.includes("workspace:")) {
    failures.push(
      `${sourcePackage.name}: packed package.json must not contain workspace: dependency ranges`,
    );
  }
}

function packagePath(value) {
  if (!value) return "";
  return String(value).replace(/^\.\//, "");
}

async function requireOwnershipEvidenceForUnreservedPackage(pkg) {
  const evidence = await readOwnershipEvidence();
  const item = evidence.packagesByName.get(pkg.name);
  if (!item) {
    failures.push(
      `${pkg.name}: docs/package-ownership.json must include ownership evidence before removing private: true`,
    );
    return;
  }
  if (evidence.reservedByName.has(pkg.name)) {
    failures.push(
      `${pkg.name}: docs/package-ownership.json must move this package from reservedPackages to packages before publishing`,
    );
  }
  if (item.registry !== "https://registry.npmjs.org/") {
    failures.push(
      `${pkg.name}: docs/package-ownership.json registry must be https://registry.npmjs.org/`,
    );
  }
  if (item.version !== pkg.version) {
    failures.push(
      `${pkg.name}: docs/package-ownership.json version must match ${pkg.version}`,
    );
  }
  for (const field of [
    "ownershipConfirmed",
    "publisherTwoFactorEnabled",
    "provenancePublish",
  ]) {
    if (item[field] !== true) {
      failures.push(
        `${pkg.name}: docs/package-ownership.json ${field} must be true before publishing`,
      );
    }
  }
}

async function readOwnershipEvidence() {
  if (ownershipEvidence) return ownershipEvidence;
  let parsed = {};
  try {
    parsed = JSON.parse(await readFile("docs/package-ownership.json", "utf8"));
  } catch {
    failures.push(
      "docs/package-ownership.json: required before publishing reserved packages",
    );
  }
  const packagesByName = new Map();
  const reservedByName = new Map();
  if (!isJsonObject(parsed)) {
    failures.push(
      "docs/package-ownership.json: top-level JSON value must be an object",
    );
    ownershipEvidence = { packagesByName, reservedByName };
    return ownershipEvidence;
  }
  if (!Array.isArray(parsed.packages)) {
    failures.push("docs/package-ownership.json: packages must be an array");
  }
  for (const [index, item] of (Array.isArray(parsed.packages)
    ? parsed.packages
    : []
  ).entries()) {
    if (!isJsonObject(item)) {
      failures.push(
        `docs/package-ownership.json: packages[${index}] must be an object`,
      );
      continue;
    }
    if (typeof item.name === "string") {
      if (packagesByName.has(item.name)) {
        failures.push(
          `docs/package-ownership.json: duplicate package evidence for ${item.name}`,
        );
      }
      packagesByName.set(item.name, item);
    }
  }
  if (!Array.isArray(parsed.reservedPackages)) {
    failures.push(
      "docs/package-ownership.json: reservedPackages must be an array",
    );
  }
  for (const [index, item] of (Array.isArray(parsed.reservedPackages)
    ? parsed.reservedPackages
    : []
  ).entries()) {
    if (!isJsonObject(item)) {
      failures.push(
        `docs/package-ownership.json: reservedPackages[${index}] must be an object`,
      );
      continue;
    }
    if (typeof item.name === "string") {
      if (reservedByName.has(item.name)) {
        failures.push(
          `docs/package-ownership.json: duplicate reserved package evidence for ${item.name}`,
        );
      }
      reservedByName.set(item.name, item);
    }
  }
  ownershipEvidence = { packagesByName, reservedByName };
  return ownershipEvidence;
}

async function verifyPackageNamingDocs() {
  const naming = await readFile("docs/decisions/package-naming.md", "utf8");
  const ownershipExample = await readFile(
    "docs/package-ownership.example.json",
    "utf8",
  );
  let ownershipExampleJson = {};
  try {
    ownershipExampleJson = JSON.parse(ownershipExample);
  } catch {
    failures.push("docs/package-ownership.example.json: must be valid JSON");
  }
  if (!isJsonObject(ownershipExampleJson)) {
    failures.push(
      "docs/package-ownership.example.json: top-level JSON value must be an object",
    );
    ownershipExampleJson = {};
  }
  for (const { name } of expectedPackages.values()) {
    if (!naming.includes(`\`${name}\``)) {
      failures.push(`docs/decisions/package-naming.md: missing ${name}`);
    }
  }
  if (!ownershipExample.includes('"registryVersion"')) {
    failures.push(
      "docs/package-ownership.example.json: missing registryVersion example for already-published package names",
    );
  }
  if (!ownershipExample.includes('"reservedPackages"')) {
    failures.push(
      "docs/package-ownership.example.json: missing reservedPackages for private unowned package shims",
    );
  }
  const ownershipExamplePackages = Array.isArray(ownershipExampleJson.packages)
    ? ownershipExampleJson.packages
    : [];
  if (ownershipExamplePackages.some((item) => item?.version === "0.0.0")) {
    failures.push(
      "docs/package-ownership.example.json: package examples must use non-placeholder target versions",
    );
  }
  for (const reservedName of ["cf-auth", "create-cloudflare-auth"]) {
    if (!ownershipExample.includes(`"name": "${reservedName}"`)) {
      failures.push(
        `docs/package-ownership.example.json: missing reserved package ${reservedName}`,
      );
    }
  }

  const fallback = "npx --package @cf-auth/cli@latest cf-auth init";
  for (const file of ["README.md", "docs/quickstart.md"]) {
    const text = await readFile(file, "utf8");
    if (!text.includes(fallback)) {
      failures.push(
        `${file}: public package commands must use scoped fallback`,
      );
    }
  }

  const docs = await listMarkdownFiles("docs");
  const packageReadmes = packageDirs.map((dir) => join(dir, "README.md"));
  const publicCommandFiles = ["README.md", ...docs, ...packageReadmes].filter(
    (file) => file !== "docs/decisions/package-naming.md",
  );
  for (const file of publicCommandFiles) {
    const text = await readFile(file, "utf8");
    if (/\bnpx\s+cf-auth(?:@[\w.-]+)?\b/.test(text)) {
      failures.push(
        `${file}: npx cf-auth commands are blocked until package ownership is confirmed`,
      );
    }
    if (/\bnpm\s+create\s+cloudflare-auth(?:@[\w.-]+)?\b/.test(text)) {
      failures.push(
        `${file}: npm create cloudflare-auth commands are blocked until package ownership is confirmed`,
      );
    }
  }

  const deployment = await readFile("docs/deployment.md", "utf8");
  for (const needle of [
    "`AUTH_PUBLIC_ORIGIN`: exact production origin",
    "`AUTH_SECRET`: generated with",
    "`TURNSTILE_SECRET_KEY`: stored as a Worker secret",
    "`AUTH_DB.database_id`: production D1 database ID",
    "`AUTH_EMAIL`: Cloudflare Email binding",
    "`CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID",
    "`CLOUDFLARE_API_TOKEN`: Cloudflare API token",
    "`CF_AUTH_PRODUCTION_SMOKE_DATABASE_ID`: D1 database ID",
    "`CF_AUTH_PRODUCTION_SMOKE_DATABASE_NAME`: D1 database name",
    "`CF_AUTH_PRODUCTION_SMOKE_WORKER_NAME`: Worker name",
    "`CF_AUTH_PRODUCTION_SMOKE_ORIGIN`: exact HTTPS origin",
  ]) {
    if (!deployment.includes(needle)) {
      failures.push(`docs/deployment.md: missing placeholder note ${needle}`);
    }
  }
}

async function verifyDocsManifest() {
  for (const file of [
    "docs/decisions/package-naming.md",
    "docs/decisions/password-benchmark.md",
    "docs/non-goals.md",
    "docs/quickstart.md",
    "docs/existing-hono-app.md",
    "docs/existing-worker-app.md",
    "docs/deployment.md",
    "docs/cloudflare-email.md",
    "docs/custom-email-adapter.md",
    "docs/local-development.md",
    "docs/configuration.md",
    "docs/api.md",
    "docs/security-model.md",
    "docs/sessions-and-cookies.md",
    "docs/rate-limiting.md",
    "docs/turnstile.md",
    "docs/migrations.md",
    "docs/troubleshooting.md",
    "docs/roadmap.md",
    "docs/metrics.md",
    "docs/cli.md",
    "docs/toolchain.md",
    "docs/alpha.md",
    "docs/public-beta.md",
    "docs/deploy-to-cloudflare.md",
    "docs/known-limitations.md",
    "docs/platform-assumptions.md",
    "docs/release-checklist.md",
    "docs/release-readiness-audit.md",
    "docs/upgrade-guide.md",
    "docs/api-report.md",
    "docs/config-schema.md",
    "docs/decisions/security-review.md",
    "docs/alpha-evidence.example.json",
    "docs/beta-evidence.example.json",
    "docs/deploy-button-evidence.example.json",
    "docs/package-ownership.example.json",
    "docs/security-release-tracker.example.json",
  ]) {
    try {
      await access(file);
    } catch {
      failures.push(`${file}: required documentation file is missing`);
    }
  }
}

async function verifyReleaseReadinessAudit() {
  let audit;
  try {
    audit = await readFile("docs/release-readiness-audit.md", "utf8");
  } catch {
    return;
  }
  for (const needle of [
    "cloudflare_auth_implementation_plan.md",
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
    if (!audit.includes(needle)) {
      failures.push(`docs/release-readiness-audit.md: missing ${needle}`);
    }
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

  const releaseChecklist = await readFile("docs/release-checklist.md", "utf8");
  if (!releaseChecklist.includes("release-readiness-audit.md")) {
    failures.push(
      "docs/release-checklist.md: missing release-readiness-audit.md",
    );
  }
}

async function verifyPlatformAssumptionsDocs() {
  let assumptions;
  try {
    assumptions = await readFile("docs/platform-assumptions.md", "utf8");
  } catch {
    return;
  }
  for (const needle of [
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
    if (!assumptions.includes(needle)) {
      failures.push(`docs/platform-assumptions.md: missing ${needle}`);
    }
  }

  const releaseChecklist = await readFile("docs/release-checklist.md", "utf8");
  if (!releaseChecklist.includes("docs/platform-assumptions.md")) {
    failures.push(
      "docs/release-checklist.md: missing docs/platform-assumptions.md",
    );
  }
}

async function verifyBenchmarkDocs() {
  const benchmark = await readFile(
    "docs/decisions/password-benchmark.md",
    "utf8",
  );
  for (const needle of [
    "workers-balanced",
    "workers-local",
    "warmupHashes",
    "measuredHashes",
    "p50Ms",
    "p95Ms",
    "throughputHashesPerSecond",
    "pnpm benchmark:password",
  ]) {
    if (!benchmark.includes(needle)) {
      failures.push(
        `docs/decisions/password-benchmark.md: missing benchmark evidence text ${needle}`,
      );
    }
  }
}

async function verifyTroubleshootingDocs() {
  const troubleshooting = await readFile("docs/troubleshooting.md", "utf8");
  for (const [problem, fix] of [
    ["Missing D1 binding", "AUTH_DB"],
    ["Missing D1 binding", "cf-auth init --repair"],
    ["Missing `AUTH_SECRET`", "cf-auth rotate-secret --apply --env production"],
    ["Migrations not applied", "cf-auth migrate --local"],
    ["Migrations not applied", "cf-auth migrate --remote --env production"],
    ["Cookie not set in production", "__Host-"],
    ["Cookie not set in production", "__Secure-"],
    ["Cross-subdomain cookie rejected", "session.domain"],
    ["Cloudflare Email binding missing", "AUTH_EMAIL"],
    ["Cloudflare Email binding missing", "custom email"],
  ]) {
    if (!troubleshooting.includes(problem) || !troubleshooting.includes(fix)) {
      failures.push(
        `docs/troubleshooting.md: missing exact fix for ${problem}: ${fix}`,
      );
    }
  }
}

async function verifyReadmeAndNonGoals() {
  const readme = await readFile("README.md", "utf8");
  const firstParagraph =
    readme
      .split(/\n\s*\n/u)
      .find((block) => !block.startsWith("#"))
      ?.trim() ?? "";
  const summaryWordCount = firstParagraph.split(/\s+/u).filter(Boolean).length;
  if (summaryWordCount === 0 || summaryWordCount > 150) {
    failures.push("README.md: project summary must be 150 words or fewer");
  }
  for (const needle of [
    "not affiliated with, endorsed by, or sponsored by Cloudflare",
    "npx --package @cf-auth/cli@latest cf-auth init",
    "pnpm install",
    "cf-auth migrate --local",
    "docs/non-goals.md",
  ]) {
    if (!readme.includes(needle)) {
      failures.push(`README.md: missing Stage 0 text ${needle}`);
    }
  }

  for (const file of [
    "README.md",
    "docs/non-goals.md",
    "docs/roadmap.md",
    "docs/known-limitations.md",
  ]) {
    const text = file === "README.md" ? readme : await readFile(file, "utf8");
    const normalizedText = text.replace(/\s+/gu, " ");
    for (const item of v1Exclusions) {
      if (!normalizedText.includes(item)) {
        failures.push(`${file}: missing v1 exclusion ${item}`);
      }
    }
  }
}

async function verifyReleaseControls() {
  const releaseWorkflow = await readFile(
    ".github/workflows/release.yml",
    "utf8",
  );
  for (const needle of [
    "id-token: write",
    "package_names_confirmed",
    "registry-url: https://registry.npmjs.org",
    "pnpm install --frozen-lockfile",
    "pnpm format:check",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm test:workers",
    "pnpm build",
    "pnpm package:check",
    "pnpm version-matrix:check",
    "pnpm audit --audit-level high",
    "continue-on-error: true",
    "pnpm verify:alpha-evidence",
    "pnpm verify:beta-evidence",
    "pnpm verify:deploy-button-evidence",
    "pnpm verify:deploy-template",
    "pnpm verify:docs-coverage",
    "pnpm verify:migrations",
    "pnpm verify:examples",
    "pnpm verify:package-ownership",
    "CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP",
    "pnpm check:package-names",
    "pnpm verify:security-docs",
    "pnpm verify:security-tracker",
    "pnpm release:gates",
    "pnpm smoke:tarballs",
    "CF_AUTH_TARBALL_INSTALL",
    "pnpm benchmark:password",
    "pnpm publish:dry-run",
    "actions/upload-artifact",
    "pnpm-publish-dry-run",
    "pnpm-publish-summary.json",
    "pnpm changeset publish --provenance",
    "NODE_AUTH_TOKEN",
    "secrets.NPM_TOKEN",
  ]) {
    if (!releaseWorkflow.includes(needle)) {
      failures.push(`.github/workflows/release.yml: missing ${needle}`);
    }
  }
  for (const script of releaseWorkflowScripts(rootPackage.scripts ?? {})) {
    const needle = `pnpm ${script}`;
    if (!releaseWorkflow.includes(needle)) {
      failures.push(`.github/workflows/release.yml: missing ${needle}`);
    }
  }
  requireOrderedText(".github/workflows/release.yml", releaseWorkflow, [
    "pnpm install --frozen-lockfile",
    "pnpm format:check",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm test:workers",
    "pnpm build",
    "pnpm package:check",
    "pnpm version-matrix:check",
    "pnpm audit --audit-level high",
    "pnpm verify:alpha-evidence",
    "pnpm verify:beta-evidence",
    "pnpm verify:deploy-button-evidence",
    "pnpm verify:deploy-template",
    "pnpm verify:docs-coverage",
    "pnpm verify:migrations",
    "pnpm verify:examples",
    "pnpm verify:package-ownership",
    "pnpm check:package-names",
    "pnpm verify:security-docs",
    "pnpm verify:security-tracker",
    "pnpm release:gates",
    "pnpm smoke:tarballs",
    "pnpm benchmark:password",
    "pnpm publish:dry-run",
    "pnpm changeset publish --provenance",
  ]);

  const productionSmokeWorkflow = await readFile(
    ".github/workflows/cloudflare-production-smoke.yml",
    "utf8",
  );
  for (const needle of [
    "workflow_dispatch:",
    "package_tag:",
    "pnpm smoke:cloudflare-production",
    'CF_AUTH_PRODUCTION_SMOKE: "1"',
    "CF_AUTH_PRODUCTION_SMOKE_PACKAGE_TAG",
    "CF_AUTH_PRODUCTION_SMOKE_WORKER_NAME",
    "CF_AUTH_PRODUCTION_SMOKE_DATABASE_NAME",
    "CF_AUTH_PRODUCTION_SMOKE_DATABASE_ID",
    "CF_AUTH_PRODUCTION_SMOKE_ORIGIN",
    "CLOUDFLARE_ACCOUNT_ID",
    "CLOUDFLARE_API_TOKEN",
  ]) {
    if (!productionSmokeWorkflow.includes(needle)) {
      failures.push(
        `.github/workflows/cloudflare-production-smoke.yml: missing ${needle}`,
      );
    }
  }

  const publishedQuickstartWorkflow = await readFile(
    ".github/workflows/published-quickstart-smoke.yml",
    "utf8",
  );
  for (const needle of [
    "workflow_dispatch:",
    "package_tag:",
    "required: true",
    "default: beta",
    "pnpm smoke:published-quickstart",
    "CF_AUTH_PUBLISHED_QUICKSTART_PACKAGE_TAG",
  ]) {
    if (!publishedQuickstartWorkflow.includes(needle)) {
      failures.push(
        `.github/workflows/published-quickstart-smoke.yml: missing ${needle}`,
      );
    }
  }

  let changesets;
  try {
    changesets = JSON.parse(await readFile(".changeset/config.json", "utf8"));
  } catch {
    failures.push(".changeset/config.json: must be valid JSON");
    changesets = {};
  }
  if (!isJsonObject(changesets)) {
    failures.push(
      ".changeset/config.json: top-level JSON value must be an object",
    );
    changesets = {};
  }
  if (changesets.changelog !== "@changesets/cli/changelog") {
    failures.push(
      ".changeset/config.json: changelog must use @changesets/cli/changelog",
    );
  }
  if (changesets.access !== "public") {
    failures.push(".changeset/config.json: access must be public");
  }
  const expectedPackageNames = [...publishablePackageNames].sort();
  const fixedGroups = Array.isArray(changesets.fixed) ? changesets.fixed : [];
  const hasExpectedFixedGroup = fixedGroups.some(
    (group) =>
      Array.isArray(group) &&
      group.length === expectedPackageNames.length &&
      [...group]
        .sort()
        .every((name, index) => name === expectedPackageNames[index]),
  );
  if (!hasExpectedFixedGroup) {
    failures.push(
      ".changeset/config.json: fixed group must include every publishable package",
    );
  }
  if (Array.isArray(changesets.linked) && changesets.linked.length > 0) {
    failures.push(
      ".changeset/config.json: linked groups must be empty when all packages are fixed together",
    );
  }

  for (const [file, needles] of [
    [
      "docs/decisions/package-naming.md",
      [
        "npm publisher 2FA",
        "npm provenance",
        "private alpha: `x.y.z-alpha.N`",
        "public beta: `x.y.z-beta.N`",
        "stable: `1.0.0` or later",
        "Do not publish other prerelease shapes",
      ],
    ],
    [
      "docs/release-checklist.md",
      [
        "npm publisher 2FA",
        "package ownership verified",
        "verify:package-ownership",
        "check:package-names",
        "not as the sole security gate",
        "secret scanning",
        "push protection",
        "Changesets version/changelog",
        "Changesets fixed package group",
        "dry-run publish summary artifact",
        "supported release channel",
        "CF_AUTH_REQUIRE_ALPHA_EVIDENCE=1 pnpm verify:alpha-evidence",
        "CF_AUTH_REQUIRE_BETA_EVIDENCE=1 pnpm verify:beta-evidence",
        "CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE=1 pnpm verify:deploy-button-evidence",
        "CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP=1 pnpm verify:package-ownership",
        "CF_AUTH_REQUIRE_SECURITY_TRACKER=1 pnpm verify:security-tracker",
      ],
    ],
    [
      "docs/api-report.md",
      ["Release approval: release-approved by <approver> on <YYYY-MM-DD>"],
    ],
    [
      "docs/config-schema.md",
      ["Release approval: release-approved by <approver> on <YYYY-MM-DD>"],
    ],
    [
      "docs/decisions/security-review.md",
      [
        "Status: external-review-completed",
        "Reviewer:",
        "Unresolved findings:",
        "Status: maintainer-signoff",
        "Signed by:",
        "Rationale:",
        "Compensating controls:",
      ],
    ],
  ]) {
    const text = await readFile(file, "utf8");
    for (const needle of needles) {
      if (!text.includes(needle)) {
        failures.push(`${file}: missing ${needle}`);
      }
    }
  }
}

function releaseWorkflowScripts(scripts) {
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
    "smoke:tarballs",
    "benchmark:password",
    "publish:dry-run",
  ]);
  return Object.keys(scripts)
    .filter((script) => required.has(script) || script.startsWith("verify:"))
    .sort();
}

function requireOrderedText(file, text, needles) {
  let previousIndex = -1;
  let previousNeedle = "";
  for (const needle of needles) {
    const index = text.indexOf(needle);
    if (index === -1) continue;
    if (index < previousIndex) {
      failures.push(`${file}: ${needle} must appear after ${previousNeedle}`);
      return;
    }
    previousIndex = index;
    previousNeedle = needle;
  }
}

async function verifyCiControls() {
  const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
  for (const needle of [
    "pnpm install --frozen-lockfile",
    "pnpm format:check",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm test:workers",
    "pnpm build",
    "pnpm package:check",
    "pnpm version-matrix:check",
  ]) {
    if (!ciWorkflow.includes(needle)) {
      failures.push(`.github/workflows/ci.yml: missing ${needle}`);
    }
  }

  const examplesWorkflow = await readFile(
    ".github/workflows/examples.yml",
    "utf8",
  );
  if (!examplesWorkflow.includes("pnpm verify:examples")) {
    failures.push(
      ".github/workflows/examples.yml: missing pnpm verify:examples",
    );
  }
}

function verifyRootScripts() {
  for (const script of [
    "format:check",
    "lint",
    "typecheck",
    "test",
    "test:workers",
    "build",
    "check:package-names",
    "package:check",
    "version-matrix:check",
    "export:deploy-template",
    "verify:alpha-evidence",
    "verify:beta-evidence",
    "verify:deploy-button-evidence",
    "verify:deploy-template",
    "verify:docs-coverage",
    "verify:examples",
    "verify:migrations",
    "verify:package-ownership",
    "verify:security-docs",
    "verify:security-tracker",
    "release:gates",
    "publish:dry-run",
    "smoke:wrangler-dev",
    "smoke:cloudflare-production",
    "smoke:published-quickstart",
    "smoke:tarballs",
    "benchmark:password",
  ]) {
    if (!rootPackage.scripts?.[script]) {
      failures.push(`package.json: missing script ${script}`);
    }
  }
  const dryRunScript = rootPackage.scripts?.["publish:dry-run"] ?? "";
  for (const needle of [
    "publish",
    "--dry-run",
    "--no-git-checks",
    "--report-summary",
  ]) {
    if (!dryRunScript.includes(needle)) {
      failures.push(`package.json: publish:dry-run missing ${needle}`);
    }
  }
}

async function verifyToolchainDocs() {
  const matrix = await readJsonObject("scripts/version-matrix.json");
  if (!matrix) return;
  const docs = await readFile("docs/toolchain.md", "utf8");
  for (const [key, value] of Object.entries({
    node: matrix.node,
    pnpm: matrix.pnpm,
    typescript: matrix.typescript,
    wrangler: matrix.wrangler,
    hono: matrix.hono,
    tsup: matrix.tsup,
    vitest: matrix.vitest,
    zod: matrix.zod,
    changesets: matrix.changesets,
    workersCompatibilityDate: matrix.workersCompatibilityDate,
    workersCompatibilityDateFloor: matrix.workersCompatibilityDateFloor,
  })) {
    if (!docs.includes(String(value))) {
      failures.push(`docs/toolchain.md: missing ${key} version ${value}`);
    }
  }
  const deployment = await readFile("docs/deployment.md", "utf8");
  if (!deployment.includes("(toolchain.md)")) {
    failures.push("docs/deployment.md: missing toolchain.md link");
  }
}

async function readJsonObject(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    failures.push(`${path}: must be valid JSON`);
    return null;
  }
  if (!isJsonObject(parsed)) {
    failures.push(`${path}: top-level JSON value must be an object`);
    return null;
  }
  return parsed;
}

async function listMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files.sort();
}
