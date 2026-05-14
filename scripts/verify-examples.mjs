import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { isJsonObject } from "./evidence-validation.mjs";

const failures = [];
const packageVersions = await readPackageVersions();
const versionMatrix = await readJsonObject("scripts/version-matrix.json");
if (!versionMatrix) fail();
const rootMigrations = new Map(
  await Promise.all(
    ["0001_initial.sql", "0002_indexes.sql"].map(async (file) => [
      file,
      await readFile(join("migrations", file), "utf8"),
    ]),
  ),
);

if (failures.length) fail();

await verifyBuildableProjects("examples");
await verifyBuildableProjects("templates");

for (const root of ["examples", "templates"]) {
  const entries = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory(),
  );
  for (const entry of entries) {
    const dir = join(root, entry.name);
    const pkg = await readJsonObject(join(dir, "package.json"));
    if (!pkg) continue;
    verifyProjectToolchain(dir, pkg);
    const wrangler = parseJsoncObject(
      await readFile(join(dir, "wrangler.jsonc"), "utf8"),
      join(dir, "wrangler.jsonc"),
    );
    if (!wrangler) continue;
    verifyWranglerToolchain(dir, wrangler);
    verifyWranglerD1Binding(
      dir,
      wrangler,
      root === "examples" ? "../../migrations" : "migrations",
    );
    await verifyDevVarsExample(dir);
    await verifyAuthConfigPasswordHashing(dir);
    const rendered = renderPublishedManifest(pkg);
    for (const section of ["dependencies", "devDependencies"]) {
      for (const [name, version] of Object.entries(rendered[section] ?? {})) {
        if (String(version).startsWith("workspace:")) {
          failures.push(`${dir}: ${section}.${name} still uses ${version}`);
        }
        const expectedVersion = packageVersions.get(name);
        if (name.startsWith("@cf-auth/") && !expectedVersion) {
          failures.push(
            `${dir}: ${section}.${name} is not a workspace package`,
          );
        }
        if (expectedVersion && version !== expectedVersion) {
          failures.push(
            `${dir}: ${section}.${name} renders ${version}, expected ${expectedVersion}`,
          );
        }
      }
    }
  }
}

for (const template of ["hono-basic", "worker-basic", "react-vite-worker"]) {
  const dir = join("templates", template);
  await requireFile(join(dir, "wrangler.jsonc"));
  await requireFile(join(dir, ".dev.vars.example"));
  for (const [file, expected] of rootMigrations) {
    const actual = await readFile(join(dir, "migrations", file), "utf8").catch(
      () => null,
    );
    if (actual === null) failures.push(`${dir}: missing migrations/${file}`);
    else if (actual !== expected)
      failures.push(`${dir}: migrations/${file} differs from root migration`);
  }
}

if (failures.length) {
  fail();
}

function renderPublishedManifest(pkg) {
  return {
    ...pkg,
    dependencies: renderDependencySection(pkg.dependencies),
    devDependencies: renderDependencySection(pkg.devDependencies),
  };
}

function renderDependencySection(section) {
  if (!section) return undefined;
  return Object.fromEntries(
    Object.entries(section).map(([name, version]) => [
      name,
      packageVersions.has(name) && version === "workspace:*"
        ? packageVersions.get(name)
        : version,
    ]),
  );
}

async function readPackageVersions() {
  const entries = (await readdir("packages", { withFileTypes: true })).filter(
    (entry) => entry.isDirectory(),
  );
  const versions = new Map();
  for (const entry of entries) {
    const pkg = await readJsonObject(
      join("packages", entry.name, "package.json"),
    );
    if (!pkg) continue;
    if (!pkg.private) versions.set(pkg.name, pkg.version);
  }
  return versions;
}

async function requireFile(path) {
  try {
    await readFile(path, "utf8");
  } catch {
    failures.push(`${path}: missing required template file`);
  }
}

async function verifyDevVarsExample(dir) {
  let text;
  try {
    text = await readFile(join(dir, ".dev.vars.example"), "utf8");
  } catch {
    failures.push(`${dir}: missing .dev.vars.example`);
    return;
  }
  for (const line of [
    "AUTH_ENV=development",
    "AUTH_PUBLIC_ORIGIN=http://localhost:8787",
    "AUTH_SECRET=k_dev.REPLACE_WITH_GENERATED_BASE64URL_SECRET",
  ]) {
    if (!text.includes(line)) {
      failures.push(`${dir}: .dev.vars.example missing ${line}`);
    }
  }
}

