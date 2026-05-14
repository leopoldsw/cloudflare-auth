import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  containsIpLiteral,
  containsRawSecretMaterial,
  containsRawUserAgent,
} from "./evidence-redaction.mjs";
import {
  isFutureIsoDateString,
  isIsoDateString,
} from "./evidence-validation.mjs";

const evidencePath =
  process.env.CF_AUTH_DEPLOY_BUTTON_EVIDENCE_PATH ??
  "docs/deploy-button-evidence.json";
const requireEvidence =
  process.env.CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE === "1" ||
  (await hasBetaOrStablePackageVersions());

if (!(await exists(evidencePath))) {
  if (requireEvidence) {
    console.error(
      `${evidencePath}: Deploy to Cloudflare button evidence is required before public beta or stable release.`,
    );
    process.exit(1);
  }
  console.log(
    "Deploy to Cloudflare button evidence not required for current package versions",
  );
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

console.log(`Deploy to Cloudflare button evidence verified: ${evidencePath}`);

function validateEvidence(value, rawText) {
  if (value.schemaVersion !== 1) {
    failures.push(`${evidencePath}: schemaVersion must be 1`);
  }
  requireString(value.verifiedBy, "verifiedBy");
  requireDate(value.verifiedAt, "verifiedAt");
  if (value.status !== "verified") {
    failures.push(
      `${evidencePath}: status must be verified before public beta`,
    );
  }

  requireUrl(value.templateRepositoryUrl, "templateRepositoryUrl");
  requireTemplateRepositoryUrl(
    value.templateRepositoryUrl,
    "templateRepositoryUrl",
  );
  requireUrl(value.deployButtonUrl, "deployButtonUrl");
  requireBetaPackageTag(value.packageTag, "packageTag");
  requireDeployButtonUrl(
    value.templateRepositoryUrl,
    value.deployButtonUrl,
    "deployButtonUrl",
  );
  requireOrigin(value.deployedOrigin, "deployedOrigin");

  for (const field of [
    "starterTemplateCreated",
    "templateRepositoryPublic",
    "templateHasNoWorkspaceDependencies",
    "d1BindingConfigured",
    "migrationsApplied",
    "authSecretConfigured",
    "publicOriginConfigured",
    "documentedPathFollowed",
    "signupLoginSmokePassed",
  ]) {
    if (value[field] !== true) {
      failures.push(`${evidencePath}: ${field} must be true`);
    }
  }

  const smokedEndpoints = Array.isArray(value.smokedEndpoints)
    ? value.smokedEndpoints
    : [];
  for (const endpoint of [
    "/auth/signup",
    "/auth/login",
    "/auth/logout",
    "/auth/user",
  ]) {
    if (!smokedEndpoints.includes(endpoint)) {
      failures.push(
        `${evidencePath}: smokedEndpoints must include ${endpoint}`,
      );
    }
  }

  if (containsSensitiveEvidence(rawText)) {
    failures.push(
      `${evidencePath}: must not include raw secrets, tokens, cookies, emails, IPs, user agents, or Cloudflare API tokens`,
    );
  }
  if (containsPlaceholderEvidence(rawText)) {
    failures.push(
      `${evidencePath}: replace placeholder repository and origin values before public beta`,
    );
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
  if (typeof value === "string" && !isIsoDateString(value)) {
    failures.push(`${evidencePath}: ${path} must be an ISO date string`);
  } else if (typeof value === "string" && isFutureIsoDateString(value)) {
    failures.push(`${evidencePath}: ${path} must not be in the future`);
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

function requireTemplateRepositoryUrl(value, path) {
  if (typeof value !== "string") return;
  let url;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const isGithubRepository =
    url.hostname === "github.com" && segments.length === 2;
  const isGitlabRepository =
    url.hostname === "gitlab.com" && segments.length >= 2;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (!isGithubRepository && !isGitlabRepository)
  ) {
    failures.push(
      `${evidencePath}: ${path} must be an exact public GitHub or GitLab repository URL`,
    );
  }
}

function requireDeployButtonUrl(templateRepositoryUrl, deployButtonUrl, path) {
  if (
    typeof templateRepositoryUrl !== "string" ||
    typeof deployButtonUrl !== "string"
  ) {
    return;
  }
  let parsedDeployButtonUrl;
  try {
    parsedDeployButtonUrl = new URL(deployButtonUrl);
  } catch {
    return;
  }
  if (
    parsedDeployButtonUrl.protocol !== "https:" ||
    parsedDeployButtonUrl.hostname !== "deploy.workers.cloudflare.com" ||
    parsedDeployButtonUrl.pathname !== "/"
  ) {
    failures.push(
      `${evidencePath}: ${path} must target https://deploy.workers.cloudflare.com/`,
    );
  }
  const params = [...parsedDeployButtonUrl.searchParams.keys()];
  if (params.length !== 1 || params[0] !== "url") {
    failures.push(
      `${evidencePath}: ${path} must contain only the url parameter`,
    );
  }
  if (parsedDeployButtonUrl.searchParams.get("url") !== templateRepositoryUrl) {
    failures.push(
      `${evidencePath}: deployButtonUrl url parameter must match templateRepositoryUrl`,
    );
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
    containsRawSecretMaterial(text) ||
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
  return /\bOWNER\b|\bREPO\b|https:\/\/example\.com\b/u.test(text);
}

async function hasBetaOrStablePackageVersions() {
  const packages = await readdir("packages", { withFileTypes: true });
  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const pkg = JSON.parse(
      await readFile(join("packages", entry.name, "package.json"), "utf8"),
    );
    if (!pkg.private && typeof pkg.version === "string") {
      if (isPublicBeta(pkg.version) || isStableOneOrLater(pkg.version)) {
        return true;
      }
    }
  }
  return false;
}

function isPublicBeta(version) {
  return /^\d+\.\d+\.\d+-beta(?:[.-].*)?$/u.test(version);
}

function isStableOneOrLater(version) {
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
