import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  containsIpLiteral,
  containsRawSecretMaterial,
  containsRawUserAgent,
} from "./evidence-redaction.mjs";
import {
  isFutureIsoDateString,
  isIsoDateString,
  isJsonObject,
  isPlaceholderEvidenceIdentity,
} from "./evidence-validation.mjs";

const evidencePath =
  process.env.CF_AUTH_PACKAGE_OWNERSHIP_PATH ?? "docs/package-ownership.json";
const failures = [];
const workspacePackages = await workspacePackageManifests();
const workspacePackageIdentities = workspacePackages.map((entry) => ({
  entry,
  identity: workspacePackageIdentity(entry),
}));
const packages = workspacePackageIdentities
  .filter(({ entry }) => !entry.pkg.private)
  .map(({ identity }) => identity)
  .filter((pkg) => pkg !== null)
  .sort((a, b) => String(a.name).localeCompare(String(b.name)));
const packageNames = new Set(packages.map((pkg) => pkg.name));
const reservedPackages = workspacePackageIdentities
  .filter(
    ({ entry }) =>
      entry.pkg.private === true &&
      (entry.pkg.name === "cf-auth" ||
        entry.pkg.name === "create-cloudflare-auth"),
  )
  .map(({ identity }) => identity)
  .filter((pkg) => pkg !== null)
  .sort((a, b) => String(a.name).localeCompare(String(b.name)));
const reservedPackageNames = new Set(reservedPackages.map((pkg) => pkg.name));
const reservedPackageNamesRequiringRegistryVersion = new Set(["cf-auth"]);
const requireEvidence =
  process.env.CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP === "1" ||
  packages.some((pkg) => isPublishedReleaseVersion(pkg.version));

if (failures.length > 0) fail();

if (!(await exists(evidencePath))) {
  if (requireEvidence) {
    console.error(
      `${evidencePath}: package ownership evidence is required before publishing prerelease or stable packages.`,
    );
    process.exit(1);
  }
  console.log(
    "package ownership evidence not required for current package versions",
  );
  process.exit(0);
}

const text = await readFile(evidencePath, "utf8");
let evidence;
let parsedEvidence = false;
try {
  evidence = JSON.parse(text);
  parsedEvidence = true;
} catch {
  failures.push(`${evidencePath}: must be valid JSON`);
}

if (parsedEvidence) {
  if (isJsonObject(evidence)) {
    validateEvidence(evidence, text);
  } else {
    failures.push(`${evidencePath}: top-level JSON value must be an object`);
  }
}

if (failures.length > 0) {
  fail();
}

console.log(`package ownership evidence verified: ${evidencePath}`);