async function verifyAuthConfigPasswordHashing(dir) {
  const source =
    (await readFile(join(dir, "src", "auth.config.ts"), "utf8").catch(
      () => null,
    )) ??
    (await readFile(join(dir, "src", "index.ts"), "utf8").catch(() => null));
  if (source === null) {
    failures.push(`${dir}: missing auth config source`);
    return;
  }
  for (const expected of [
    "passwordHashing",
    'profile: "workers-balanced"',
    "maxConcurrentHashesPerIsolate: 1",
    "queueTimeoutMs: 2000",
  ]) {
    if (!source.includes(expected)) {
      failures.push(`${dir}: auth config missing ${expected}`);
    }
  }
}

async function verifyBuildableProjects(root) {
  const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  for (const entry of dirs) {
    const dir = join(root, entry.name);
    const pkg = await readJsonObject(join(dir, "package.json"));
    if (!pkg) continue;
    if (!pkg.scripts?.build) failures.push(`${dir}: missing build script`);
    if (!pkg.scripts?.test) failures.push(`${dir}: missing test script`);
    if (!pkg.engines || pkg.engines.node !== versionMatrix.node)
      failures.push(`${dir}: engine mismatch`);
    for (const script of ["build", "test"]) {
      const result = spawnSync("pnpm", ["--dir", dir, script], {
        stdio: "inherit",
      });
      if (result.status !== 0) failures.push(`${dir}: pnpm ${script} failed`);
    }
  }
}

function verifyProjectToolchain(dir, pkg) {
  if (pkg.packageManager !== `pnpm@${versionMatrix.pnpm}`) {
    failures.push(`${dir}: packageManager must be pnpm@${versionMatrix.pnpm}`);
  }
  for (const [section, name, expected] of [
    ["devDependencies", "typescript", versionMatrix.typescript],
    ["devDependencies", "vitest", versionMatrix.vitest],
    ["devDependencies", "wrangler", versionMatrix.wrangler],
    ["dependencies", "hono", versionMatrix.hono],
  ]) {
    const actual = pkg[section]?.[name];
    if (actual !== undefined && actual !== expected) {
      failures.push(`${dir}: ${section}.${name} must be ${expected}`);
    }
  }
}

function verifyWranglerToolchain(dir, wrangler) {
  if (wrangler.$schema !== "./node_modules/wrangler/config-schema.json") {
    failures.push(`${dir}: wrangler.jsonc must reference Wrangler schema`);
  }
  if (wrangler.compatibility_date !== versionMatrix.workersCompatibilityDate) {
    failures.push(
      `${dir}: compatibility_date must be ${versionMatrix.workersCompatibilityDate}`,
    );
  }
  if (!wrangler.compatibility_flags?.includes("nodejs_compat")) {
    failures.push(`${dir}: wrangler.jsonc must enable nodejs_compat`);
  }
  if (wrangler.observability?.enabled !== true) {
    failures.push(`${dir}: wrangler.jsonc must enable observability`);
  }
  if (wrangler.observability?.head_sampling_rate !== 1) {
    failures.push(
      `${dir}: wrangler.jsonc observability head_sampling_rate must be 1`,
    );
  }
}

function verifyWranglerD1Binding(dir, wrangler, expectedMigrationsDir) {
  const binding = Array.isArray(wrangler.d1_databases)
    ? wrangler.d1_databases.find((item) => item?.binding === "AUTH_DB")
    : null;
  if (!binding) {
    failures.push(`${dir}: wrangler.jsonc missing AUTH_DB D1 binding`);
    return;
  }
  if (typeof binding.database_name !== "string" || !binding.database_name) {
    failures.push(`${dir}: AUTH_DB database_name is required`);
  }
  if (typeof binding.database_id !== "string" || !binding.database_id) {
    failures.push(`${dir}: AUTH_DB database_id is required`);
  } else if (binding.database_id.trim().toUpperCase().startsWith("REPLACE_")) {
    failures.push(`${dir}: AUTH_DB database_id must not be a placeholder`);
  }
  if (binding.migrations_dir !== expectedMigrationsDir) {
    failures.push(
      `${dir}: AUTH_DB migrations_dir must be ${expectedMigrationsDir}`,
    );
  }
}

async function readJsonObject(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    failures.push(`${path}: must be valid JSON`);
    return null;
  }
  return requireJsonObject(parsed, path);
}

function parseJsoncObject(text, path) {
  let parsed;
  try {
    parsed = JSON.parse(
      text
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,\s*([}\]])/g, "$1"),
    );
  } catch {
    failures.push(`${path}: must be valid JSONC`);
    return null;
  }
  return requireJsonObject(parsed, path);
}

function requireJsonObject(value, path) {
  if (!isJsonObject(value)) {
    failures.push(`${path}: top-level JSON value must be an object`);
    return null;
  }
  return value;
}

function fail() {
  console.error(failures.join("\n"));
  process.exit(1);
}
