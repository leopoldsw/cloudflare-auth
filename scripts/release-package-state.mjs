import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isJsonObject } from "./evidence-validation.mjs";

export async function readReleasePackageState() {
  const failures = [];
  const versions = [];
  const entries = await readdir("packages", { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join("packages", entry.name, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(await readFile(path, "utf8"));
    } catch {
      failures.push(`${path}: must be valid JSON`);
      continue;
    }
    if (!isJsonObject(pkg)) {
      failures.push(`${path}: top-level JSON value must be an object`);
      continue;
    }
    if (!pkg.private) {
      if (typeof pkg.name !== "string" || pkg.name.trim().length === 0) {
        failures.push(`${path}: name must be a non-empty string`);
      }
      if (typeof pkg.version !== "string" || pkg.version.trim().length === 0) {
        failures.push(`${path}: version must be a non-empty string`);
        continue;
      }
      if (isPlaceholderPrerelease(pkg.version)) {
        failures.push(
          `${path}: release version must not use placeholder 0.0.0 base`,
        );
      }
      versions.push(pkg.version);
    }
  }
  return {
    failures,
    hasBetaOrStable: versions.some(
      (version) => isPublicBeta(version) || isStableOneOrLater(version),
    ),
    hasStable: versions.some((version) => isStableOneOrLater(version)),
  };
}

function isPublicBeta(version) {
  return /^\d+\.\d+\.\d+-beta(?:[.-].*)?$/u.test(version);
}

function isPlaceholderPrerelease(version) {
  return /^0\.0\.0-.+/u.test(version);
}

function isStableOneOrLater(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/);
  if (!match || version.includes("-")) return false;
  return Number(match[1]) >= 1;
}
