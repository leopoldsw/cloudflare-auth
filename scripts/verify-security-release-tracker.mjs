import { access, readFile } from "node:fs/promises";

import {
  containsSensitiveEvidence,
  containsSensitiveEvidenceValue,
} from "./evidence-redaction.mjs";
import {
  isFutureIsoDateString,
  isIsoDateString,
  isJsonObject,
  isPlaceholderEvidenceIdentity,
  isPlaceholderRepositoryUrl,
} from "./evidence-validation.mjs";
import {
  expectedGithubRepository,
  requireExactPackageNames,
  verifyGithubSecurityState,
  verifyGithubWorkflowRun,
} from "./github-evidence.mjs";
import { readReleasePackageState } from "./release-package-state.mjs";

const trackerPath =
  process.env.CF_AUTH_SECURITY_TRACKER_PATH ??
  "docs/security-release-tracker.json";
const packageState = await readReleasePackageState();
const failures = [...packageState.failures];
const requireTracker =
  process.env.CF_AUTH_REQUIRE_SECURITY_TRACKER === "1" ||
  packageState.hasStable;
const advisorySeverities = new Set(["low", "moderate", "high", "critical"]);
const advisoryStatuses = new Set(["open", "resolved"]);

if (failures.length > 0) fail();

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

let text = "";
let tracker;
let parsedTracker = false;
try {
  text = await readFile(trackerPath, "utf8");
  tracker = JSON.parse(text);
  parsedTracker = true;
} catch {
  failures.push(`${trackerPath}: must be valid JSON`);
}

if (parsedTracker) {
  if (isJsonObject(tracker)) {
    await validateTracker(tracker, text);
  } else {
    failures.push(`${trackerPath}: top-level JSON value must be an object`);
  }
}

if (failures.length > 0) {
  fail();
}

console.log(`security release tracker verified: ${trackerPath}`);

