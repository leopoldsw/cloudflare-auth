import { spawnSync } from "node:child_process";
import { access, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { isJsonObject } from "./evidence-validation.mjs";
import {
  collectReleaseReadinessAuditFailures,
  collectReleaseReadinessAuditPathReferenceFailures,
  collectReleaseReadinessAuditTestReferenceFailures,
  releaseReadinessAuditPath,
} from "./release-readiness-audit-checks.mjs";
import {
  isPlaceholderPrerelease,
  isPublishedReleaseVersion,
  isSupportedReleaseVersion,
} from "./release-version-policy.mjs";
import {
  blockHasTrimmedLine,
  workflowInputBlock,
  workflowNamedStepBlock,
} from "./workflow-text.mjs";

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
const packageManifests = new Map();
for (const dir of packageDirs) {
  packageManifests.set(dir, await readJsonObject(join(dir, "package.json")));
}
const currentPublishablePackageNames = new Set();
for (const pkg of packageManifests.values()) {
  if (
    pkg &&
    pkg.private !== true &&
    typeof pkg.name === "string" &&
    pkg.name.trim().length > 0
  ) {
    currentPublishablePackageNames.add(pkg.name);
  }
}
const packDir = await mkdtemp(join(tmpdir(), "cf-auth-package-check-"));

const publishablePackageNames = [];
const publishablePackages = [];
const reservedPackageEvidenceNames = new Set([
  "cf-auth",
  "create-cloudflare-auth",
]);
const blockedPublicPackageCommands = [
  {
    label: "npx cf-auth",
    pattern: /\bnpx\s+cf-auth(?:@[\w.-]+)?(?![\w.-])/,
  },
  {
    label: "npm create cloudflare-auth",
    pattern: /\bnpm\s+create\s+cloudflare-auth(?:@[\w.-]+)?(?![\w.-])/,
  },
  {
    label: "npm init cloudflare-auth",
    pattern: /\bnpm\s+init\s+cloudflare-auth(?:@[\w.-]+)?(?![\w.-])/,
  },
  {
    label: "pnpm dlx cf-auth",
    pattern: /\bpnpm\s+dlx\s+cf-auth(?:@[\w.-]+)?(?![\w.-])/,
  },
  {
    label: "pnpm create cloudflare-auth",
    pattern: /\bpnpm\s+create\s+cloudflare-auth(?:@[\w.-]+)?(?![\w.-])/,
  },
  {
    label: "yarn dlx cf-auth",
    pattern: /\byarn\s+dlx\s+cf-auth(?:@[\w.-]+)?(?![\w.-])/,
  },
  {
    label: "yarn create cloudflare-auth",
    pattern: /\byarn\s+create\s+cloudflare-auth(?:@[\w.-]+)?(?![\w.-])/,
  },
  {
    label: "bunx cf-auth",
    pattern: /\bbunx\s+cf-auth(?:@[\w.-]+)?(?![\w.-])/,
  },
  {
    label: "bun create cloudflare-auth",
    pattern: /\bbun\s+create\s+cloudflare-auth(?:@[\w.-]+)?(?![\w.-])/,
  },
];
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
  const pkg = packageManifests.get(dir);
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
  try {
    const packageReadme = await readFile(join(dir, "README.md"), "utf8");
    if (
      !packageReadme.includes(
        "not affiliated with, endorsed by, or sponsored by Cloudflare",
      )
    ) {
      failures.push(
        `${pkg.name}: README must include independent-project disclaimer`,
      );
    }
  } catch {
    failures.push(`${pkg.name}: README file missing`);
  }
  const rootExport = rootExportMap(pkg);
  if (!rootExport) {
    failures.push(`${pkg.name}: missing explicit root export map`);
  } else {
    for (const field of ["types", "import", "require"]) {
      if (
        typeof rootExport[field] !== "string" ||
        rootExport[field].trim().length === 0
      ) {
        failures.push(`${pkg.name}: root export map missing ${field}`);
      }
    }
    if (pkg.types && rootExport.types !== pkg.types) {
      failures.push(`${pkg.name}: root export types must match types field`);
    }
    if (pkg.module && rootExport.import !== pkg.module) {
      failures.push(`${pkg.name}: root export import must match module field`);
    }
    if (pkg.main && rootExport.require !== pkg.main) {
      failures.push(`${pkg.name}: root export require must match main field`);
    }
  }
  if (!pkg.types) failures.push(`${pkg.name}: missing types field`);
  if (!pkg.files?.includes("dist"))
    failures.push(`${pkg.name}: package files must include dist`);
  if (pkg.private !== true) {
    publishablePackageNames.push(pkg.name);
    publishablePackages.push({
      name: String(pkg.name),
      version: String(pkg.version ?? ""),
    });
  }
  if (expected?.privateUntilOwnershipConfirmed) {
    if (pkg.private !== true) {
      await requireOwnershipEvidenceForUnreservedPackage(pkg);
    }
  } else if (pkg.private) {
    failures.push(`${pkg.name}: publishable packages must not be private`);
  }
  if (pkg.engines?.node !== ">=22.13.0")
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
      packagePath(rootExport?.types),
      packagePath(rootExport?.import),
      packagePath(rootExport?.require),
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

verifyFixedPackageVersions();
verifyReleasePackageVersions();
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
await verifyWorkflowToolchainControls();
await verifySecurityAutomationControls();
await verifyReleaseControls();

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

function rootExportMap(pkg) {
  if (!isJsonObject(pkg.exports)) return null;
  const rootExport = pkg.exports["."];
  return isJsonObject(rootExport) ? rootExport : null;
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

function verifyFixedPackageVersions() {
  const versions = new Set(
    publishablePackages.map((pkg) => pkg.version).filter(Boolean),
  );
  if (versions.size <= 1) return;
  failures.push(
    `publishable packages must share one version because the Changesets fixed package group is required: ${publishablePackages
      .map((pkg) => `${pkg.name}@${pkg.version}`)
      .join(", ")}`,
  );
}

function verifyReleasePackageVersions() {
  for (const pkg of publishablePackages) {
    if (isPlaceholderPrerelease(pkg.version)) {
      failures.push(
        `${pkg.name}@${pkg.version}: release version must not use placeholder 0.0.0 base`,
      );
    }
    if (
      isPublishedReleaseVersion(pkg.version) &&
      !isSupportedReleaseVersion(pkg.version)
    ) {
      failures.push(
        `${pkg.name}@${pkg.version}: release versions must use alpha, beta, or stable 1.0+ channels from the implementation plan`,
      );
    }
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
    if (typeof item.name !== "string" || item.name.trim().length === 0) {
      failures.push(
        `docs/package-ownership.json: packages[${index}].name must be a non-empty string`,
      );
      continue;
    }
    if (packagesByName.has(item.name)) {
      failures.push(
        `docs/package-ownership.json: duplicate package evidence for ${item.name}`,
      );
    }
    if (!currentPublishablePackageNames.has(item.name)) {
      failures.push(
        `docs/package-ownership.json: ${item.name} must match a publishable workspace package`,
      );
    }
    packagesByName.set(item.name, item);
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
    if (typeof item.name !== "string" || item.name.trim().length === 0) {
      failures.push(
        `docs/package-ownership.json: reservedPackages[${index}].name must be a non-empty string`,
      );
      continue;
    }
    if (reservedByName.has(item.name)) {
      failures.push(
        `docs/package-ownership.json: duplicate reserved package evidence for ${item.name}`,
      );
    }
    if (!reservedPackageEvidenceNames.has(item.name)) {
      failures.push(
        `docs/package-ownership.json: ${item.name} must not be listed under reservedPackages unless its workspace package is private`,
      );
    }
    reservedByName.set(item.name, item);
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
  for (const needle of [
    "cf-auth@1.0.2",
    "public docs must not use `npx cf-auth@latest`",
    "create and control the `@cf-auth/*` scope",
    "npm view create-cloudflare-auth name version --json",
    "public docs must not use `npm create cloudflare-auth`",
    "public docs must also not use `npm init cloudflare-auth`",
    "`pnpm dlx cf-auth`",
    "`pnpm create cloudflare-auth`",
    "`yarn dlx cf-auth`",
    "`yarn create cloudflare-auth`",
    "`bunx cf-auth`",
    "`bun create cloudflare-auth`",
    "@cloudflare-auth/cli",
    "@cloudflare-auth/client",
    "@cloudflare-auth/core",
    "@cloudflare-auth/email-cloudflare",
    "@cloudflare-auth/hono",
    "@cloudflare-auth/testing",
    "@cloudflare-auth/worker",
    "availability signal only",
    "ownership evidence",
    "raw secrets, auth tokens, cookies, emails, IPs, user agents",
  ]) {
    if (!naming.includes(needle)) {
      failures.push(
        `docs/decisions/package-naming.md: missing package naming evidence ${needle}`,
      );
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
    for (const { label, pattern } of blockedPublicPackageCommands) {
      if (pattern.test(text)) {
        failures.push(
          `${file}: ${label} commands are blocked until package ownership is confirmed`,
        );
      }
    }
    for (const alias of ["cf-auth upgrade", "cf-auth add turnstile"]) {
      if (text.includes(alias)) {
        failures.push(`${file}: unsupported v1 command alias ${alias}`);
      }
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
    audit = await readFile(releaseReadinessAuditPath, "utf8");
  } catch {
    return;
  }
  failures.push(...collectReleaseReadinessAuditFailures(audit));
  failures.push(...collectReleaseReadinessAuditPathReferenceFailures(audit));
  failures.push(...collectReleaseReadinessAuditTestReferenceFailures(audit));

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
    "binding name rather than the database name",
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
  for (const needle of [
    "Use `cf-auth` commands first",
    "Raw `wrangler` commands",
    "secondary diagnostic steps",
    "`cf-auth doctor`",
  ]) {
    if (!troubleshooting.includes(needle)) {
      failures.push(
        `docs/troubleshooting.md: missing Wrangler fallback note ${needle}`,
      );
    }
  }
  for (const [problem, fix] of [
    ["Scoped CLI fallback fails", "@cf-auth/cli"],
    ["Scoped CLI fallback fails", "npx --package @cf-auth/cli@latest cf-auth"],
    ["Wrangler unavailable or wrong version", "npx wrangler --version"],
    ["Cloudflare login or account mismatch", "wrangler login"],
    ["Missing D1 binding", "AUTH_DB"],
    ["Missing D1 binding", "cf-auth init --repair"],
    ["Schema version mismatch", "auth_schema_migrations"],
    ["Missing `AUTH_SECRET`", "cf-auth rotate-secret --apply --env production"],
    ["Missing `AUTH_SECRET`", "cf-auth rotate-secret --print"],
    ["Migrations not applied", "cf-auth migrate --local"],
    ["Migrations not applied", "cf-auth migrate --remote --env production"],
    ["Sender/domain not ready", "docs/cloudflare-email.md"],
    ["Cookie not set locally", "__Host-"],
    ["Cookie not set in production", "__Host-"],
    ["Cookie not set in production", "__Secure-"],
    ["Cross-subdomain cookie rejected", "session.domain"],
    ["Cookie not sent", "fetch credentials"],
    ["Magic link opens but does not log in", "`GET` does not consume"],
    ["Magic link redirect rejected", "redirect allowlist"],
    ["Local dev behaves like production", "vars.AUTH_ENV"],
    ["Deploy uses development settings", "cf-auth doctor --env production"],
    ["Works locally but not deployed", "cf-auth doctor --env production"],
    ["Password hashing timeout", "pnpm benchmark:password"],
    ["Cloudflare Email binding missing", "AUTH_EMAIL"],
    ["Cloudflare Email binding missing", "custom email"],
    ["Reset email says OK but no email arrives", "email_send_failed"],
    ["JSON request returns `415`", "Content-Type: application/json"],
    ["Cross-site frontend cannot stay logged in", "SameSite=None"],
    ["Reset token appears in analytics/referrer logs", "built-in reset page"],
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
  for (const [label, needle] of [
    ["what this is", "Cloudflare Auth is"],
    [
      "independent-project disclaimer",
      "not affiliated with, endorsed by, or sponsored by Cloudflare",
    ],
    ["5-minute quickstart", "## 5-Minute Quickstart"],
    ["existing Hono app", "## Existing Hono App"],
    ["local dev email behavior", "## Local Development Email"],
    ["deploy to Cloudflare", "## Deploy To Cloudflare"],
    ["security defaults", "## Security Defaults"],
    ["supported frameworks", "## Supported Frameworks"],
    ["troubleshooting links", "## Troubleshooting"],
    ["non-goals", "docs/non-goals.md"],
  ]) {
    if (!readme.includes(needle)) {
      failures.push(
        `README.md: missing README requirement ${label}: ${needle}`,
      );
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
    "pnpm verify:release-audit",
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
  const packageNameInput = workflowInputBlock(
    releaseWorkflow,
    "package_names_confirmed",
  );
  if (
    !blockHasTrimmedLine(packageNameInput, "required: true") ||
    !blockHasTrimmedLine(packageNameInput, "type: boolean")
  ) {
    failures.push(
      ".github/workflows/release.yml: package_names_confirmed must be a required boolean workflow input",
    );
  }
  const packageNameGate = workflowNamedStepBlock(
    releaseWorkflow,
    "Require package-name gate",
  );
  if (
    !blockHasTrimmedLine(
      packageNameGate,
      "if: ${{ !inputs.package_names_confirmed }}",
    ) ||
    !blockHasTrimmedLine(packageNameGate, "exit 1")
  ) {
    failures.push(
      ".github/workflows/release.yml: package_names_confirmed must be enforced by an early failing gate step",
    );
  }
  const packageNameGateIndex = releaseWorkflow.indexOf(
    "name: Require package-name gate",
  );
  const checkoutIndex = releaseWorkflow.indexOf("uses: actions/checkout");
  if (
    packageNameGateIndex === -1 ||
    checkoutIndex === -1 ||
    packageNameGateIndex > checkoutIndex
  ) {
    failures.push(
      ".github/workflows/release.yml: package-name gate must run before checkout",
    );
  }
  if (
    !/-\s+run:\s+pnpm smoke:tarballs\s*\n\s+env:\s*\n\s+CF_AUTH_TARBALL_INSTALL:\s+"1"/u.test(
      releaseWorkflow,
    )
  ) {
    failures.push(
      '.github/workflows/release.yml: pnpm smoke:tarballs must run with CF_AUTH_TARBALL_INSTALL: "1"',
    );
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
    "pnpm verify:deploy-button-evidence",
    "pnpm verify:beta-evidence",
    "pnpm verify:deploy-template",
    "pnpm verify:docs-coverage",
    "pnpm verify:migrations",
    "pnpm verify:examples",
    "pnpm verify:package-ownership",
    "pnpm check:package-names",
    "pnpm verify:release-audit",
    "pnpm verify:security-docs",
    "pnpm verify:security-tracker",
    "pnpm release:gates",
    "pnpm smoke:tarballs",
    "pnpm benchmark:password",
    "pnpm publish:dry-run",
    "pnpm changeset publish --provenance",
  ]);

  const releaseChecklist = await readFile("docs/release-checklist.md", "utf8");
  const everyReleaseChecklist = markdownSection(
    releaseChecklist,
    "Every Release",
  );
  const everyReleaseCommands = [
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
    "pnpm verify:deploy-button-evidence",
    "pnpm verify:beta-evidence",
    "pnpm verify:deploy-template",
    "pnpm verify:docs-coverage",
    "pnpm verify:migrations",
    "pnpm verify:examples",
    "pnpm verify:package-ownership",
    "pnpm check:package-names",
    "pnpm verify:release-audit",
    "pnpm verify:security-docs",
    "pnpm verify:security-tracker",
    "pnpm release:gates",
    "CF_AUTH_TARBALL_INSTALL=1 pnpm smoke:tarballs",
    "pnpm benchmark:password",
    "pnpm publish:dry-run",
  ];
  for (const needle of everyReleaseCommands) {
    if (!everyReleaseChecklist.includes(needle)) {
      failures.push(
        `docs/release-checklist.md: Every Release missing ${needle}`,
      );
    }
  }
  requireOrderedText(
    "docs/release-checklist.md Every Release",
    everyReleaseChecklist,
    everyReleaseCommands,
  );

  const productionSmokeWorkflow = await readFile(
    ".github/workflows/cloudflare-production-smoke.yml",
    "utf8",
  );
  for (const needle of [
    "workflow_dispatch:",
    "package_tag:",
    "Optional beta npm dist-tag or x.y.z-beta.* prerelease version to smoke. Empty uses local package tarballs.",
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
    "Beta npm dist-tag or x.y.z-beta.* prerelease version to smoke.",
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
        "0.0.0-alpha.*",
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
        "never `0.0.0-*`",
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

function markdownSection(text, heading) {
  const marker = `## ${heading}`;
  const start = text.indexOf(marker);
  if (start === -1) return "";
  const next = text.slice(start + marker.length).search(/\n## /u);
  return next === -1
    ? text.slice(start)
    : text.slice(start, start + marker.length + next);
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

async function verifyWorkflowToolchainControls() {
  const matrix = await readJsonObject("scripts/version-matrix.json");
  if (
    !matrix ||
    typeof matrix.pnpm !== "string" ||
    typeof matrix.node !== "string"
  ) {
    return;
  }
  const nodeVersion = workflowNodeVersion(matrix.node);
  for (const file of [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/workflows/examples.yml",
    ".github/workflows/wrangler-dev-smoke.yml",
    ".github/workflows/published-quickstart-smoke.yml",
    ".github/workflows/cloudflare-production-smoke.yml",
  ]) {
    const text = await readFile(file, "utf8");
    if (!text.includes("pnpm/action-setup@v5")) {
      failures.push(`${file}: missing pnpm/action-setup@v5`);
    }
    if (!text.includes(`version: ${matrix.pnpm}`)) {
      failures.push(
        `${file}: pnpm/action-setup version must be ${matrix.pnpm}`,
      );
    }
    if (!text.includes("actions/setup-node@v6")) {
      failures.push(`${file}: missing actions/setup-node@v6`);
    }
    if (!text.includes(`node-version: ${nodeVersion}`)) {
      failures.push(`${file}: node-version must be ${nodeVersion}`);
    }
  }
}

async function verifySecurityAutomationControls() {
  const dependencyReviewWorkflow = await readFile(
    ".github/workflows/dependency-review.yml",
    "utf8",
  );
  for (const needle of [
    "pull_request:",
    "contents: read",
    "pull-requests: read",
    "actions/dependency-review-action@v5",
  ]) {
    if (!dependencyReviewWorkflow.includes(needle)) {
      failures.push(
        `.github/workflows/dependency-review.yml: missing ${needle}`,
      );
    }
  }

  const codeqlWorkflow = await readFile(".github/workflows/codeql.yml", "utf8");
  for (const needle of [
    "pull_request:",
    "branches: [main]",
    "security-events: write",
    "github/codeql-action/init@v4",
    "languages: javascript-typescript",
    "github/codeql-action/analyze@v4",
  ]) {
    if (!codeqlWorkflow.includes(needle)) {
      failures.push(`.github/workflows/codeql.yml: missing ${needle}`);
    }
  }

  const dependabot = await readFile(".github/dependabot.yml", "utf8");
  for (const needle of [
    "version: 2",
    "package-ecosystem: npm",
    "package-ecosystem: github-actions",
    "interval: weekly",
  ]) {
    if (!dependabot.includes(needle)) {
      failures.push(`.github/dependabot.yml: missing ${needle}`);
    }
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
    "verify:release-audit",
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
  const testScript = rootPackage.scripts?.test ?? "";
  if (
    !/^\s*vitest\s+run(?:\s|$)/u.test(testScript) ||
    !testScript.includes("--no-file-parallelism")
  ) {
    failures.push(
      "package.json: test must run vitest with --no-file-parallelism",
    );
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

function workflowNodeVersion(nodeEngine) {
  return String(nodeEngine).replace(/^>=\s*/u, "");
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
