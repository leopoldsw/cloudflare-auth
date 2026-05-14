import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const packageVersions = await readPackageVersions();
const versionMatrix = JSON.parse(
  await readFile("scripts/version-matrix.json", "utf8"),
);
const rootMigrations = new Map(
  await Promise.all(
    ["0001_initial.sql", "0002_indexes.sql"].map(async (file) => [
      file,
      await readFile(join("migrations", file), "utf8"),
    ]),
  ),
);
const failures = [];

await verifyBuildableProjects("examples");
await verifyBuildableProjects("templates");

for (const root of ["examples", "templates"]) {
  const entries = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isDirectory(),
  );
  for (const entry of entries) {
    const dir = join(root, entry.name);
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    verifyProjectToolchain(dir, pkg);
    const wrangler = parseJsonc(
      await readFile(join(dir, "wrangler.jsonc"), "utf8"),
    );
    verifyWranglerToolchain(dir, wrangler);
    await verifyDevVarsExample(dir);
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
  await verifyTemplatePasswordHashing(dir);
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
  console.error(failures.join("\n"));
  process.exit(1);
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
    const pkg = JSON.parse(
      await readFile(join("packages", entry.name, "package.json"), "utf8"),
    );
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

async function verifyTemplatePasswordHashing(dir) {
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
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
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

function parseJsonc(text) {
  return JSON.parse(
    text
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,\s*([}\]])/g, "$1"),
  );
}
