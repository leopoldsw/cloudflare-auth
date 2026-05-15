import { access, readFile } from "node:fs/promises";

import { containsSensitiveEvidence } from "./evidence-redaction.mjs";
import {
  isFutureIsoDateString,
  isIsoDateString,
  isJsonObject,
  isPlaceholderEvidenceIdentity,
  isPlaceholderRepositoryUrl,
  isReservedEvidenceHostname,
} from "./evidence-validation.mjs";
import { readReleasePackageState } from "./release-package-state.mjs";
import { isBetaPackageTag } from "./release-version-policy.mjs";
import {
  requiredAuthSmokeEndpoints,
  requireSmokedEndpointEvidence,
} from "./smoke-endpoints.mjs";

const evidencePath =
  process.env.CF_AUTH_DEPLOY_BUTTON_EVIDENCE_PATH ??
  "docs/deploy-button-evidence.json";
const packageState = await readReleasePackageState();
const failures = [...packageState.failures];
const requireEvidence =
  process.env.CF_AUTH_REQUIRE_DEPLOY_BUTTON_EVIDENCE === "1" ||
  packageState.hasBetaOrStable;

if (failures.length > 0) fail();

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
    validateEvidence(evidence, text);
  } else {
    failures.push(`${evidencePath}: top-level JSON value must be an object`);
  }
}

if (failures.length > 0) {
  fail();
}

console.log(`Deploy to Cloudflare button evidence verified: ${evidencePath}`);

function validateEvidence(value, rawText) {
  if (value.schemaVersion !== 1) {
    failures.push(`${evidencePath}: schemaVersion must be 1`);
  }
  requireString(value.verifiedBy, "verifiedBy");
  rejectPlaceholderIdentity(value.verifiedBy, "verifiedBy");
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
    "emailBindingConfigured",
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

  const smokedEndpoints = requireSmokedEndpointEvidence({
    evidencePath,
    failures,
    value: value.smokedEndpoints,
    path: "smokedEndpoints",
  });
  for (const endpoint of requiredSmokeEndpoints) {
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
  } else if (isPlaceholderRepositoryUrl(value)) {
    failures.push(
      `${evidencePath}: ${path} must not use a placeholder repository owner or name`,
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
  if (
    parsedDeployButtonUrl.username ||
    parsedDeployButtonUrl.password ||
    parsedDeployButtonUrl.hash
  ) {
    failures.push(
      `${evidencePath}: ${path} must not include URL credentials or fragments`,
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
    /\bOWNER\b|\bREPO\b/u.test(text) ||
    /\bmaintainer-name\b|\brelease-reviewer\b/iu.test(text) ||
    /github\.com\/(?:acme|example)\//iu.test(text) ||
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
