import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const packageVersions = await readPackageVersions();
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

async function verifyBuildableProjects(root) {
  const dirs = (await readdir(root, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  for (const entry of dirs) {
    const dir = join(root, entry.name);
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    if (!pkg.scripts?.build) failures.push(`${dir}: missing build script`);
    if (!pkg.scripts?.test) failures.push(`${dir}: missing test script`);
    if (!pkg.engines || pkg.engines.node !== ">=22.12.0")
      failures.push(`${dir}: engine mismatch`);
    for (const script of ["build", "test"]) {
      const result = spawnSync("pnpm", ["--dir", dir, script], {
        stdio: "inherit",
      });
      if (result.status !== 0) failures.push(`${dir}: pnpm ${script} failed`);
    }
  }
}
