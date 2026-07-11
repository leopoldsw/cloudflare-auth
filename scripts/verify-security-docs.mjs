import { access, readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import ts from "@typescript/typescript6";

const docs = {
  metrics: await readFile("docs/metrics.md", "utf8"),
  rateLimiting: await readFile("docs/rate-limiting.md", "utf8"),
  securityModel: await readFile("docs/security-model.md", "utf8"),
  securityPolicy: await readFile("SECURITY.md", "utf8"),
  turnstile: await readFile("docs/turnstile.md", "utf8"),
};
const failures = [];

const threatRows = [
  "Account enumeration",
  "Credential stuffing",
  "Brute-force login",
  "Reset email abuse",
  "Magic-link abuse",
  "Email link scanners",
  "Token replay",
  "Token leakage",
  "Open redirects",
  "CSRF",
  "Session theft",
  "Session fixation",
  "D1 consistency/concurrency",
  "Email delivery failure",
  "Secret rotation",
  "Permissive CORS middleware",
  "Raw PII in logs",
  "Bot pressure",
  "Edge floods",
  "Operational blind spots",
];

for (const threat of threatRows) {
  const row = docs.securityModel
    .split("\n")
    .find((line) => line.startsWith("|") && line.includes(`| ${threat}`));
  if (!row) {
    failures.push(`docs/security-model.md: missing threat row ${threat}`);
    continue;
  }
  if (!row.includes("(../tests/")) {
    failures.push(
      `docs/security-model.md: ${threat} row must link to regression test evidence`,
    );
  } else {
    await requireLinkedEvidenceExists(row, threat);
  }
}

for (const text of [
  "Supported Versions",
  "Reporting A Vulnerability",
  "Expected Response Window",
  "secret scanning",
  "push protection",
  "advisory evidence only",
]) {
  requireText("SECURITY.md", docs.securityPolicy, text);
}

for (const text of [
  "Optional Turnstile checks before account-specific branching",
  "Optional Cloudflare rate-limit binding before D1 counters",
  "scrub browser history",
  "Known residual risks",
]) {
  requireText("docs/security-model.md", docs.securityModel, text);
}

for (const text of [
  'mode: "required"',
  "before schema validation, account lookup, token lookup, token consume, or password hashing",
  "tests/security-hardening.test.ts",
  "transport errors and malformed responses are treated as failed challenges",
]) {
  requireText("docs/turnstile.md", docs.turnstile, text);
}
for (const endpoint of await turnstileEndpointNames()) {
  requireText("docs/turnstile.md", docs.turnstile, endpoint);
}

for (const text of [
  "AUTH_RATE_LIMITER",
  "D1 remains authoritative",
  "fails open to the D1 limiter",
  "Cloudflare Rate Limiting API prefilter",
  "WAF rule",
  "signup, magic-link request, password-reset request, and token consume endpoints",
  "Raw emails, identifiers, and IP addresses are never stored",
  "tests/routes.test.ts",
  "tests/security-hardening.test.ts",
]) {
  requireText("docs/rate-limiting.md", docs.rateLimiting, text);
}

for (const text of [
  "Operational Metric Map",
  "password_login_success",
  "password_login_failed",
  "dummy_password_verification",
  "signup_failed",
  "duplicate email or username attempts",
  "magic_link_request",
  "email_verification_request",
  "password_reset_request",
  "rate_limit_hit",
  "email_send_failed",
  "magic_link_consume_success",
  "email_verification_consume_success",
  "password_reset_confirm_success",
  "invalid_or_replayed",
  "config_error",
  "malformed_token",
  "invalid_or_expired",
  "session_revoked",
  "disabled_user",
  "GROUP BY reason",
]) {
  requireText("docs/metrics.md", docs.metrics, text);
}
for (const eventType of await runtimeAuthEventTypes()) {
  requireText("docs/metrics.md", docs.metrics, eventType);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("security documentation verified");

function requireText(file, text, needle) {
  if (!text.includes(needle)) {
    failures.push(`${file}: missing ${needle}`);
  }
}

async function requireLinkedEvidenceExists(row, threat) {
  const links = [...row.matchAll(/\]\(([^)#]+)(?:#[^)]+)?\)/gu)];
  for (const match of links) {
    const target = match[1];
    if (!target || isExternalLink(target)) continue;
    const path = normalize(join("docs", target));
    try {
      await access(path);
    } catch {
      failures.push(
        `docs/security-model.md: ${threat} row links to missing evidence target ${path}`,
      );
    }
  }
}

function isExternalLink(target) {
  return /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("#");
}

async function turnstileEndpointNames() {
  const path = "packages/worker/src/index.ts";
  let sourceText;
  try {
    sourceText = await readFile(path, "utf8");
  } catch {
    failures.push(`${path}: could not be read for Turnstile docs coverage`);
    return [];
  }

  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set();

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== "turnstileEndpointNames" ||
        !declaration.initializer
      ) {
        continue;
      }
      const array = unwrapConstAssertion(declaration.initializer);
      if (!ts.isArrayLiteralExpression(array)) continue;
      for (const element of array.elements) {
        if (ts.isStringLiteral(element)) names.add(element.text);
      }
    }
  }

  if (names.size === 0)
    failures.push(
      `${path}: no Turnstile endpoint names found for docs coverage`,
    );

  return [...names].sort();
}

async function runtimeAuthEventTypes() {
  const path = "packages/worker/src/index.ts";
  let sourceText;
  try {
    sourceText = await readFile(path, "utf8");
  } catch {
    failures.push(`${path}: could not be read for metrics docs coverage`);
    return [];
  }

  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const names = new Set();

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = callExpressionName(node.expression);
      if (
        (name === "queueAuthEvent" || name === "tokenConsumeEventInput") &&
        node.arguments.length >= 3
      ) {
        addStringLiteral(names, node.arguments[2]);
      }
      if (name === "writeAuthEvent" && node.arguments.length >= 1) {
        addObjectEventType(names, node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  if (names.size === 0)
    failures.push(
      `${path}: no auth event types found for metrics docs coverage`,
    );

  return [...names].sort();
}

function callExpressionName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function addObjectEventType(names, expression) {
  const object = unwrapConstAssertion(expression);
  if (!ts.isObjectLiteralExpression(object)) return;
  for (const property of object.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      propertyNameText(property.name) !== "eventType"
    ) {
      continue;
    }
    addStringLiteral(names, property.initializer);
  }
}

function addStringLiteral(names, expression) {
  const value = unwrapConstAssertion(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    names.add(value.text);
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function unwrapConstAssertion(expression) {
  if (ts.isAsExpression(expression)) return expression.expression;
  return expression;
}
