import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

const docs = {
  api: await readFile("docs/api.md", "utf8"),
  apiReport: await readFile("docs/api-report.md", "utf8"),
  cli: await readFile("docs/cli.md", "utf8"),
  configSchema: await readFile("docs/config-schema.md", "utf8"),
  config: await readFile("docs/configuration.md", "utf8"),
  deployment: await readFile("docs/deployment.md", "utf8"),
  migrations: await readFile("docs/migrations.md", "utf8"),
  readme: await readFile("README.md", "utf8"),
};
const failures = [];

const cliCommands = await cliCommandNames();
for (const command of cliCommands) {
  requireText("docs/cli.md", docs.cli, `cf-auth ${command}`);
}

for (const command of [
  "cf-auth generate hono",
  "cf-auth generate worker-snippet",
  "cf-auth generate react-client",
  "cf-auth generate types",
  "cf-auth rotate-secret --print",
  "cf-auth rotate-secret --apply --env production",
  "cf-auth clean --local",
  "cf-auth clean --remote --env production",
  "cf-auth users disable",
  "cf-auth users enable",
  "cf-auth sessions revoke --user",
  "cf-auth sessions list --user",
]) {
  requireText("docs/cli.md", docs.cli, command);
}

const configKeys = await authConfigKeys();
for (const key of configKeys) {
  requireText("docs/configuration.md", docs.config, key);
}
for (const key of configKeys) {
  requireText("docs/config-schema.md", docs.configSchema, key);
}

const environmentKeys = await generatedEnvKeys();
for (const key of environmentKeys) {
  requireText("docs/config-schema.md", docs.configSchema, key);
}

const authEndpoints = await authRouteEndpoints();
for (const endpoint of authEndpoints) {
  requireText("docs/api.md", docs.api, endpoint);
}

for (const text of ["Referrer-Policy: no-referrer", "history entry"]) {
  requireText("docs/api.md", docs.api, text);
}

const packageEntrypoints = await workspacePackageNames();
for (const entrypoint of packageEntrypoints) {
  requireText("docs/api.md", docs.api, entrypoint);
}

const rootExports = await rootExportNames();
for (const exportName of rootExports) {
  requireText("docs/api.md", docs.api, exportName);
}
for (const exportName of rootExports) {
  requireText("docs/api-report.md", docs.apiReport, exportName);
}

for (const text of ["Default retention windows", "non-negative integer"]) {
  requireText("docs/api.md", docs.api, text);
}

for (const command of [
  "cf-auth migrate --local",
  "cf-auth migrate --remote --env production",
  "cf-auth migrate --status --local",
  "cf-auth migrate --status --remote --env production",
]) {
  requireText("docs/migrations.md", docs.migrations, command);
}

for (const text of ["cleanCfAuth", "ctx.waitUntil", "non-negative integer"]) {
  requireText("docs/migrations.md", docs.migrations, text);
}

for (const text of [
  "cf-auth doctor --env production",
  "cf-auth migrate --remote --env production",
  "cf-auth deploy --env production",
  "AUTH_PUBLIC_ORIGIN",
  "AUTH_SECRET",
  "AUTH_DB.database_id",
  "AUTH_EMAIL",
  "/auth/logout",
]) {
  requireText("docs/deployment.md", docs.deployment, text);
}

requireText("README.md", docs.readme, "SECURITY.md");

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("documentation coverage verified");

function requireText(file, text, needle) {
  if (!text.includes(needle)) {
    failures.push(`${file}: missing ${needle}`);
  }
}

async function rootExportNames() {
  const entries = await readdir("packages", { withFileTypes: true });
  const names = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join("packages", entry.name, "src", "index.ts");
    let sourceText;
    try {
      sourceText = await readFile(path, "utf8");
    } catch {
      continue;
    }
    const sourceFile = ts.createSourceFile(
      path,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of sourceFile.statements) {
      if (ts.isExportDeclaration(statement)) {
        collectExportDeclarationNames(statement, names);
        continue;
      }
      if (!hasExportModifier(statement)) continue;
      const namedDeclaration = statement;
      if (
        (ts.isFunctionDeclaration(namedDeclaration) ||
          ts.isClassDeclaration(namedDeclaration) ||
          ts.isInterfaceDeclaration(namedDeclaration) ||
          ts.isTypeAliasDeclaration(namedDeclaration) ||
          ts.isEnumDeclaration(namedDeclaration)) &&
        namedDeclaration.name
      ) {
        names.add(namedDeclaration.name.text);
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name))
            names.add(declaration.name.text);
        }
      }
    }
  }
  return [...names].sort();
}

