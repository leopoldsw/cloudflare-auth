import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  containsIpLiteral,
  containsRawUserAgent,
} from "./evidence-redaction.mjs";

const evidencePath =
  process.env.CF_AUTH_BETA_EVIDENCE_PATH ?? "docs/beta-evidence.json";
const requireEvidence =
  process.env.CF_AUTH_REQUIRE_BETA_EVIDENCE === "1" ||
  (await hasStablePackageVersions());

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

console.log(`public-beta evidence verified: ${evidencePath}`);

function validateEvidence(value, rawText) {
  if (value.schemaVersion !== 1) {
    failures.push(`${evidencePath}: schemaVersion must be 1`);
  }
  requireString(value.reviewedBy, "reviewedBy");
  requireDate(value.reviewedAt, "reviewedAt");

  validatePublishedQuickstart(value.publishedQuickstart);
  validateManualQuickstart(value.manualQuickstart);
  validateProductionSmoke(value.productionSmoke);
  validateDeployButton(value.deployButton);

  if (containsSensitiveEvidence(rawText)) {
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
  requireObject(value, path);
  if (!value) return;
  requireUrl(value.workflowRunUrl, `${path}.workflowRunUrl`);
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
  requireObject(value, path);
  if (!value) return;
  requireString(value.maintainer, `${path}.maintainer`);
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
}

function validateProductionSmoke(value) {
  const path = "productionSmoke";
  requireObject(value, path);
  if (!value) return;
  requireUrl(value.workflowRunUrl, `${path}.workflowRunUrl`);
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
  for (const endpoint of [
    "/auth/signup",
    "/auth/login",
    "/auth/logout",
    "/auth/user",
  ]) {
    const smokedEndpoints = Array.isArray(value.smokedEndpoints)
      ? value.smokedEndpoints
      : [];
    if (!smokedEndpoints.includes(endpoint)) {
      failures.push(
        `${evidencePath}: ${path}.smokedEndpoints must include ${endpoint}`,
      );
    }
  }
}

function validateDeployButton(value) {
  const path = "deployButton";
  requireObject(value, path);
  if (!value) return;
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

function requireObject(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${evidencePath}: ${path} must be an object`);
  }
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${evidencePath}: ${path} must be a non-empty string`);
  }
}

function requireBetaPackageTag(value, path) {
  requireString(value, path);
  if (typeof value !== "string") return;
  if (value === "beta" || /^\d+\.\d+\.\d+-beta(?:[.-].*)?$/u.test(value)) {
    return;
  }
  failures.push(`${evidencePath}: ${path} must be beta or a beta prerelease`);
}

function requireDate(value, path) {
  requireString(value, path);
  if (typeof value === "string" && Number.isNaN(Date.parse(value))) {
    failures.push(`${evidencePath}: ${path} must be an ISO date string`);
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
    }
  } catch {
    failures.push(`${evidencePath}: ${path} must be a valid URL origin`);
  }
}

function containsSensitiveEvidence(text) {
  return (
    /\bAUTH_SECRET\s*=/u.test(text) ||
    /\b(?:CLOUDFLARE_API_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN)\b/u.test(text) ||
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
  return (
    /\bmaintainer-name\b/u.test(text) ||
    /\bOWNER\b|\bREPO\b/u.test(text) ||
    /\/actions\/runs\/0+\b/u.test(text) ||
    /https:\/\/example\.com\b/u.test(text)
  );
}

async function hasStablePackageVersions() {
  const packages = await readdir("packages", { withFileTypes: true });
  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const pkg = JSON.parse(
      await readFile(join("packages", entry.name, "package.json"), "utf8"),
    );
    if (!pkg.private && isStableOneOrLater(pkg.version)) return true;
  }
  return false;
}

function isStableOneOrLater(version) {
  if (typeof version !== "string") return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/);
  if (!match || version.includes("-")) return false;
  return Number(match[1]) >= 1;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
