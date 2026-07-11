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
  isPlaceholderRepositoryUrl,
  isReservedEvidenceHostname,
} from "./evidence-validation.mjs";
import {
  expectedGithubRepository,
  requireExactPackageNames,
  verifyGithubWorkflowRun,
} from "./github-evidence.mjs";
import { readReleasePackageState } from "./release-package-state.mjs";
import { isBetaPackageTag } from "./release-version-policy.mjs";
import {
  requiredAuthSmokeEndpoints,
  requireSmokedEndpointEvidence,
} from "./smoke-endpoints.mjs";

const evidencePath =
  process.env.CF_AUTH_BETA_EVIDENCE_PATH ?? "docs/beta-evidence.json";
const packageState = await readReleasePackageState();
const failures = [...packageState.failures];
const requireEvidence =
  process.env.CF_AUTH_REQUIRE_BETA_EVIDENCE === "1" || packageState.hasStable;

if (failures.length > 0) fail();

if (!(await exists(evidencePath))) {
  if (requireEvidence) {
    console.error(
      `${evidencePath}: public-beta evidence is required before stable 1.0.`,
    );
    process.exit(1);
  }
  console.log("public-beta evidence not required for current package versions");
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

let requiredSmokeEndpoints = [];
if (parsedEvidence) {
  if (isJsonObject(evidence)) {
    try {
      requiredSmokeEndpoints = await requiredAuthSmokeEndpoints(
        process.env.CF_AUTH_SMOKE_ENDPOINTS_SOURCE || undefined,
      );
    } catch (error) {
      failures.push(
        `${evidencePath}: could not derive smoke endpoints: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await validateEvidence(evidence, text);
  } else {
    failures.push(`${evidencePath}: top-level JSON value must be an object`);
  }
}

if (failures.length > 0) {
  fail();
}

console.log(`public-beta evidence verified: ${evidencePath}`);

async function validateEvidence(value, rawText) {
  if (value.schemaVersion !== 2) {
    failures.push(`${evidencePath}: schemaVersion must be 2`);
  }
  requireString(value.reviewedBy, "reviewedBy");
  rejectPlaceholderIdentity(value.reviewedBy, "reviewedBy");
  requireDate(value.reviewedAt, "reviewedAt");
  requireFreshDate(value.reviewedAt, "reviewedAt", 30);

  const expectedRepository = expectedGithubRepository();
  requireString(value.repository, "repository");
  if (!expectedRepository) {
    failures.push(
      `${evidencePath}: GITHUB_REPOSITORY or CF_AUTH_EXPECTED_REPOSITORY is required`,
    );
  } else if (value.repository !== expectedRepository) {
    failures.push(`${evidencePath}: repository must be ${expectedRepository}`);
  }
  requireExactPackageNames({
    actual: value.packageNames,
    expected: packageState.packages.map((pkg) => pkg.name),
    evidencePath,
    failures,
  });

  validatePublishedQuickstart(value.publishedQuickstart);
  validateManualQuickstart(value.manualQuickstart);
  validateProductionSmoke(value.productionSmoke);
  validateDeployButton(value.deployButton);
  requireMatchingPackageTags(value);

  if (expectedRepository) {
    await verifyGithubWorkflowRun({
      binding: value.publishedQuickstart,
      bindingPath: "publishedQuickstart",
      evidencePath,
      expectedRepository,
      expectedWorkflowPath: ".github/workflows/published-quickstart-smoke.yml",
      failures,
    });
    await verifyGithubWorkflowRun({
      binding: value.productionSmoke,
      bindingPath: "productionSmoke",
      evidencePath,
      expectedRepository,
      expectedWorkflowPath: ".github/workflows/cloudflare-production-smoke.yml",
      failures,
    });
  }

  if (
    containsSensitiveEvidence(rawText) ||
    containsSensitiveEvidenceValue(value)
  ) {
    failures.push(
      `${evidencePath}: must not include raw secrets, tokens, cookies, emails, IPs, user agents, or Cloudflare API tokens`,
    );
  }
  if (containsPlaceholderEvidence(rawText)) {
    failures.push(
      `${evidencePath}: replace placeholder maintainer, workflow, and origin values before stable 1.0`,
    );
  }
}

function validatePublishedQuickstart(value) {
  const path = "publishedQuickstart";
  if (!requireObject(value, path)) return;
  requireUrl(value.workflowRunUrl, `${path}.workflowRunUrl`);
  requireGithubActionsRunUrl(value.workflowRunUrl, `${path}.workflowRunUrl`);
  requireBetaPackageTag(value.packageTag, `${path}.packageTag`);
  if (value.passed !== true)
    failures.push(`${evidencePath}: ${path}.passed must be true`);
  for (const field of [
    "cleanDirectory",
    "documentedCommandsOnly",
    "noWorkspaceDependencies",
    "signupLoginVerified",
  ]) {
    if (value[field] !== true) {
      failures.push(`${evidencePath}: ${path}.${field} must be true`);
    }
  }
}

function validateManualQuickstart(value) {
  const path = "manualQuickstart";
  if (!requireObject(value, path)) return;
  requireString(value.maintainer, `${path}.maintainer`);
  rejectPlaceholderIdentity(value.maintainer, `${path}.maintainer`);
  requireDate(value.completedAt, `${path}.completedAt`);
  requireBetaPackageTag(value.packageTag, `${path}.packageTag`);
  for (const field of [
    "cleanDirectory",
    "documentedCommandsOnly",
    "signupLoginVerified",
  ]) {
    if (value[field] !== true) {
      failures.push(`${evidencePath}: ${path}.${field} must be true`);
    }
  }
  requireCommandContains(value.commands, "cf-auth init", `${path}.commands`);
  requireCommandContains(value.commands, "cd my-app", `${path}.commands`);
  requireCommandContains(value.commands, "pnpm install", `${path}.commands`);
  requireCommandContains(
    value.commands,
    "cf-auth migrate --local",
    `${path}.commands`,
  );
  requireCommandContains(value.commands, "npm run dev", `${path}.commands`);
  if (typeof value.packageTag === "string") {
    requireCommandContains(
      value.commands,
      `@cf-auth/cli@${value.packageTag}`,
      `${path}.commands`,
    );
    requireOnlyDocumentedCommands({
      evidencePath,
      failures,
      commands: value.commands,
      path: `${path}.commands`,
      allowedPatterns: documentedLocalSetupCommands(value.packageTag),
      label: "public-beta quickstart",
    });
    requireDocumentedCommandOrder({
      evidencePath,
      failures,
      commands: value.commands,
      path: `${path}.commands`,
      expected: documentedLocalSetupCommandOrder(),
    });
  }
}

function validateProductionSmoke(value) {
  const path = "productionSmoke";
  if (!requireObject(value, path)) return;
  requireUrl(value.workflowRunUrl, `${path}.workflowRunUrl`);
  requireGithubActionsRunUrl(value.workflowRunUrl, `${path}.workflowRunUrl`);
  requireBetaPackageTag(value.packageTag, `${path}.packageTag`);
  requireOrigin(value.origin, `${path}.origin`);
  if (value.passed !== true)
    failures.push(`${evidencePath}: ${path}.passed must be true`);
  for (const field of [
    "documentedProductionPath",
    "optInCloudflareAccountFixture",
  ]) {
    if (value[field] !== true) {
      failures.push(`${evidencePath}: ${path}.${field} must be true`);
    }
  }
  requireCommandContains(
    value.commands,
    "cf-auth doctor --env production",
    `${path}.commands`,
  );
  requireCommandContains(
    value.commands,
    "cf-auth migrate --remote --env production",
    `${path}.commands`,
  );
  requireCommandContains(
    value.commands,
    "cf-auth deploy --env production",
    `${path}.commands`,
  );
  if (typeof value.packageTag === "string") {
    requireCommandContains(
      value.commands,
      `@cf-auth/cli@${value.packageTag}`,
      `${path}.commands`,
    );
    requireOnlyDocumentedCommands({
      evidencePath,
      failures,
      commands: value.commands,
      path: `${path}.commands`,
      allowedPatterns: documentedProductionDeployCommands(value.packageTag, {
        doctorReport: false,
      }),
      label: "public-beta production smoke",
    });
    requireDocumentedCommandOrder({
      evidencePath,
      failures,
      commands: value.commands,
      path: `${path}.commands`,
      expected: documentedProductionDeployCommandOrder({
        doctorReport: false,
      }),
    });
  }
  const smokedEndpoints = requireSmokedEndpointEvidence({
    evidencePath,
    failures,
    value: value.smokedEndpoints,
    path: `${path}.smokedEndpoints`,
  });
  for (const endpoint of requiredSmokeEndpoints) {
    if (!smokedEndpoints.includes(endpoint)) {
      failures.push(
        `${evidencePath}: ${path}.smokedEndpoints must include ${endpoint}`,
      );
    }
  }
}

function validateDeployButton(value) {
  const path = "deployButton";
  if (!requireObject(value, path)) return;
  requireString(value.evidencePath, `${path}.evidencePath`);
  if (value.evidencePath !== "docs/deploy-button-evidence.json") {
    failures.push(
      `${evidencePath}: ${path}.evidencePath must be docs/deploy-button-evidence.json`,
    );
  }
  if (value.verified !== true) {
    failures.push(`${evidencePath}: ${path}.verified must be true`);
  }
  if (value.evidenceVerifierPassed !== true) {
    failures.push(
      `${evidencePath}: ${path}.evidenceVerifierPassed must be true`,
    );
  }
}

function requireMatchingPackageTags(value) {
  const entries = [
    ["publishedQuickstart.packageTag", value.publishedQuickstart?.packageTag],
    ["manualQuickstart.packageTag", value.manualQuickstart?.packageTag],
    ["productionSmoke.packageTag", value.productionSmoke?.packageTag],
  ].filter((entry) => typeof entry[1] === "string");
  const tags = new Set(entries.map((entry) => entry[1]));
  if (tags.size > 1) {
    failures.push(
      `${evidencePath}: packageTag values must match across published quickstart, manual quickstart, and production smoke evidence (${entries
        .map(([path, tag]) => `${path}=${tag}`)
        .join(", ")})`,
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

function requireBetaPackageTag(value, path) {
  requireString(value, path);
  if (typeof value !== "string") return;
  if (isBetaPackageTag(value)) {
    return;
  }
  failures.push(`${evidencePath}: ${path} must be beta or a beta prerelease`);
}

function requireDate(value, path) {
  requireString(value, path);
  if (typeof value === "string" && !isIsoDateString(value)) {
    failures.push(`${evidencePath}: ${path} must be an ISO date string`);
  } else if (typeof value === "string" && isFutureIsoDateString(value)) {
    failures.push(`${evidencePath}: ${path} must not be in the future`);
  }
}

function requireFreshDate(value, path, maxAgeDays) {
  if (typeof value !== "string" || !isIsoDateString(value)) return;
  const configuredNow = process.env.CF_AUTH_EVIDENCE_NOW;
  const nowMs = configuredNow ? Date.parse(configuredNow) : Date.now();
  if (
    Number.isNaN(nowMs) ||
    nowMs - Date.parse(value) > maxAgeDays * 24 * 60 * 60 * 1000
  ) {
    failures.push(
      `${evidencePath}: ${path} must be no more than ${maxAgeDays} days old`,
    );
  }
}

function requireUrl(value, path) {
  requireString(value, path);
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      failures.push(`${evidencePath}: ${path} must be an http(s) URL`);
    }
  } catch {
    failures.push(`${evidencePath}: ${path} must be a valid URL`);
  }
}

function requireGithubActionsRunUrl(value, path) {
  if (typeof value !== "string") return;
  let url;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !/^\/[^/]+\/[^/]+\/actions\/runs\/[1-9]\d*$/u.test(url.pathname)
  ) {
    failures.push(
      `${evidencePath}: ${path} must be an https GitHub Actions run URL`,
    );
  } else if (url.username || url.password || url.search || url.hash) {
    failures.push(
      `${evidencePath}: ${path} must be an exact GitHub Actions run URL without credentials, query, or fragment`,
    );
  } else if (isPlaceholderRepositoryUrl(value)) {
    failures.push(
      `${evidencePath}: ${path} must not use a placeholder GitHub repository`,
    );
  }
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

function requireOrigin(value, path) {
  requireString(value, path);
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (value !== url.origin || url.protocol !== "https:") {
      failures.push(`${evidencePath}: ${path} must be an exact https origin`);
    } else if (isReservedEvidenceHostname(url.hostname)) {
      failures.push(
        `${evidencePath}: ${path} must not use a reserved or example origin`,
      );
    }
  } catch {
    failures.push(`${evidencePath}: ${path} must be a valid URL origin`);
  }
}

function containsPlaceholderEvidence(text) {
  return (
    /\bmaintainer-name\b/u.test(text) ||
    /\brelease-reviewer\b/iu.test(text) ||
    /\bOWNER\b|\bREPO\b/u.test(text) ||
    /github\.com\/(?:acme|example)\//iu.test(text) ||
    /\/actions\/runs\/0+\b/u.test(text) ||
    /https?:\/\/[^\s"']*(?:example\.(?:com|net|org)|\.example|\.invalid|\.test|\.localhost|localhost)\b/iu.test(
      text,
    )
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
