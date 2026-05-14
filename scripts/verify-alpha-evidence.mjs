import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const evidencePath =
  process.env.CF_AUTH_ALPHA_EVIDENCE_PATH ?? "docs/alpha-evidence.json";
const requireEvidence =
  process.env.CF_AUTH_REQUIRE_ALPHA_EVIDENCE === "1" ||
  (await hasPublicBetaPackageVersions());

if (!(await exists(evidencePath))) {
  if (requireEvidence) {
    console.error(
      `${evidencePath}: private-alpha evidence is required before public beta.`,
    );
    process.exit(1);
  }
  console.log(
    "private-alpha evidence not required for current package versions",
  );
  process.exit(0);
}

const text = await readFile(evidencePath, "utf8");
const failures = [];
let evidence;
try {
  evidence = JSON.parse(text);
} catch {
  failures.push(`${evidencePath}: must be valid JSON`);
}

if (evidence) validateEvidence(evidence, text);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`private-alpha evidence verified: ${evidencePath}`);

function validateEvidence(value, rawText) {
  if (value.schemaVersion !== 1) {
    failures.push(`${evidencePath}: schemaVersion must be 1`);
  }
  const localSetups = Array.isArray(value.localSetups) ? value.localSetups : [];
  const productionDeploys = Array.isArray(value.productionDeploys)
    ? value.productionDeploys
    : [];
  const failuresSeen = Array.isArray(value.failures) ? value.failures : [];

  if (localSetups.length < 5) {
    failures.push(
      `${evidencePath}: at least 5 alpha local setups are required`,
    );
  }
  if (productionDeploys.length < 3) {
    failures.push(
      `${evidencePath}: at least 3 alpha production deploys are required`,
    );
  }

  const setupMinutes = [];
  for (const [index, setup] of localSetups.entries()) {
    const path = `localSetups[${index}]`;
    requireString(setup.user, `${path}.user`);
    requireDate(setup.completedAt, `${path}.completedAt`);
    if (!isPositiveNumber(setup.setupMinutes)) {
      failures.push(`${evidencePath}: ${path}.setupMinutes must be positive`);
    } else {
      setupMinutes.push(setup.setupMinutes);
    }
    for (const field of [
      "cleanDirectory",
      "documentedCommandsOnly",
      "signupLoginVerified",
    ]) {
      if (setup[field] !== true) {
        failures.push(`${evidencePath}: ${path}.${field} must be true`);
      }
    }
  }

  if (setupMinutes.length > 0 && median(setupMinutes) >= 10) {
    failures.push(
      `${evidencePath}: median local setup time must be under 10 minutes`,
    );
  }

  for (const [index, deploy] of productionDeploys.entries()) {
    const path = `productionDeploys[${index}]`;
    requireString(deploy.user, `${path}.user`);
    requireDate(deploy.completedAt, `${path}.completedAt`);
    for (const field of [
      "doctorReportAttached",
      "doctorPassed",
      "migratePassed",
      "deployPassed",
      "signupLoginVerified",
    ]) {
      if (deploy[field] !== true) {
        failures.push(`${evidencePath}: ${path}.${field} must be true`);
      }
    }
  }

  for (const [index, item] of failuresSeen.entries()) {
    const path = `failures[${index}]`;
    requireString(item.id, `${path}.id`);
    requireString(item.flow, `${path}.flow`);
    requireString(item.classification, `${path}.classification`);
  }
  if (failuresSeen.length > 0) {
    const covered = failuresSeen.filter(
      (item) =>
        item.doctorDiagnostic === true ||
        (item.exactFixDocumented === true &&
          typeof item.troubleshootingEntry === "string" &&
          item.troubleshootingEntry.length > 0),
    ).length;
    if (covered / failuresSeen.length < 0.8) {
      failures.push(
        `${evidencePath}: at least 80% of alpha failures need a doctor diagnostic or troubleshooting entry with an exact fix`,
      );
    }
  }

  if (containsSensitiveAlphaEvidence(rawText)) {
    failures.push(
      `${evidencePath}: must not include raw secrets, cookies, or cf-auth tokens`,
    );
  }
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${evidencePath}: ${path} must be a non-empty string`);
  }
}

function requireDate(value, path) {
  requireString(value, path);
  if (typeof value === "string" && Number.isNaN(Date.parse(value))) {
    failures.push(`${evidencePath}: ${path} must be an ISO date string`);
  }
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

function containsSensitiveAlphaEvidence(text) {
  return (
    /\bAUTH_SECRET\s*=/u.test(text) ||
    /\bcfauth\.(?:session|magic|verify|reset)\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{20,}/u.test(
      text,
    ) ||
    /\b(?:__Host-|__Secure-)?cfauth-session=/u.test(text)
  );
}

async function hasPublicBetaPackageVersions() {
  const packages = await readdir("packages", { withFileTypes: true });
  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const pkg = JSON.parse(
      await readFile(join("packages", entry.name, "package.json"), "utf8"),
    );
    if (!pkg.private && typeof pkg.version === "string") {
      if (/^\d+\.\d+\.\d+-beta(?:[.-].*)?$/u.test(pkg.version)) return true;
    }
  }
  return false;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
