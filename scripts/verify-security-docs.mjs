import { readFile } from "node:fs/promises";

const docs = {
  metrics: await readFile("docs/metrics.md", "utf8"),
  rateLimiting: await readFile("docs/rate-limiting.md", "utf8"),
  securityModel: await readFile("docs/security-model.md", "utf8"),
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
  if (!row.includes("(../tests/") && !row.includes("](")) {
    failures.push(
      `docs/security-model.md: ${threat} row must link to test or mitigation evidence`,
    );
  }
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
  "magic_link_consume",
  "password_reset_confirm",
  "transport errors and malformed responses are treated as failed challenges",
]) {
  requireText("docs/turnstile.md", docs.turnstile, text);
}

for (const text of [
  "AUTH_RATE_LIMITER",
  "D1 remains authoritative",
  "fails open to the D1 limiter",
  "Raw emails, identifiers, and IP addresses are never stored",
  "tests/routes.test.ts",
  "tests/security-hardening.test.ts",
]) {
  requireText("docs/rate-limiting.md", docs.rateLimiting, text);
}

for (const text of [
  "dummy_password_verification",
  "rate_limit_hit",
  "email_send_failed",
  "config_error",
  "malformed_token",
  "invalid_or_expired",
  "disabled_user",
  "GROUP BY reason",
]) {
  requireText("docs/metrics.md", docs.metrics, text);
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
