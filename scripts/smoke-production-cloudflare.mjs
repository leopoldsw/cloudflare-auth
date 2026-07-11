import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertNoWorkspaceDependencies,
  getObjectSection,
  parsePnpmPackOutput,
  readJsonObject,
  rewriteWorkspaceDependencySpecs,
} from "./package-json-utils.mjs";
import { isBetaPackageTag } from "./release-version-policy.mjs";

const root = process.cwd();
const versionMatrix = await readJsonObject("scripts/version-matrix.json");
const requiredGate = "CF_AUTH_PRODUCTION_SMOKE";
if (process.env[requiredGate] !== "1") {
  throw new Error(
    `${requiredGate}=1 is required because this smoke test mutates a real Cloudflare Worker and D1 database.`,
  );
}

const config = readConfig();
const appDir = await mkdtemp(join(tmpdir(), "cf-auth-production-smoke-"));
await cp(join(root, "templates", "hono-basic"), appDir, { recursive: true });
await writeSmokeAuthConfig(appDir);
await writeSmokeWranglerConfig(appDir, config);
await writeSmokePackageJson(appDir, config.packageTag);

run("pnpm", ["--dir", appDir, "install", "--no-frozen-lockfile"]);
run("pnpm", ["--dir", appDir, "build"]);

runCfAuth(appDir, [
  "setup",
  "--env",
  "production",
  "--report",
  "--output",
  "setup-report.json",
]);
const setupReport = await readJsonObject(
  join(appDir, "setup-report.json"),
  "production smoke setup report",
);
assertSetupReport(setupReport);

runCfAuth(appDir, ["setup", "--env", "production", "--skip-verify"]);

await exerciseDeployedAuth(config.origin);

console.log(
  `production Cloudflare smoke passed: ${config.workerName} at ${config.origin}`,
);

function readConfig() {
  const workerName =
    process.env.CF_AUTH_PRODUCTION_SMOKE_WORKER_NAME ??
    "cf-auth-production-smoke";
  const databaseName =
    process.env.CF_AUTH_PRODUCTION_SMOKE_DATABASE_NAME ??
    "cf-auth-production-smoke";
  const databaseId = requireEnv("CF_AUTH_PRODUCTION_SMOKE_DATABASE_ID");
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const origin = exactHttpsOrigin(
    requireEnv("CF_AUTH_PRODUCTION_SMOKE_ORIGIN"),
  );
  const packageTag =
    process.env.CF_AUTH_PRODUCTION_SMOKE_PACKAGE_TAG?.trim() || null;
  if (packageTag && !isBetaPackageTag(packageTag)) {
    throw new Error(
      "CF_AUTH_PRODUCTION_SMOKE_PACKAGE_TAG must be beta or a beta prerelease package version.",
    );
  }
  return {
    accountId,
    databaseId,
    databaseName,
    origin,
    packageTag,
    workerName,
  };
}

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function exactHttpsOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("CF_AUTH_PRODUCTION_SMOKE_ORIGIN must be a URL origin.");
  }
  if (url.protocol !== "https:" || value !== url.origin) {
    throw new Error(
      "CF_AUTH_PRODUCTION_SMOKE_ORIGIN must be an exact https origin with no path, query, fragment, credentials, wildcard, or trailing slash.",
    );
  }
  return value;
}

