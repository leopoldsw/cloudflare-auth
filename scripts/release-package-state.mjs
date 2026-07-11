import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isJsonObject } from "./evidence-validation.mjs";
import {
  isPlaceholderPrerelease,
  isPublishedReleaseVersion,
  isPublicBeta,
  isStableOneOrLater,
  isSupportedReleaseVersion,
  isValidReleaseVersion,
} from "./release-version-policy.mjs";

export async function readReleasePackageState() {
  const failures = [];
  const versions = [];
  const packages = [];
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
      if (!isValidReleaseVersion(pkg.version)) {
        failures.push(`${path}: version must be valid SemVer`);
        continue;
      }
      if (isPlaceholderPrerelease(pkg.version)) {
        failures.push(
          `${path}: release version must not use placeholder 0.0.0 base`,
        );
      }
      if (
        isPublishedReleaseVersion(pkg.version) &&
        !isSupportedReleaseVersion(pkg.version)
      ) {
        failures.push(
          `${path}: release versions must use alpha, beta, or stable 1.0+ channels from the implementation plan`,
        );
      }
      versions.push(pkg.version);
      if (typeof pkg.name === "string" && pkg.name.trim().length > 0) {
        packages.push({ name: pkg.name, version: pkg.version });
      }
    }
  }
  return {
    failures,
    packages,
    hasBetaOrStable: versions.some(
      (version) => isPublicBeta(version) || isStableOneOrLater(version),
    ),
    hasStable: versions.some((version) => isStableOneOrLater(version)),
  };
}
