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
} from "./evidence-validation.mjs";

const evidencePath =
  process.env.CF_AUTH_PACKAGE_OWNERSHIP_PATH ?? "docs/package-ownership.json";
const packages = await publishablePackages();
const reservedPackages = await privateReservedPackages();
const reservedPackageNames = new Set(reservedPackages.map((pkg) => pkg.name));
const requireEvidence =
  process.env.CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP === "1" ||
  packages.some((pkg) => isPublishedReleaseVersion(pkg.version));

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

const failures = [];
const text = await readFile(evidencePath, "utf8");
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

console.log(`package ownership evidence verified: ${evidencePath}`);

function validateEvidence(value, rawText) {
  if (value.schemaVersion !== 1) {
    failures.push(`${evidencePath}: schemaVersion must be 1`);
  }
  requireString(value.verifiedBy, "verifiedBy");
  requireDate(value.verifiedAt, "verifiedAt");

  const packageEvidence = Array.isArray(value.packages) ? value.packages : [];
  const byName = new Map();
  for (const [index, item] of packageEvidence.entries()) {
    const path = `packages[${index}]`;
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
      }
      byName.set(item.name, item);
    }
    requireString(item.version, `${path}.version`);
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

  const reservedEvidence = Array.isArray(value.reservedPackages)
    ? value.reservedPackages
    : [];
  const reservedByName = new Map();
  for (const [index, item] of reservedEvidence.entries()) {
    const path = `reservedPackages[${index}]`;
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
    if (
      "registryVersion" in item &&
      (typeof item.registryVersion !== "string" ||
        item.registryVersion.length === 0)
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

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${evidencePath}: ${path} must be a non-empty string`);
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
  return /\bmaintainer-name\b/u.test(text);
}

async function publishablePackages() {
  const entries = await readdir("packages", { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join("packages", entry.name);
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    if (!pkg.private) {
      output.push({ dir, name: pkg.name, version: pkg.version });
    }
  }
  return output.sort((a, b) => a.name.localeCompare(b.name));
}

async function privateReservedPackages() {
  const entries = await readdir("packages", { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join("packages", entry.name);
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    if (
      pkg.private === true &&
      (pkg.name === "cf-auth" || pkg.name === "create-cloudflare-auth")
    ) {
      output.push({ dir, name: pkg.name, version: pkg.version });
    }
  }
  return output.sort((a, b) => a.name.localeCompare(b.name));
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
