import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isJsonObject } from "./evidence-validation.mjs";

const evidencePath =
  process.env.CF_AUTH_PACKAGE_OWNERSHIP_PATH ?? "docs/package-ownership.json";
const registry = "https://registry.npmjs.org/";
const failures = [];
const workspacePackages = await workspacePackageManifests();
const packages = workspacePackages
  .filter((entry) => !entry.pkg.private)
  .map((entry) => ({
    name: String(entry.pkg.name),
    version: String(entry.pkg.version),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
const reservedPackages = workspacePackages
  .filter(
    (entry) =>
      entry.pkg.private === true &&
      (entry.pkg.name === "cf-auth" ||
        entry.pkg.name === "create-cloudflare-auth"),
  )
  .map((entry) => ({
    name: String(entry.pkg.name),
    version: String(entry.pkg.version),
  }))
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
  if (pkg.version === "0.0.0") {
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
    if (typeof item.name === "string") {
      packageEvidenceByName.set(item.name, item);
    }
  }
  const reservedEvidenceByName = new Map();
  for (const [index, item] of reservedEvidence.entries()) {
    if (!isJsonObject(item)) {
      failures.push(
        `${evidencePath}: reservedPackages[${index}] must be an object`,
      );
      continue;
    }
    if (typeof item.name === "string") {
      if (!reservedPackageNames.has(item.name)) {
        failures.push(
          `${evidencePath}: ${item.name} must not be listed under reservedPackages unless its workspace package is private`,
        );
      }
      reservedEvidenceByName.set(item.name, item);
    }
  }
  return { packageEvidenceByName, reservedEvidenceByName };
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
  if (typeof registryName !== "string" || registryName.length === 0) {
    failures.push(`${label}: name must be a non-empty string`);
  }
  if (typeof registryVersion !== "string" || registryVersion.length === 0) {
    failures.push(`${label}: version must be a non-empty string`);
  }
  if (
    typeof registryName !== "string" ||
    registryName.length === 0 ||
    typeof registryVersion !== "string" ||
    registryVersion.length === 0
  ) {
    return null;
  }
  return { registryName, registryVersion };
}

function fail() {
  console.error(failures.join("\n"));
  process.exit(1);
}
