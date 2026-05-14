import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  containsIpLiteral,
  containsRawUserAgent,
} from "./evidence-redaction.mjs";
import {
  isFutureIsoDateString,
  isIsoDateString,
} from "./evidence-validation.mjs";

const trackerPath =
  process.env.CF_AUTH_SECURITY_TRACKER_PATH ??
  "docs/security-release-tracker.json";
const requireTracker =
  process.env.CF_AUTH_REQUIRE_SECURITY_TRACKER === "1" ||
  (await hasStablePackageVersions());

if (!(await exists(trackerPath))) {
  if (requireTracker) {
    console.error(
      `${trackerPath}: security release tracker is required before stable 1.0.`,
    );
    process.exit(1);
  }
  console.log(
    "security release tracker not required for current package versions",
  );
  process.exit(0);
}

const failures = [];
let text = "";
let tracker;
try {
  text = await readFile(trackerPath, "utf8");
  tracker = JSON.parse(text);
} catch {
  failures.push(`${trackerPath}: must be valid JSON`);
}

if (tracker) validateTracker(tracker, text);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`security release tracker verified: ${trackerPath}`);

function validateTracker(value, rawText) {
  if (value.schemaVersion !== 1) {
    failures.push(`${trackerPath}: schemaVersion must be 1`);
  }
  requireString(value.reviewedBy, "reviewedBy");
  requireDate(value.reviewedAt, "reviewedAt");
  requireUrl(value.issueSearchUrl, "issueSearchUrl");
  requireIssueSearchUrl(value.issueSearchUrl);
  requireUrl(value.advisorySearchUrl, "advisorySearchUrl");
  requireAdvisorySearchUrl(value.advisorySearchUrl);
  const issueRepo = githubRepoForIssueSearch(value.issueSearchUrl);
  const advisoryRepo = githubRepoForAdvisorySearch(value.advisorySearchUrl);
  if (issueRepo && advisoryRepo && issueRepo !== advisoryRepo) {
    failures.push(
      `${trackerPath}: issueSearchUrl and advisorySearchUrl must target the same GitHub repository`,
    );
  }

  const openIssues = Array.isArray(value.openHighCriticalAuthSecurityIssues)
    ? value.openHighCriticalAuthSecurityIssues
    : [];
  if (openIssues.length > 0) {
    failures.push(
      `${trackerPath}: openHighCriticalAuthSecurityIssues must be empty before stable 1.0`,
    );
  }

  const advisories = Array.isArray(value.advisories) ? value.advisories : [];
  for (const [index, advisory] of advisories.entries()) {
    const path = `advisories[${index}]`;
    requireString(advisory.id, `${path}.id`);
    requireString(advisory.severity, `${path}.severity`);
    requireString(advisory.status, `${path}.status`);
    if (
      ["high", "critical"].includes(String(advisory.severity).toLowerCase()) &&
      String(advisory.status).toLowerCase() !== "resolved"
    ) {
      failures.push(
        `${trackerPath}: ${path} is high/critical and must be resolved before stable 1.0`,
      );
    }
  }

  if (containsPlaceholderEvidence(rawText)) {
    failures.push(
      `${trackerPath}: replace placeholder reviewer or advisory values before stable 1.0`,
    );
  }
  if (containsSensitiveEvidence(rawText)) {
    failures.push(
      `${trackerPath}: must not include raw secrets, tokens, cookies, emails, IPs, user agents, or Cloudflare API tokens`,
    );
  }
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${trackerPath}: ${path} must be a non-empty string`);
  }
}

function requireDate(value, path) {
  requireString(value, path);
  if (typeof value === "string" && !isIsoDateString(value)) {
    failures.push(`${trackerPath}: ${path} must be an ISO date string`);
  } else if (typeof value === "string" && isFutureIsoDateString(value)) {
    failures.push(`${trackerPath}: ${path} must not be in the future`);
  }
}

function requireUrl(value, path) {
  requireString(value, path);
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      failures.push(`${trackerPath}: ${path} must be an http(s) URL`);
    }
  } catch {
    failures.push(`${trackerPath}: ${path} must be a valid URL`);
  }
}

function requireIssueSearchUrl(value) {
  if (typeof value !== "string") return;
  let url;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.hostname !== "github.com" || !githubRepoForIssueSearch(value)) {
    failures.push(
      `${trackerPath}: issueSearchUrl must be a GitHub repository issues search URL`,
    );
    return;
  }
  const query = (url.searchParams.get("q") ?? "").toLowerCase();
  const requiredTerms = ["is:issue", "is:open", "auth", "high", "critical"];
  if (!requiredTerms.every((term) => query.includes(term))) {
    failures.push(
      `${trackerPath}: issueSearchUrl must search open high/critical auth issues`,
    );
  }
}

function requireAdvisorySearchUrl(value) {
  if (typeof value !== "string") return;
  let url;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (url.hostname !== "github.com" || !githubRepoForAdvisorySearch(value)) {
    failures.push(
      `${trackerPath}: advisorySearchUrl must be a GitHub repository security advisory URL`,
    );
  }
}

function githubRepoForIssueSearch(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    url.hostname !== "github.com" ||
    segments.length !== 3 ||
    segments[2] !== "issues"
  ) {
    return null;
  }
  return `${segments[0]}/${segments[1]}`;
}

function githubRepoForAdvisorySearch(value) {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    url.hostname !== "github.com" ||
    segments.length !== 4 ||
    segments[2] !== "security" ||
    segments[3] !== "advisories"
  ) {
    return null;
  }
  return `${segments[0]}/${segments[1]}`;
}

function containsPlaceholderEvidence(text) {
  return /\bmaintainer-name\b|\bGHSA-example\b|\bOWNER\b|\bREPO\b/u.test(text);
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
