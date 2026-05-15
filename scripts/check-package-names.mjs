import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { containsSensitiveEvidence } from "./evidence-redaction.mjs";
import {
  isFutureIsoDateString,
  isIsoDateString,
  isJsonObject,
  isPlaceholderEvidenceIdentity,
} from "./evidence-validation.mjs";

const evidencePath =
  process.env.CF_AUTH_PACKAGE_OWNERSHIP_PATH ?? "docs/package-ownership.json";
const registry = "https://registry.npmjs.org/";
const failures = [];
const workspacePackages = await workspacePackageManifests();
const packages = workspacePackages
  .filter((entry) => !entry.pkg.private)
  .map((entry) => workspacePackageIdentity(entry))
  .filter((pkg) => pkg !== null)
  .sort((a, b) => a.name.localeCompare(b.name));
const packageNames = new Set(packages.map((pkg) => pkg.name));
const reservedPackages = workspacePackages
  .filter(
    (entry) =>
      entry.pkg.private === true &&
      (entry.pkg.name === "cf-auth" ||
        entry.pkg.name === "create-cloudflare-auth"),
  )
  .map((entry) => workspacePackageIdentity(entry))
  .filter((pkg) => pkg !== null)
  .sort((a, b) => a.name.localeCompare(b.name));
const reservedPackageNames = new Set(reservedPackages.map((pkg) => pkg.name));

const { packageEvidenceByName, reservedEvidenceByName } =
  await readOwnershipEvidence();

for (const pkg of packages) {
  const evidence = packageEvidenceByName.get(pkg.name);
  if (!evidence) {
    failures.push(
      `${evidencePath}: missing ownership evidence for ${pkg.name}`,
    );
    continue;
  }
  if (evidence.registry !== registry) {
    failures.push(`${evidencePath}: ${pkg.name} registry must be ${registry}`);
  }
  if (evidence.version !== pkg.version) {
    failures.push(
      `${evidencePath}: ${pkg.name} evidence version must be ${pkg.version}`,
    );
  }
  for (const field of [
    "ownershipConfirmed",
    "publisherTwoFactorEnabled",
    "provenancePublish",
  ]) {
    if (evidence[field] !== true) {
      failures.push(`${evidencePath}: ${pkg.name} ${field} must be true`);
    }
  }
  if (isPlaceholderReleaseVersion(pkg.version)) {
    failures.push(
      `${pkg.name}: release workflow must not publish placeholder version 0.0.0`,
    );
  }
}
for (const pkg of reservedPackages) {
  if (packageEvidenceByName.has(pkg.name)) {
    failures.push(
      `${evidencePath}: ${pkg.name} must be listed under reservedPackages while its workspace package is private`,
    );
  }
  const evidence = reservedEvidenceByName.get(pkg.name);
  if (!evidence) {
    failures.push(
      `${evidencePath}: missing reserved package evidence for ${pkg.name}`,
    );
    continue;
  }
  if (evidence.registry !== registry) {
    failures.push(`${evidencePath}: ${pkg.name} registry must be ${registry}`);
  }
  if (evidence.publishableAfterOwnershipConfirmed !== true) {
    failures.push(
      `${evidencePath}: ${pkg.name} publishableAfterOwnershipConfirmed must be true`,
    );
  }
}

if (failures.length > 0) fail();

for (const pkg of packages) {
  const evidence = packageEvidenceByName.get(pkg.name);
  if (!evidence) continue;

  const nameLookup = npmView([pkg.name, "name", "version"]);
  if (nameLookup.kind === "found") {
    const registryPackage = parseRegistryPackageResult(
      nameLookup.stdout,
      `${pkg.name}: npm view result`,
    );
    if (!registryPackage) continue;
    const { registryName, registryVersion } = registryPackage;
    if (registryName !== pkg.name) {
      failures.push(
        `${pkg.name}: npm registry returned mismatched name ${String(
          registryName,
        )}`,
      );
    }
    if (typeof evidence.registryVersion !== "string") {
      failures.push(
        `${evidencePath}: ${pkg.name} already exists on npm; registryVersion must record the current published version`,
      );
    } else if (evidence.registryVersion !== registryVersion) {
      failures.push(
        `${evidencePath}: ${pkg.name} registryVersion must match current npm version ${String(
          registryVersion,
        )}`,
      );
    }
  } else if (nameLookup.kind === "error") {
    failures.push(`${pkg.name}: ${nameLookup.message}`);
  }

  const versionLookup = npmView([`${pkg.name}@${pkg.version}`, "version"]);
  if (versionLookup.kind === "found") {
    failures.push(
      `${pkg.name}@${pkg.version}: target version already exists on npm`,
    );
  } else if (versionLookup.kind === "error") {
    failures.push(`${pkg.name}@${pkg.version}: ${versionLookup.message}`);
  }
}
for (const pkg of reservedPackages) {
  const evidence = reservedEvidenceByName.get(pkg.name);
  if (!evidence) continue;

  const nameLookup = npmView([pkg.name, "name", "version"]);
  if (nameLookup.kind === "found") {
    const registryPackage = parseRegistryPackageResult(
      nameLookup.stdout,
      `${pkg.name}: npm view result`,
    );
    if (!registryPackage) continue;
    const { registryName, registryVersion } = registryPackage;
    if (registryName !== pkg.name) {
      failures.push(
        `${pkg.name}: npm registry returned mismatched name ${String(
          registryName,
        )}`,
      );
    }
    if (typeof evidence.registryVersion !== "string") {
      failures.push(
        `${evidencePath}: ${pkg.name} already exists on npm; reservedPackages registryVersion must record the current published version`,
      );
    } else if (evidence.registryVersion !== registryVersion) {
      failures.push(
        `${evidencePath}: ${pkg.name} reservedPackages registryVersion must match current npm version ${String(
          registryVersion,
        )}`,
      );
    }
  } else if (nameLookup.kind === "error") {
    failures.push(`${pkg.name}: ${nameLookup.message}`);
  }
}

