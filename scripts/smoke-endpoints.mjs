import { readFile } from "node:fs/promises";
import ts from "typescript";

const defaultSmokeEndpointSource = new URL(
  "smoke-production-cloudflare.mjs",
  import.meta.url,
);
const authEndpointPattern = /\/auth\/[A-Za-z0-9/-]+/gu;
const exactAuthEndpointPattern = /^\/auth\/[A-Za-z0-9/-]+$/u;

export async function requiredAuthSmokeEndpoints(
  source = defaultSmokeEndpointSource,
) {
  const sourceText = await readFile(source, "utf8");
  const sourceFile = ts.createSourceFile(
    String(source),
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const endpoints = new Set();

  ts.forEachChild(sourceFile, function collect(node) {
    const text = stringLikeNodeText(node);
    if (text) collectAuthEndpoints(text, endpoints);
    ts.forEachChild(node, collect);
  });

  if (endpoints.size === 0) {
    throw new Error(`${source}: no auth smoke endpoints found`);
  }

  return [...endpoints].sort();
}

export function requireSmokedEndpointEvidence({
  evidencePath,
  failures,
  value,
  path,
}) {
  if (!Array.isArray(value)) {
    failures.push(`${evidencePath}: ${path} must be an array`);
    return [];
  }

  const endpoints = [];
  const seen = new Set();
  for (const [index, endpoint] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
      failures.push(`${evidencePath}: ${itemPath} must be a non-empty string`);
      continue;
    }
    if (endpoint.trim() !== endpoint) {
      failures.push(
        `${evidencePath}: ${itemPath} must not include leading or trailing whitespace`,
      );
      continue;
    }
    if (!exactAuthEndpointPattern.test(endpoint)) {
      failures.push(
        `${evidencePath}: ${itemPath} must be an exact /auth/... endpoint path`,
      );
      continue;
    }
    if (seen.has(endpoint)) {
      failures.push(`${evidencePath}: ${itemPath} duplicates ${endpoint}`);
      continue;
    }
    seen.add(endpoint);
    endpoints.push(endpoint);
  }
  return endpoints;
}

function stringLikeNodeText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (
    node.kind === ts.SyntaxKind.TemplateHead ||
    node.kind === ts.SyntaxKind.TemplateMiddle ||
    node.kind === ts.SyntaxKind.TemplateTail
  ) {
    return node.text;
  }
  return null;
}

function collectAuthEndpoints(text, endpoints) {
  for (const match of text.matchAll(authEndpointPattern)) {
    endpoints.add(match[0]);
  }
}