async function writeSmokePackageJson(appDir, packageTag) {
  const pkg = await readJsonObject(
    join(appDir, "package.json"),
    "production smoke package.json",
  );
  const packageSpecs = packageTag
    ? {
        "@cf-auth/core": packageTag,
        "@cf-auth/email-cloudflare": packageTag,
        "@cf-auth/hono": packageTag,
        "@cf-auth/worker": packageTag,
        "@cf-auth/cli": packageTag,
      }
    : await localPackageSpecs();
  pkg.name = "cf-auth-production-smoke";
  pkg.private = true;
  const dependencies = getObjectSection(
    pkg,
    "dependencies",
    "production smoke package.json",
    { create: true },
  );
  dependencies["@cf-auth/hono"] = packageSpecs["@cf-auth/hono"];
  dependencies["@cf-auth/worker"] = packageSpecs["@cf-auth/worker"];
  dependencies["@cf-auth/email-cloudflare"] =
    packageSpecs["@cf-auth/email-cloudflare"];
  dependencies.hono = versionMatrix.hono;
  const devDependencies = getObjectSection(
    pkg,
    "devDependencies",
    "production smoke package.json",
    { create: true },
  );
  devDependencies["@cf-auth/cli"] = packageSpecs["@cf-auth/cli"];
  devDependencies.typescript = versionMatrix.typescript;
  devDependencies.wrangler = versionMatrix.wrangler;
  if (!packageTag) {
    const pnpm = getObjectSection(
      pkg,
      "pnpm",
      "production smoke package.json",
      {
        create: true,
      },
    );
    const overrides = getObjectSection(
      pnpm,
      "overrides",
      "production smoke package.json: pnpm",
      { create: true },
    );
    overrides["@cf-auth/core"] = packageSpecs["@cf-auth/core"];
    overrides["@cf-auth/email-cloudflare"] =
      packageSpecs["@cf-auth/email-cloudflare"];
    overrides["@cf-auth/hono"] = packageSpecs["@cf-auth/hono"];
    overrides["@cf-auth/worker"] = packageSpecs["@cf-auth/worker"];
    overrides["@cf-auth/cli"] = packageSpecs["@cf-auth/cli"];
  }
  assertNoWorkspaceDependencies(pkg, "production smoke package.json");
  await writeFile(
    join(appDir, "package.json"),
    JSON.stringify(pkg, null, 2) + "\n",
  );
}

async function localPackageSpecs() {
  const packageDirs = ["core", "email-cloudflare", "worker", "hono", "cli"];
  const packDir = join(
    await mkdtemp(join(tmpdir(), "cf-auth-production-packs-")),
    "packs",
  );
  const stagedDir = join(
    await mkdtemp(join(tmpdir(), "cf-auth-production-stage-")),
    "packages",
  );
  await mkdir(packDir, { recursive: true });
  await mkdir(stagedDir, { recursive: true });
  const specs = {};
  for (const dir of packageDirs) {
    const stagedPackageDir = join(stagedDir, dir);
    await cp(join(root, "packages", dir), stagedPackageDir, {
      recursive: true,
    });
    await rewriteWorkspaceDependencies(stagedPackageDir, specs);
    const pack = parsePnpmPackOutput(
      run("pnpm", [
        "--dir",
        stagedPackageDir,
        "pack",
        "--pack-destination",
        packDir,
        "--json",
      ]).stdout,
      `packages/${dir}`,
    );
    specs[pack.name] = `file:${pack.filename}`;
  }
  return specs;
}

