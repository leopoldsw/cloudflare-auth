import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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
let tracker;
try {
  tracker = JSON.parse(await readFile(trackerPath, "utf8"));
} catch {
  failures.push(`${trackerPath}: must be valid JSON`);
}

if (tracker) validateTracker(tracker);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`security release tracker verified: ${trackerPath}`);

function validateTracker(value) {
  if (value.schemaVersion !== 1) {
    failures.push(`${trackerPath}: schemaVersion must be 1`);
  }
  requireString(value.reviewedBy, "reviewedBy");
  requireDate(value.reviewedAt, "reviewedAt");

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
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    failures.push(`${trackerPath}: ${path} must be a non-empty string`);
  }
}

function requireDate(value, path) {
  requireString(value, path);
  if (typeof value === "string" && Number.isNaN(Date.parse(value))) {
    failures.push(`${trackerPath}: ${path} must be an ISO date string`);
  }
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