function collectExportDeclarationNames(statement, names) {
  const clause = statement.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return;
  for (const element of clause.elements) {
    names.add(element.name.text);
  }
}

async function workspacePackageNames() {
  const entries = await readdir("packages", { withFileTypes: true });
  const names = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join("packages", entry.name, "package.json");
    let pkg;
    try {
      pkg = JSON.parse(await readFile(path, "utf8"));
    } catch {
      failures.push(`${path}: could not be read for package docs coverage`);
      continue;
    }
    if (typeof pkg.name === "string") {
      names.add(pkg.name);
    } else {
      failures.push(`${path}: missing package name for docs coverage`);
    }
  }
  return [...names].sort();
}

async function authConfigKeys() {
  const path = "packages/worker/src/index.ts";
  let sourceText;
  try {
    sourceText = await readFile(path, "utf8");
  } catch {
    failures.push(`${path}: could not be read for config docs coverage`);
    return [];
  }

  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const interfaces = new Map();
  const keys = new Set();

  ts.forEachChild(sourceFile, function collect(node) {
    if (ts.isInterfaceDeclaration(node)) interfaces.set(node.name.text, node);
    ts.forEachChild(node, collect);
  });

  const authConfig = interfaces.get("AuthConfig");
  if (!authConfig) {
    failures.push(
      `${path}: missing AuthConfig interface for config docs coverage`,
    );
    return [];
  }

  collectInterfaceKeys(authConfig, "");

  if (keys.size === 0)
    failures.push(`${path}: no config keys found in AuthConfig interface`);

  return [...keys].sort();

  function collectInterfaceKeys(node, prefix) {
    for (const clause of node.heritageClauses ?? []) {
      for (const type of clause.types) {
        const parent = interfaces.get(type.expression.getText(sourceFile));
        if (parent) collectInterfaceKeys(parent, prefix);
      }
    }
    collectMemberKeys(node.members, prefix);
  }

  function collectMemberKeys(members, prefix) {
    for (const member of members) {
      if (!ts.isPropertySignature(member)) continue;
      const name = propertyNameText(member.name);
      if (!name) continue;
      const key = prefix ? `${prefix}.${name}` : name;
      if (member.type && ts.isTypeLiteralNode(member.type)) {
        collectMemberKeys(member.type.members, key);
      } else {
        keys.add(key);
      }
    }
  }
}

async function authRouteEndpoints() {
  const path = "packages/worker/src/index.ts";
  let sourceText;
  try {
    sourceText = await readFile(path, "utf8");
  } catch {
    failures.push(`${path}: could not be read for auth endpoint docs coverage`);
    return [];
  }

  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const endpoints = new Set();
  let foundDispatcher = false;

  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "dispatchAuthRequest"
    ) {
      foundDispatcher = true;
      ts.forEachChild(node, collectEndpoint);
      return;
    }
    ts.forEachChild(node, visit);
  }

  function collectEndpoint(node) {
    if (ts.isIfStatement(node)) {
      const endpoint = routeEndpointFromExpression(node.expression);
      if (endpoint) endpoints.add(endpoint);
    }
    ts.forEachChild(node, collectEndpoint);
  }

  visit(sourceFile);

  if (!foundDispatcher)
    failures.push(
      `${path}: missing dispatchAuthRequest for auth endpoint docs coverage`,
    );
  if (endpoints.size === 0)
    failures.push(`${path}: no auth endpoints found in dispatchAuthRequest`);

  return [...endpoints].sort();
}