if (failures.length > 0) fail();

console.log(
  `package names checked against npm registry: ${packages
    .map((pkg) => `${pkg.name}@${pkg.version}`)
    .join(", ")}`,
);

async function readOwnershipEvidence() {
  let text = "";
  try {
    text = await readFile(evidencePath, "utf8");
  } catch {
    failures.push(
      `${evidencePath}: package ownership evidence is required before publishing`,
    );
    fail();
  }

  const parsed = parseJson(text, evidencePath);
  if (!isJsonObject(parsed)) {
    failures.push(`${evidencePath}: top-level JSON value must be an object`);
    fail();
  }
  if (containsSensitiveEvidence(text)) {
    failures.push(
      `${evidencePath}: must not include raw secrets, tokens, cookies, emails, IPs, user agents, or Cloudflare API tokens`,
    );
  }
  validateEvidenceMetadata(parsed);
  if (!Array.isArray(parsed.packages)) {
    failures.push(`${evidencePath}: packages must be an array`);
  }
  const packageEvidence = Array.isArray(parsed.packages) ? parsed.packages : [];
  if (!Array.isArray(parsed.reservedPackages)) {
    failures.push(`${evidencePath}: reservedPackages must be an array`);
  }
  const reservedEvidence = Array.isArray(parsed.reservedPackages)
    ? parsed.reservedPackages
    : [];
  const packageEvidenceByName = new Map();
  for (const [index, item] of packageEvidence.entries()) {
    if (!isJsonObject(item)) {
      failures.push(`${evidencePath}: packages[${index}] must be an object`);
      continue;
    }
    if (typeof item.name !== "string" || item.name.trim().length === 0) {
      failures.push(
        `${evidencePath}: packages[${index}].name must be a non-empty string`,
      );
      continue;
    }
    if (packageEvidenceByName.has(item.name)) {
      failures.push(
        `${evidencePath}: duplicate package evidence for ${item.name}`,
      );
    }
    if (!packageNames.has(item.name)) {
      failures.push(
        `${evidencePath}: ${item.name} must match a publishable workspace package`,
      );
    }
    packageEvidenceByName.set(item.name, item);
  }
  const reservedEvidenceByName = new Map();
  for (const [index, item] of reservedEvidence.entries()) {
    if (!isJsonObject(item)) {
      failures.push(
        `${evidencePath}: reservedPackages[${index}] must be an object`,
      );
      continue;
    }
    if (typeof item.name !== "string" || item.name.trim().length === 0) {
      failures.push(
        `${evidencePath}: reservedPackages[${index}].name must be a non-empty string`,
      );
      continue;
    }
    if (reservedEvidenceByName.has(item.name)) {
      failures.push(
        `${evidencePath}: duplicate reserved package evidence for ${item.name}`,
      );
    }
    if (!reservedPackageNames.has(item.name)) {
      failures.push(
        `${evidencePath}: ${item.name} must not be listed under reservedPackages unless its workspace package is private`,
      );
    }
    reservedEvidenceByName.set(item.name, item);
  }
  return { packageEvidenceByName, reservedEvidenceByName };
}

function validateEvidenceMetadata(value) {
  if (value.schemaVersion !== 1) {
    failures.push(`${evidencePath}: schemaVersion must be 1`);
  }
  requireString(value.verifiedBy, "verifiedBy");
  if (
    typeof value.verifiedBy === "string" &&
    isPlaceholderEvidenceIdentity(value.verifiedBy)
  ) {
    failures.push(`${evidencePath}: verifiedBy must not be a placeholder`);
  }
  requireDate(value.verifiedAt, "verifiedAt");
}

function requireString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
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

async function workspacePackageManifests() {
  const entries = await readdir("packages", { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join("packages", entry.name, "package.json");
    const pkg = await readJsonObject(path);
    if (pkg) output.push({ path, pkg });
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
  return valid ? { name, version } : null;
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

function npmView(args) {
  const result = spawnSync(
    "npm",
    ["view", ...args, "--json", "--loglevel", "silent"],
    {
      encoding: "utf8",
    },
  );
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (result.status === 0) return { kind: "found", stdout: result.stdout };
  if (/\bE404\b|404 Not Found|is not in this registry/u.test(output)) {
    return { kind: "not-found" };
  }
  return {
    kind: "error",
    message: output || "npm view failed",
  };
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    failures.push(`${label}: must be valid JSON`);
    fail();
  }
}

function parseRegistryPackageResult(value, label) {
  const parsed = parseJson(value, label);
  if (!isJsonObject(parsed)) {
    failures.push(`${label}: top-level JSON value must be an object`);
    return null;
  }
  const registryName = parsed.name;
  const registryVersion = parsed.version;
  if (typeof registryName !== "string" || registryName.trim().length === 0) {
    failures.push(`${label}: name must be a non-empty string`);
  }
  if (
    typeof registryVersion !== "string" ||
    registryVersion.trim().length === 0
  ) {
    failures.push(`${label}: version must be a non-empty string`);
  }
  if (
    typeof registryName !== "string" ||
    registryName.trim().length === 0 ||
    typeof registryVersion !== "string" ||
    registryVersion.trim().length === 0
  ) {
    return null;
  }
  return { registryName, registryVersion };
}

function isPlaceholderReleaseVersion(version) {
  return typeof version === "string" && /^0\.0\.0(?:-.+)?$/u.test(version);
}

function fail() {
  console.error(failures.join("\n"));
  process.exit(1);
}
