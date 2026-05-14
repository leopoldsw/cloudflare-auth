import { readFile } from "node:fs/promises";

import { isJsonObject } from "./evidence-validation.mjs";

export const dependencySections = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export function parseJsonObject(text, label) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label}: must be valid JSON`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`${label}: top-level JSON value must be an object`);
  }
  return parsed;
}

export async function readJsonObject(path, label = path) {
  return parseJsonObject(await readFile(path, "utf8"), label);
}

export function parsePnpmPackOutput(stdout, label) {
  const pack = parseJsonObject(stdout, `${label}: pnpm pack JSON output`);
  if (typeof pack.name !== "string" || pack.name.length === 0) {
    throw new Error(`${label}: pnpm pack JSON output must include name`);
  }
  if (typeof pack.filename !== "string" || pack.filename.length === 0) {
    throw new Error(`${label}: pnpm pack JSON output must include filename`);
  }
  return pack;
}

export function getObjectSection(object, section, label, options = {}) {
  const value = object[section];
  if (value === undefined) {
    if (!options.create) return undefined;
    const created = {};
    object[section] = created;
    return created;
  }
  if (!isJsonObject(value)) {
    throw new Error(`${label}: ${section} must be an object`);
  }
  return value;
}

export function assertNoWorkspaceDependencies(pkg, label) {
  const workspaceDependencies = [];
  for (const section of dependencySections) {
    const dependencies = getObjectSection(pkg, section, label);
    if (!dependencies) continue;
    for (const [name, version] of Object.entries(dependencies)) {
      if (String(version).startsWith("workspace:")) {
        workspaceDependencies.push(`${section}.${name}`);
      }
    }
  }
  if (workspaceDependencies.length > 0) {
    throw new Error(
      `${label} contains workspace protocol dependencies: ${workspaceDependencies.join(
        ", ",
      )}`,
    );
  }
}

export function rewriteWorkspaceDependencySpecs(pkg, label, resolveSpec) {
  for (const section of dependencySections) {
    const dependencies = getObjectSection(pkg, section, label);
    if (!dependencies) continue;
    for (const [name, version] of Object.entries(dependencies)) {
      if (String(version).startsWith("workspace:")) {
        dependencies[name] = resolveSpec(name, section);
      }
    }
  }
}