async function cliCommandNames() {
  const path = "packages/cli/src/index.ts";
  let sourceText;
  try {
    sourceText = await readFile(path, "utf8");
  } catch {
    failures.push(`${path}: could not be read for CLI command docs coverage`);
    return [];
  }

  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const commands = new Set();
  let foundRunCli = false;

  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "runCli") {
      foundRunCli = true;
      ts.forEachChild(node, collectCliSwitch);
      return;
    }
    ts.forEachChild(node, visit);
  }

  function collectCliSwitch(node) {
    if (
      ts.isSwitchStatement(node) &&
      expressionName(node.expression) === "parsed.command"
    ) {
      for (const clause of node.caseBlock.clauses) {
        if (
          !ts.isCaseClause(clause) ||
          !ts.isStringLiteral(clause.expression)
        ) {
          continue;
        }
        const command = clause.expression.text;
        if (!["help", "--help", "-h"].includes(command)) commands.add(command);
      }
    }
    ts.forEachChild(node, collectCliSwitch);
  }

  visit(sourceFile);

  if (!foundRunCli)
    failures.push(`${path}: missing runCli for CLI command docs coverage`);
  if (commands.size === 0)
    failures.push(`${path}: no CLI commands found in runCli dispatcher`);

  return [...commands].sort();
}

async function generatedEnvKeys() {
  const path = "packages/cli/src/index.ts";
  let sourceText;
  try {
    sourceText = await readFile(path, "utf8");
  } catch {
    failures.push(`${path}: could not be read for generated Env docs coverage`);
    return [];
  }

  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const keys = new Set();
  let foundTypesGenerator = false;

  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === "commandGenerate"
    ) {
      ts.forEachChild(node, collectTypesGenerator);
      return;
    }
    ts.forEachChild(node, visit);
  }

  function collectTypesGenerator(node) {
    if (
      ts.isIfStatement(node) &&
      stringEquality(node.expression)?.name === "what" &&
      stringEquality(node.expression)?.value === "types"
    ) {
      foundTypesGenerator = true;
      collectEnvKeysFromStatement(node.thenStatement);
      return;
    }
    ts.forEachChild(node, collectTypesGenerator);
  }

  function collectEnvKeysFromStatement(statement) {
    if (ts.isBlock(statement)) {
      for (const child of statement.statements)
        collectEnvKeysFromStatement(child);
      return;
    }
    if (!ts.isReturnStatement(statement) || !statement.expression) return;
    const array = arrayLiteralJoinedByNewline(statement.expression);
    if (!array) return;
    for (const element of array.elements) {
      const text = stringLiteralValue(element);
      if (!text) continue;
      const match = text.match(/^\s+([A-Z][A-Z0-9_]+)\??:/u);
      if (match?.[1]) keys.add(match[1]);
    }
  }

  visit(sourceFile);

  if (!foundTypesGenerator)
    failures.push(
      `${path}: missing generate types output for Env docs coverage`,
    );
  if (keys.size === 0)
    failures.push(`${path}: no generated Env keys found for docs coverage`);

  return [...keys].sort();
}

function arrayLiteralJoinedByNewline(expression) {
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "join" &&
    expression.arguments.length === 1 &&
    stringLiteralValue(expression.arguments[0]) === "\n" &&
    ts.isArrayLiteralExpression(expression.expression.expression)
  ) {
    return expression.expression.expression;
  }
  return null;
}

function routeEndpointFromExpression(expression) {
  let routePath = null;
  let method = null;

  for (const condition of flattenAndConditions(expression)) {
    const equality = stringEquality(condition);
    if (!equality) continue;
    if (equality.name === "path") routePath = equality.value;
    if (equality.name === "request.method") method = equality.value;
  }

  return routePath && method ? `${method} /auth${routePath}` : null;
}

function flattenAndConditions(expression) {
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
  ) {
    return [
      ...flattenAndConditions(expression.left),
      ...flattenAndConditions(expression.right),
    ];
  }
  return [expression];
}

function stringEquality(expression) {
  if (
    !ts.isBinaryExpression(expression) ||
    expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken
  ) {
    return null;
  }

  const leftName = expressionName(expression.left);
  const rightValue = stringLiteralValue(expression.right);
  if (leftName && rightValue !== null)
    return { name: leftName, value: rightValue };

  const rightName = expressionName(expression.right);
  const leftValue = stringLiteralValue(expression.left);
  if (rightName && leftValue !== null)
    return { name: rightName, value: leftValue };

  return null;
}

function expressionName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (!ts.isPropertyAccessExpression(expression)) return null;
  const parent = expressionName(expression.expression);
  return parent ? `${parent}.${expression.name.text}` : null;
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function hasExportModifier(node) {
  return node.modifiers?.some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
}

function stringLiteralValue(expression) {
  return ts.isStringLiteral(expression) ? expression.text : null;
}
