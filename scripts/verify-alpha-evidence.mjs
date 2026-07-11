import { access, readFile } from "node:fs/promises";

import {
  containsSensitiveEvidence,
  containsSensitiveEvidenceValue,
} from "./evidence-redaction.mjs";
import {
  documentedLocalSetupCommandOrder,
  documentedLocalSetupCommands,
  documentedProductionDeployCommandOrder,
  documentedProductionDeployCommands,
  requireDocumentedCommandOrder,
  requireOnlyDocumentedCommands,
} from "./evidence-commands.mjs";
import {
  isFutureIsoDateString,
  isIsoDateString,
  isJsonObject,
  isPlaceholderEvidenceIdentity,
} from "./evidence-validation.mjs";
import { readReleasePackageState } from "./release-package-state.mjs";

const evidencePath =
  process.env.CF_AUTH_ALPHA_EVIDENCE_PATH ?? "docs/alpha-evidence.json";
const packageState = await readReleasePackageState();
const failures = [...packageState.failures];
const requireEvidence =
  process.env.CF_AUTH_REQUIRE_ALPHA_EVIDENCE === "1" ||
  packageState.hasBetaOrStable;

if (failures.length > 0) fail();

if (!(await exists(evidencePath))) {
  if (requireEvidence) {
    console.error(
      `${evidencePath}: private-alpha evidence is required before public beta or stable release.`,
    );
    process.exit(1);
  }
  console.log(
    "private-alpha evidence not required for current package versions",
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

console.log(`private-alpha evidence verified: ${evidencePath}`);

function validateEvidence(value, rawText) {
  if (value.schemaVersion !== 1) {
    failures.push(`${evidencePath}: schemaVersion must be 1`);
  }
  if (!Array.isArray(value.localSetups)) {
    failures.push(`${evidencePath}: localSetups must be an array`);
  }
  const localSetups = Array.isArray(value.localSetups) ? value.localSetups : [];
  if (!Array.isArray(value.productionDeploys)) {
    failures.push(`${evidencePath}: productionDeploys must be an array`);
  }
  const productionDeploys = Array.isArray(value.productionDeploys)
    ? value.productionDeploys
    : [];
  if (!Array.isArray(value.failures)) {
    failures.push(`${evidencePath}: failures must be an array`);
  }
  const failuresSeen = Array.isArray(value.failures) ? value.failures : [];

  const localSetupUsers = new Set(
    localSetups
      .map((setup) => (isJsonObject(setup) ? setup.user : null))
      .map(evidenceIdentityKey)
      .filter((user) => user.length > 0),
  );
  const productionDeployUsers = new Set(
    productionDeploys
      .map((deploy) => (isJsonObject(deploy) ? deploy.user : null))
      .map(evidenceIdentityKey)
      .filter((user) => user.length > 0),
  );

  if (localSetupUsers.size < 5) {
    failures.push(
      `${evidencePath}: at least 5 distinct alpha users must complete local setup`,
    );
  }
  if (productionDeployUsers.size < 3) {
    failures.push(
      `${evidencePath}: at least 3 distinct alpha users must complete production deploy`,
    );
  }

  const setupMinutes = [];
  for (const [index, setup] of localSetups.entries()) {
    const path = `localSetups[${index}]`;
    if (!requireObject(setup, path)) continue;
    requireString(setup.user, `${path}.user`);
    rejectPlaceholderIdentity(setup.user, `${path}.user`);
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
    requireCommandContains(setup.commands, "cf-auth init", `${path}.commands`);
    requireCommandContains(setup.commands, "cd my-app", `${path}.commands`);
    requireCommandContains(
      setup.commands,
      "cf-auth migrate --local",
      `${path}.commands`,
    );
    requireCommandContains(setup.commands, "pnpm install", `${path}.commands`);
    requireCommandContains(setup.commands, "npm run dev", `${path}.commands`);
    requireCommandContains(
      setup.commands,
      "@cf-auth/cli@alpha",
      `${path}.commands`,
    );
    requireOnlyDocumentedCommands({
      evidencePath,
      failures,
      commands: setup.commands,
      path: `${path}.commands`,
      allowedPatterns: documentedLocalSetupCommands("alpha"),
      label: "alpha",
    });
    requireDocumentedCommandOrder({
      evidencePath,
      failures,
      commands: setup.commands,
      path: `${path}.commands`,
      expected: documentedLocalSetupCommandOrder(),
    });
  }

  if (setupMinutes.length > 0 && median(setupMinutes) >= 10) {
    failures.push(
      `${evidencePath}: median local setup time must be under 10 minutes`,
    );
  }

  for (const [index, deploy] of productionDeploys.entries()) {
    const path = `productionDeploys[${index}]`;
    if (!requireObject(deploy, path)) continue;
    requireString(deploy.user, `${path}.user`);
    rejectPlaceholderIdentity(deploy.user, `${path}.user`);
    requireDate(deploy.completedAt, `${path}.completedAt`);
    for (const field of [
      "doctorReportAttached",
      "doctorReportSchemaValid",
      "doctorReportRedactionChecked",
      "doctorPassed",
      "migratePassed",
      "deployPassed",
      "signupLoginVerified",
    ]) {
      if (deploy[field] !== true) {
        failures.push(`${evidencePath}: ${path}.${field} must be true`);
      }
    }
    requireCommandIncludesAll(
      deploy.commands,
      ["cf-auth doctor", "--report", "--env production"],
      `${path}.commands`,
    );
    requireCommandContains(
      deploy.commands,
      "cf-auth migrate --remote --env production",
      `${path}.commands`,
    );
    requireCommandContains(
      deploy.commands,
      "cf-auth deploy --env production",
      `${path}.commands`,
    );
    requireCommandContains(
      deploy.commands,
      "@cf-auth/cli@alpha",
      `${path}.commands`,
    );
    requireOnlyDocumentedCommands({
      evidencePath,
      failures,
      commands: deploy.commands,
      path: `${path}.commands`,
      allowedPatterns: documentedProductionDeployCommands("alpha", {
        doctorReport: true,
      }),
      label: "alpha",
    });
    requireDocumentedCommandOrder({
      evidencePath,
      failures,
      commands: deploy.commands,
      path: `${path}.commands`,
      expected: documentedProductionDeployCommandOrder({
        doctorReport: true,
      }),
    });
  }

  const failureIds = new Set();
  for (const [index, item] of failuresSeen.entries()) {
    const path = `failures[${index}]`;
    if (!requireObject(item, path)) continue;
    requireString(item.id, `${path}.id`);
    const failureId = evidenceIdentityKey(item.id);
    if (failureId.length > 0) {
      if (failureIds.has(failureId)) {
        failures.push(`${evidencePath}: ${path}.id duplicates ${failureId}`);
      }
      failureIds.add(failureId);
    }
    requireString(item.flow, `${path}.flow`);
    requireString(item.classification, `${path}.classification`);
  }
  if (failuresSeen.length > 0) {
    const covered = failuresSeen.filter(
      (item) =>
        isJsonObject(item) &&
        (item.doctorDiagnostic === true ||
          (item.exactFixDocumented === true &&
            typeof item.troubleshootingEntry === "string" &&
            item.troubleshootingEntry.trim().length > 0)),
    ).length;
    if (covered / failuresSeen.length < 0.8) {
      failures.push(
        `${evidencePath}: at least 80% of alpha failures need a doctor diagnostic or troubleshooting entry with an exact fix`,
      );
    }
  }

  if (
    containsSensitiveEvidence(rawText) ||
    containsSensitiveEvidenceValue(value)
  ) {
    failures.push(
      `${evidencePath}: must not include raw secrets, tokens, cookies, emails, IPs, user agents, or Cloudflare API tokens`,
    );
  }
  if (containsPlaceholderAlphaEvidence(rawText)) {
    failures.push(
      `${evidencePath}: replace placeholder alpha participant values before public beta`,
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

function evidenceIdentityKey(value) {
  return typeof value === "string" ? value.trim() : "";
}

function requireCommandContains(commands, expected, path) {
  const commandList = Array.isArray(commands) ? commands : [];
  if (
    !commandList.some(
      (command) => typeof command === "string" && command.includes(expected),
    )
  ) {
    failures.push(`${evidencePath}: ${path} must include ${expected}`);
  }
}

function requireCommandIncludesAll(commands, expectedParts, path) {
  const commandList = Array.isArray(commands) ? commands : [];
  if (
    !commandList.some(
      (command) =>
        typeof command === "string" &&
        expectedParts.every((part) => command.includes(part)),
    )
  ) {
    failures.push(
      `${evidencePath}: ${path} must include a command containing ${expectedParts.join(
        ", ",
      )}`,
    );
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

function containsPlaceholderAlphaEvidence(text) {
  return /\balpha-user-\d+\b/iu.test(text);
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
