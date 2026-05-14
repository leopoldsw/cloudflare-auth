import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), "cf-auth-deploy-template-"));
const output = join(temp, "template");
const failures = [];

run("node", ["scripts/export-deploy-template.mjs", output]);

const packageJson = JSON.parse(
  await readFile(join(output, "package.json"), "utf8"),
);
const versionMatrix = JSON.parse(
  await readFile("scripts/version-matrix.json", "utf8"),
);
const expectedPackageTag =
  process.env.CF_AUTH_DEPLOY_TEMPLATE_PACKAGE_TAG?.trim() || "beta";
const wrangler = JSON.parse(
  await readFile(join(output, "wrangler.jsonc"), "utf8"),
);
const readme = await readFile(join(output, "README.md"), "utf8");
const devVarsExample = await readFile(
  join(output, ".dev.vars.example"),
  "utf8",
);

checkPackageJson(packageJson);
checkWrangler(wrangler);
await checkIsolatedTree(output);
checkReadme(readme);
checkDevVarsExample(devVarsExample);

if (process.env.CF_AUTH_DEPLOY_TEMPLATE_INSTALL === "1") {
  run("pnpm", ["--dir", output, "install", "--no-frozen-lockfile"]);
  run("pnpm", ["--dir", output, "build"]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`deploy template verified: ${output}`);

function checkPackageJson(pkg) {
  if (pkg.private !== true)
    failures.push("package.json: template package must be private");
  if (pkg.packageManager !== `pnpm@${versionMatrix.pnpm}`) {
    failures.push(
      `package.json: packageManager must be pnpm@${versionMatrix.pnpm}`,
    );
  }
  for (const [section, name, expected] of [
    ["dependencies", "hono", versionMatrix.hono],
    ["devDependencies", "typescript", versionMatrix.typescript],
    ["devDependencies", "vitest", versionMatrix.vitest],
    ["devDependencies", "wrangler", versionMatrix.wrangler],
  ]) {
    const actual = pkg[section]?.[name];
    if (actual !== expected) {
      failures.push(`package.json: ${section}.${name} must be ${expected}`);
    }
  }
  for (const [section, deps] of Object.entries({
    dependencies: pkg.dependencies ?? {},
    devDependencies: pkg.devDependencies ?? {},
  })) {
    for (const [name, version] of Object.entries(deps)) {
      if (String(version).startsWith("workspace:")) {
        failures.push(
          `package.json: ${section}.${name} must not use ${version}`,
        );
      }
      if (name.startsWith("@cf-auth/") && version !== expectedPackageTag) {
        failures.push(
          `package.json: ${section}.${name} must use ${expectedPackageTag}`,
        );
      }
    }
  }
  if (
    pkg.scripts?.["db:migrations:apply"] !==
    "wrangler d1 migrations apply AUTH_DB --remote"
  ) {
    failures.push(
      "package.json: db:migrations:apply must use the AUTH_DB binding name",
    );
  }
  if (!String(pkg.scripts?.deploy ?? "").includes("db:migrations:apply")) {
    failures.push(
      "package.json: deploy script must apply D1 migrations before deploy",
    );
  }
  for (const binding of ["AUTH_DB", "AUTH_SECRET", "AUTH_PUBLIC_ORIGIN"]) {
    if (!pkg.cloudflare?.bindings?.[binding]?.description) {
      failures.push(
        `package.json: missing Cloudflare binding description for ${binding}`,
      );
    }
  }
  const secretDescription =
    pkg.cloudflare?.bindings?.AUTH_SECRET?.description ?? "";
  const expectedSecretCommand = `npx --package @cf-auth/cli@${expectedPackageTag} cf-auth rotate-secret --print`;
  if (!secretDescription.includes(expectedSecretCommand)) {
    failures.push(
      `package.json: AUTH_SECRET description must use ${expectedSecretCommand}`,
    );
  }
}

function checkWrangler(config) {
  if (config.$schema !== "./node_modules/wrangler/config-schema.json") {
    failures.push("wrangler.jsonc: must reference Wrangler schema");
  }
  if (config.compatibility_date !== versionMatrix.workersCompatibilityDate) {
    failures.push(
      `wrangler.jsonc: compatibility_date must be ${versionMatrix.workersCompatibilityDate}`,
    );
  }
  if (!config.compatibility_flags?.includes("nodejs_compat")) {
    failures.push("wrangler.jsonc: must enable nodejs_compat");
  }
  if (config.observability?.enabled !== true) {
    failures.push("wrangler.jsonc: must enable observability");
  }
  if (config.observability?.head_sampling_rate !== 1) {
    failures.push("wrangler.jsonc: observability head_sampling_rate must be 1");
  }
  if (config.vars?.AUTH_ENV !== "production") {
    failures.push(
      "wrangler.jsonc: deploy template must default AUTH_ENV to production",
    );
  }
  if (!isExactHttpsOrigin(config.vars?.AUTH_PUBLIC_ORIGIN)) {
    failures.push(
      "wrangler.jsonc: AUTH_PUBLIC_ORIGIN must be an exact https origin",
    );
  }
  const authDb = config.d1_databases?.find(
    (item) => item.binding === "AUTH_DB",
  );
  if (!authDb) {
    failures.push("wrangler.jsonc: missing AUTH_DB D1 binding");
    return;
  }
  if (!authDb.database_name || !authDb.database_id) {
    failures.push(
      "wrangler.jsonc: AUTH_DB needs default database name and ID values for Deploy to Cloudflare provisioning",
    );
  }
  if (authDb.migrations_dir !== "migrations") {
    failures.push("wrangler.jsonc: AUTH_DB migrations_dir must be migrations");
  }
}

async function checkIsolatedTree(dir) {
  const entries = new Set(await readdir(dir));
  for (const forbidden of [
    "node_modules",
    ".wrangler",
    "pnpm-workspace.yaml",
  ]) {
    if (entries.has(forbidden)) {
      failures.push(`template tree: must not include ${forbidden}`);
    }
  }
  for (const required of [
    "README.md",
    "package.json",
    "wrangler.jsonc",
    "src",
    "migrations",
    ".dev.vars.example",
  ]) {
    if (!entries.has(required))
      failures.push(`template tree: missing ${required}`);
  }
}

function checkReadme(text) {
  if (!text.includes("deploy.workers.cloudflare.com/?url=")) {
    failures.push("README.md: missing Deploy to Cloudflare button URL");
  }
  if (!text.includes("AUTH_PUBLIC_ORIGIN") || !text.includes("AUTH_SECRET")) {
    failures.push("README.md: missing required variable instructions");
  }
  const expectedSecretCommand = `npx --package @cf-auth/cli@${expectedPackageTag} cf-auth rotate-secret --print`;
  if (!text.includes(expectedSecretCommand)) {
    failures.push(`README.md: missing ${expectedSecretCommand}`);
  }
}

function checkDevVarsExample(text) {
  if (text !== "AUTH_SECRET=k1.REPLACE_WITH_32_BYTE_BASE64URL_SECRET\n") {
    failures.push(
      ".dev.vars.example: must contain the exact AUTH_SECRET placeholder",
    );
  }
}

function isExactHttpsOrigin(value) {
  if (typeof value !== "string" || value.includes("*")) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && value === url.origin;
  } catch {
    return false;
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result;
}