async function validateTracker(value, rawText) {
  if (value.schemaVersion !== 2) {
    failures.push(`${trackerPath}: schemaVersion must be 2`);
  }
  requireString(value.reviewedBy, "reviewedBy");
  rejectPlaceholderIdentity(value.reviewedBy, "reviewedBy");
  requireDate(value.reviewedAt, "reviewedAt");
  requireFreshDate(value.reviewedAt, "reviewedAt", 7);
  const expectedRepository = expectedGithubRepository();
  requireString(value.repository, "repository");
  if (!expectedRepository) {
    failures.push(
      `${trackerPath}: GITHUB_REPOSITORY or CF_AUTH_EXPECTED_REPOSITORY is required`,
    );
  } else if (value.repository !== expectedRepository) {
    failures.push(`${trackerPath}: repository must be ${expectedRepository}`);
  }
  requireExactPackageNames({
    actual: value.packageNames,
    expected: packageState.packages.map((pkg) => pkg.name),
    evidencePath: trackerPath,
    failures,
  });
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
  if (
    expectedRepository &&
    (issueRepo !== expectedRepository || advisoryRepo !== expectedRepository)
  ) {
    failures.push(
      `${trackerPath}: issueSearchUrl and advisorySearchUrl must target ${expectedRepository}`,
    );
  }

  if (!Array.isArray(value.openHighCriticalAuthSecurityIssues)) {
    failures.push(
      `${trackerPath}: openHighCriticalAuthSecurityIssues must be an array`,
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

  if (!Array.isArray(value.advisories)) {
    failures.push(`${trackerPath}: advisories must be an array`);
  }
  const advisories = Array.isArray(value.advisories) ? value.advisories : [];
  const advisoryIds = new Set();
  for (const [index, advisory] of advisories.entries()) {
    const path = `advisories[${index}]`;
    if (!requireObject(advisory, path)) continue;
    requireString(advisory.id, `${path}.id`);
    const advisoryId =
      typeof advisory.id === "string" ? advisory.id.trim() : "";
    if (advisoryId.length > 0) {
      if (advisoryIds.has(advisoryId)) {
        failures.push(`${trackerPath}: ${path}.id duplicates ${advisoryId}`);
      }
      advisoryIds.add(advisoryId);
    }
    requireString(advisory.severity, `${path}.severity`);
    requireString(advisory.status, `${path}.status`);
    const severity =
      typeof advisory.severity === "string"
        ? advisory.severity.trim().toLowerCase()
        : "";
    const status =
      typeof advisory.status === "string"
        ? advisory.status.trim().toLowerCase()
        : "";
    if (severity.length > 0 && !advisorySeverities.has(severity)) {
      failures.push(
        `${trackerPath}: ${path}.severity must be low, moderate, high, or critical`,
      );
    }
    if (status.length > 0 && !advisoryStatuses.has(status)) {
      failures.push(`${trackerPath}: ${path}.status must be open or resolved`);
    }
    if (["high", "critical"].includes(severity) && status !== "resolved") {
      failures.push(
        `${trackerPath}: ${path} is high/critical and must be resolved before stable 1.0`,
      );
    }
  }

  if (expectedRepository) {
    await verifyGithubWorkflowRun({
      binding: value.reviewWorkflow,
      bindingPath: "reviewWorkflow",
      evidencePath: trackerPath,
      expectedRepository,
      expectedWorkflowPath: ".github/workflows/codeql.yml",
      failures,
    });
    await verifyGithubSecurityState({
      issueSearchUrl: value.issueSearchUrl,
      repository: expectedRepository,
      advisories,
      evidencePath: trackerPath,
      failures,
    });
  }

  if (containsPlaceholderEvidence(rawText)) {
    failures.push(
      `${trackerPath}: replace placeholder reviewer or advisory values before stable 1.0`,
    );
  }
  if (
    containsSensitiveEvidence(rawText) ||
    containsSensitiveEvidenceValue(value)
  ) {
    failures.push(
      `${trackerPath}: must not include raw secrets, tokens, cookies, emails, IPs, user agents, or Cloudflare API tokens`,
    );
  }
}

function requireObject(value, path) {
  if (!isJsonObject(value)) {
    failures.push(`${trackerPath}: ${path} must be an object`);
    return false;
  }
  return true;
}

function requireString(value, path) {
  if (typeof value !== "string" || value.trim().length === 0) {
    failures.push(`${trackerPath}: ${path} must be a non-empty string`);
  }
}

function rejectPlaceholderIdentity(value, path) {
  if (typeof value === "string" && isPlaceholderEvidenceIdentity(value)) {
    failures.push(`${trackerPath}: ${path} must not be a placeholder identity`);
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

function requireFreshDate(value, path, maxAgeDays) {
  if (typeof value !== "string" || !isIsoDateString(value)) return;
  const configuredNow = process.env.CF_AUTH_EVIDENCE_NOW;
  const nowMs = configuredNow ? Date.parse(configuredNow) : Date.now();
  if (
    Number.isNaN(nowMs) ||
    nowMs - Date.parse(value) > maxAgeDays * 24 * 60 * 60 * 1000
  ) {
    failures.push(
      `${trackerPath}: ${path} must be no more than ${maxAgeDays} days old`,
    );
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
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    !githubRepoForIssueSearch(value)
  ) {
    failures.push(
      `${trackerPath}: issueSearchUrl must be an https GitHub repository issues search URL`,
    );
    return;
  }
  if (url.username || url.password || url.hash) {
    failures.push(
      `${trackerPath}: issueSearchUrl must not include URL credentials or fragments`,
    );
  }
  if (isPlaceholderRepositoryUrl(value)) {
    failures.push(
      `${trackerPath}: issueSearchUrl must not use a placeholder GitHub repository`,
    );
  }
  const query = (url.searchParams.get("q") ?? "").toLowerCase();
  const terms = query.split(/\s+/u).filter(Boolean);
  const labels = labelSearchTerms(terms);
  const hasAuthLabel = labels.some((values) => values.includes("auth"));
  const hasHighCriticalLabel = labels.some(
    (values) => values.includes("high") && values.includes("critical"),
  );
  if (
    !terms.includes("is:issue") ||
    !terms.includes("is:open") ||
    !hasAuthLabel ||
    !hasHighCriticalLabel
  ) {
    failures.push(
      `${trackerPath}: issueSearchUrl must search open high/critical auth issues with explicit labels`,
    );
  }
}

function labelSearchTerms(terms) {
  return terms
    .map((term) => {
      const match = term.match(/^labels?:(.+)$/u);
      if (!match) return [];
      return match[1]
        .split(",")
        .map((value) => value.replace(/^["']|["']$/gu, "").trim())
        .filter(Boolean);
    })
    .filter((values) => values.length > 0);
}

function requireAdvisorySearchUrl(value) {
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
    !githubRepoForAdvisorySearch(value)
  ) {
    failures.push(
      `${trackerPath}: advisorySearchUrl must be an https GitHub repository security advisory URL`,
    );
  } else if (url.username || url.password || url.search || url.hash) {
    failures.push(
      `${trackerPath}: advisorySearchUrl must be an exact GitHub repository security advisory URL without credentials, query, or fragment`,
    );
  } else if (isPlaceholderRepositoryUrl(value)) {
    failures.push(
      `${trackerPath}: advisorySearchUrl must not use a placeholder GitHub repository`,
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
  return (
    /\bmaintainer-name\b|\bGHSA-example\b|\bOWNER\b|\bREPO\b/u.test(text) ||
    /\brelease-reviewer\b/iu.test(text) ||
    /github\.com\/(?:acme|example)\//iu.test(text)
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