function validateEvidence(value, rawText) {
  if (value.schemaVersion !== 1) {
    failures.push(`${evidencePath}: schemaVersion must be 1`);
  }
  requireString(value.verifiedBy, "verifiedBy");
  rejectPlaceholderIdentity(value.verifiedBy, "verifiedBy");
  requireDate(value.verifiedAt, "verifiedAt");

  if (!Array.isArray(value.packages)) {
    failures.push(`${evidencePath}: packages must be an array`);
  }
  const packageEvidence = Array.isArray(value.packages) ? value.packages : [];
  const byName = new Map();
  for (const [index, item] of packageEvidence.entries()) {
    const path = `packages[${index}]`;
    if (!requireObject(item, path)) continue;
    requireString(item.name, `${path}.name`);
    if (typeof item.name === "string") {
      if (byName.has(item.name)) {
        failures.push(
          `${evidencePath}: duplicate package evidence for ${item.name}`,
        );
      }
      if (reservedPackages.some((pkg) => pkg.name === item.name)) {
        failures.push(
          `${evidencePath}: ${item.name} must be listed under reservedPackages while its workspace package is private`,
        );
      } else if (!packageNames.has(item.name)) {
        failures.push(
          `${evidencePath}: ${item.name} must match a publishable workspace package`,
        );
      }
      byName.set(item.name, item);
    }
    requireString(item.version, `${path}.version`);
    if (item.version === "0.0.0") {
      failures.push(
        `${evidencePath}: ${path}.version must not be placeholder version 0.0.0 before publishing`,
      );
    }
    requireString(item.registry, `${path}.registry`);
    if (item.registry !== "https://registry.npmjs.org/") {
      failures.push(`${evidencePath}: ${path}.registry must be npmjs.org`);
    }
    for (const field of [
      "ownershipConfirmed",
      "publisherTwoFactorEnabled",
      "provenancePublish",
    ]) {
      if (item[field] !== true) {
        failures.push(`${evidencePath}: ${path}.${field} must be true`);
      }
    }
  }

  for (const pkg of packages) {
    if (pkg.version === "0.0.0") {
      failures.push(
        `${pkg.name}: package ownership evidence cannot target placeholder version 0.0.0`,
      );
    }
    const item = byName.get(pkg.name);
    if (!item) {
      failures.push(
        `${evidencePath}: missing ownership evidence for ${pkg.name}`,
      );
      continue;
    }
    if (item.version !== pkg.version) {
      failures.push(
        `${evidencePath}: ${pkg.name} evidence version must be ${pkg.version}`,
      );
    }
  }

  if (!Array.isArray(value.reservedPackages)) {
    failures.push(`${evidencePath}: reservedPackages must be an array`);
  }
  const reservedEvidence = Array.isArray(value.reservedPackages)
    ? value.reservedPackages
    : [];
  const reservedByName = new Map();
  for (const [index, item] of reservedEvidence.entries()) {
    const path = `reservedPackages[${index}]`;
    if (!requireObject(item, path)) continue;
    requireString(item.name, `${path}.name`);
    if (typeof item.name === "string") {
      if (reservedByName.has(item.name)) {
        failures.push(
          `${evidencePath}: duplicate reserved package evidence for ${item.name}`,
        );
      }
      if (!reservedPackageNames.has(item.name)) {
        failures.push(
          `${evidencePath}: ${item.name} must not be listed under reservedPackages unless its workspace package is private`,
        );
      }
      reservedByName.set(item.name, item);
    }
    requireString(item.registry, `${path}.registry`);
    if (item.registry !== "https://registry.npmjs.org/") {
      failures.push(`${evidencePath}: ${path}.registry must be npmjs.org`);
    }
    if (item.publishableAfterOwnershipConfirmed !== true) {
      failures.push(
        `${evidencePath}: ${path}.publishableAfterOwnershipConfirmed must be true`,
      );
    }
    if (reservedPackageNamesRequiringRegistryVersion.has(item.name)) {
      if (
        typeof item.registryVersion !== "string" ||
        item.registryVersion.trim().length === 0
      ) {
        failures.push(
          `${evidencePath}: ${path}.registryVersion must be a non-empty string for already-published reserved package names`,
        );
      }
    } else if (
      "registryVersion" in item &&
      (typeof item.registryVersion !== "string" ||
        item.registryVersion.trim().length === 0)
    ) {
      failures.push(
        `${evidencePath}: ${path}.registryVersion must be a non-empty string when present`,
      );
    }
  }
  for (const pkg of reservedPackages) {
    if (!reservedByName.has(pkg.name)) {
      failures.push(
        `${evidencePath}: missing reserved package evidence for ${pkg.name}`,
      );
    }
  }

  if (containsSensitiveEvidence(rawText)) {
    failures.push(
      `${evidencePath}: must not include raw secrets, tokens, cookies, emails, IPs, user agents, or Cloudflare API tokens`,
    );
  }
  if (containsPlaceholderEvidence(rawText)) {
    failures.push(
      `${evidencePath}: replace placeholder maintainer or package evidence values before release`,
    );
  }
}

function requireObject(value, path) {
  if (!isJsonObject(value)) {
    failures.push(`${evidencePath}: ${path} must be an object`);
    return false;
  }
  return true;
}

function requireString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    failures.push(`${evidencePath}: ${path} must be a non-empty string`);
  }
}

function rejectPlaceholderIdentity(value, path) {
  if (typeof value === "string" && isPlaceholderEvidenceIdentity(value)) {
    failures.push(
      `${evidencePath}: ${path} must not be a placeholder identity`,
    );
  }
}

function requireDate(value, path) {
  requireString(value, path);
  if (typeof value === "string" && !isIsoDateString(value)) {
    failures.push(`${evidencePath}: ${path} must be an ISO date string`);
  } else if (typeof value === "string" && isFutureIsoDateString(value)) {
    failures.push(`${evidencePath}: ${path} must not be in the future`);
  }
}

function containsSensitiveEvidence(text) {
  return (
    containsRawSecretMaterial(text) ||
    /\bcfauth\.(?:ses|magic|verify|reset)\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]{20,}/u.test(
      text,
    ) ||
    /\b(?:__Host-|__Secure-)?cfauth-session=/u.test(text) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(text) ||
    containsIpLiteral(text) ||
    containsRawUserAgent(text)
  );
}

function containsPlaceholderEvidence(text) {
  return /\bmaintainer-name\b|\brelease-reviewer\b/iu.test(text);
}

async function workspacePackageManifests() {
  const entries = await readdir("packages", { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join("packages", entry.name);
    const path = join(dir, "package.json");
    const pkg = await readJsonObject(path);
    if (pkg) output.push({ dir, path, pkg });
  }
  return output;
}

function workspacePackageIdentity(entry) {
  const name = entry.pkg.name;
  const version = entry.pkg.version;
  let valid = true;
  if (typeof name !== "string" || name.trim().length === 0) {
    failures.push(`${entry.path}: name must be a non-empty string`);
    valid = false;
  }
  if (typeof version !== "string" || version.trim().length === 0) {
    failures.push(`${entry.path}: version must be a non-empty string`);
    valid = false;
  }
  return valid ? { dir: entry.dir, name, version } : null;
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

function isPublishedReleaseVersion(version) {
  if (typeof version !== "string") return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-[\w.-]+)?$/u);
  if (!match) return false;
  return (
    Number(match[1]) !== 0 || Number(match[2]) !== 0 || Number(match[3]) !== 0
  );
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function fail() {
  console.error(failures.join("\n"));
  process.exit(1);
}