async function rewriteWorkspaceDependencies(packageDir, specs) {
  const packageJsonPath = join(packageDir, "package.json");
  const pkg = await readJsonObject(packageJsonPath);
  rewriteWorkspaceDependencySpecs(pkg, packageJsonPath, (name) => {
    const spec = specs[name];
    if (!spec) throw new Error(`Missing local package spec for ${name}`);
    return spec;
  });
  await writeFile(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n");
}

async function writeSmokeWranglerConfig(appDir, input) {
  const wrangler = {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: input.workerName,
    main: "src/index.ts",
    account_id: input.accountId,
    compatibility_date: versionMatrix.workersCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    observability: {
      enabled: true,
      head_sampling_rate: 1,
    },
    vars: {
      AUTH_ENV: "development",
      AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
    },
    d1_databases: [
      {
        binding: "AUTH_DB",
        database_name: `${input.databaseName}-local`,
        database_id: "local-development",
        migrations_dir: "migrations",
      },
    ],
    env: {
      production: {
        name: input.workerName,
        vars: {
          AUTH_ENV: "production",
          AUTH_PUBLIC_ORIGIN: input.origin,
        },
        d1_databases: [
          {
            binding: "AUTH_DB",
            database_name: input.databaseName,
            database_id: input.databaseId,
            migrations_dir: "migrations",
          },
        ],
      },
    },
  };
  await writeFile(
    join(appDir, "wrangler.jsonc"),
    JSON.stringify(wrangler, null, 2) + "\n",
  );
}

async function writeSmokeAuthConfig(appDir) {
  await writeFile(
    join(appDir, "src", "auth.config.ts"),
    `import {
  byEnvironment,
  defineAuthConfig,
  terminalEmail,
  type AuthEmailAdapter,
} from "@cf-auth/worker";

const smokeEmail: AuthEmailAdapter = {
  kind: "custom",
  async sendMagicLink() {},
  async sendEmailVerification() {},
  async sendPasswordReset() {},
};

export default defineAuthConfig({
  appName: "Cloudflare Auth Production Smoke",
  basePath: "/auth",
  email: byEnvironment({
    development: terminalEmail({ outbox: true }),
    preview: smokeEmail,
    production: smokeEmail,
  }),
});
`,
  );
}

function runCfAuth(cwd, args, options = {}) {
  return run("pnpm", ["--dir", cwd, "exec", "cf-auth", ...args], {
    allowFailure: options.allowFailure,
    env: config.packageTag ? {} : { CF_AUTH_ALLOW_LOCAL_PACKAGE_SPECS: "1" },
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "true", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 && !options.allowFailure) {
    printCommandOutput(result);
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result;
}

function printCommandOutput(result) {
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
}

function assertSetupReport(report) {
  if (report?.ok !== true) {
    throw new Error("production smoke setup report did not reach ok: true");
  }
  const steps = Array.isArray(report.steps) ? report.steps : [];
  const statusById = new Map(steps.map((step) => [step.id, step.status]));
  const requiredSteps = [
    "preflight",
    "origin",
    "provision",
    "secret",
    "migrate",
    "doctor",
    "deploy",
    "verify",
  ];
  for (const id of requiredSteps) {
    const status = statusById.get(id);
    if (status !== "pass" && status !== "warn") {
      throw new Error(
        `production smoke setup step ${id} was ${status ?? "missing"}; expected pass`,
      );
    }
  }
}

async function exerciseDeployedAuth(origin) {
  const email = `smoke-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "correct horse battery staple";
  const signup = await jsonPost(`${origin}/auth/signup`, {
    email,
    password,
  });
  if (signup.status !== 200) {
    throw new Error(`signup failed: ${signup.status} ${await signup.text()}`);
  }
  const signupCookie = signup.headers.get("Set-Cookie") ?? "";
  assertHostOnlySessionCookie(signupCookie, "signup");

  const login = await jsonPost(`${origin}/auth/login`, {
    identifier: email,
    password,
  });
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${await login.text()}`);
  }
  const loginCookie = login.headers.get("Set-Cookie") ?? "";
  assertHostOnlySessionCookie(loginCookie, "login");
  const cookie = loginCookie.split(";")[0];
  const user = await fetch(`${origin}/auth/user`, {
    headers: {
      Cookie: cookie,
    },
  });
  if (user.status !== 200) {
    throw new Error(
      `user endpoint failed: ${user.status} ${await user.text()}`,
    );
  }
  const body = await user.json();
  if (body?.user?.email !== email) {
    throw new Error("user endpoint did not return the smoke user");
  }

  const logout = await fetch(`${origin}/auth/logout`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
    },
  });
  if (logout.status !== 200) {
    throw new Error(`logout failed: ${logout.status} ${await logout.text()}`);
  }
  const clearCookie = logout.headers.get("Set-Cookie") ?? "";
  assertHostOnlySessionCookie(clearCookie, "logout", { cleared: true });

  const userAfterLogout = await fetch(`${origin}/auth/user`, {
    headers: {
      Cookie: cookie,
    },
  });
  if (userAfterLogout.status !== 200) {
    throw new Error(
      `user endpoint after logout failed: ${userAfterLogout.status} ${await userAfterLogout.text()}`,
    );
  }
  const bodyAfterLogout = await userAfterLogout.json();
  if (bodyAfterLogout?.user !== null) {
    throw new Error("user endpoint still returned a user after logout");
  }
}

function jsonPost(url, body) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: new URL(url).origin,
    },
    body: JSON.stringify(body),
  });
}

function assertHostOnlySessionCookie(
  setCookie,
  context,
  options = { cleared: false },
) {
  if (!setCookie.includes("__Host-cfauth-session=")) {
    throw new Error(
      `${context} did not set a host-only Cloudflare Auth session cookie`,
    );
  }
  if (!/;\s*Secure(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${context} session cookie missing Secure`);
  }
  if (!/;\s*HttpOnly(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${context} session cookie missing HttpOnly`);
  }
  if (!/;\s*Path=\/(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${context} session cookie missing Path=/`);
  }
  if (/;\s*Domain=/iu.test(setCookie)) {
    throw new Error(`${context} session cookie must not set Domain`);
  }
  if (options.cleared && !/;\s*Max-Age=0(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${context} did not clear the session cookie`);
  }
}
