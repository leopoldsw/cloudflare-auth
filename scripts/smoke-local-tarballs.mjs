import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageDirs = [
  "core",
  "client",
  "worker",
  "cli",
  "hono",
  "testing",
  "email-cloudflare",
  "cf-auth-shim",
  "create-cloudflare-auth",
];
const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), "cf-auth-tarball-smoke-"));
const packDir = join(temp, "packs");
const stagedDir = join(temp, "staged");
const createRunnerDir = join(temp, "create-runner");
const appDir = join(temp, "app");
await mkdir(packDir, { recursive: true });
await mkdir(stagedDir, { recursive: true });
await mkdir(createRunnerDir, { recursive: true });

const tarballs = new Map();
for (const dir of packageDirs) {
  const stagedPackageDir = join(stagedDir, dir);
  await cp(join(root, "packages", dir), stagedPackageDir, { recursive: true });
  await rewriteWorkspaceDependencies(stagedPackageDir);
  const pack = runJson("pnpm", [
    "--dir",
    stagedPackageDir,
    "pack",
    "--pack-destination",
    packDir,
    "--json",
  ]);
  tarballs.set(pack.name, pack.filename);
}

await writeFile(
  join(createRunnerDir, "package.json"),
  JSON.stringify(
    {
      name: "cf-auth-create-runner",
      private: true,
      devDependencies: {
        "create-cloudflare-auth": fileSpec("create-cloudflare-auth"),
      },
      pnpm: {
        onlyBuiltDependencies: ["esbuild", "sharp", "workerd"],
      },
    },
    null,
    2,
  ) + "\n",
);
await writePnpmBuildPolicy(createRunnerDir);
run("pnpm", [
  "--dir",
  createRunnerDir,
  "install",
  "--prefer-offline",
  "--no-frozen-lockfile",
]);
run("pnpm", [
  "--dir",
  createRunnerDir,
  "exec",
  "create-cloudflare-auth",
  appDir,
  "--yes",
]);

const appPackagePath = join(appDir, "package.json");
const appPackage = JSON.parse(await readFile(appPackagePath, "utf8"));
appPackage.dependencies["@cf-auth/hono"] = fileSpec("@cf-auth/hono");
appPackage.dependencies["@cf-auth/worker"] = fileSpec("@cf-auth/worker");
appPackage.dependencies["@cf-auth/email-cloudflare"] = fileSpec(
  "@cf-auth/email-cloudflare",
);
appPackage.devDependencies["@cf-auth/cli"] = fileSpec("@cf-auth/cli");
appPackage.devDependencies["@cf-auth/testing"] = fileSpec("@cf-auth/testing");
appPackage.pnpm = {
  ...(appPackage.pnpm ?? {}),
  overrides: Object.fromEntries(
    Array.from(tarballs.keys())
      .filter((name) => name.startsWith("@cf-auth/"))
      .map((name) => [name, fileSpec(name)]),
  ),
};
await writeFile(appPackagePath, JSON.stringify(appPackage, null, 2) + "\n");

const installMode = process.env.CF_AUTH_TARBALL_INSTALL === "1";
if (installMode) {
  await writeFile(join(appDir, "smoke-auth.test.ts"), smokeAuthTestSource());
  run("pnpm", [
    "--dir",
    appDir,
    "install",
    "--prefer-offline",
    "--no-frozen-lockfile",
  ]);
  run("pnpm", ["--dir", appDir, "build"]);
  run("pnpm", ["--dir", appDir, "test"]);
  run(process.execPath, [
    join(root, "scripts", "smoke-wrangler-dev.mjs"),
    appDir,
  ]);
}

const migrate = installMode
  ? run("pnpm", ["--dir", appDir, "exec", "cf-auth", "migrate", "--local"])
  : run(
      "node",
      [join(root, "packages", "cli", "dist", "bin.js"), "migrate", "--local"],
      { cwd: appDir },
    );
if (!migrate.stdout.includes("wrangler d1 migrations apply")) {
  throw new Error("Generated app did not produce a local migration command");
}

console.log(
  `local tarball smoke passed: ${appDir}${
    installMode ? "" : " (install/build skipped; set CF_AUTH_TARBALL_INSTALL=1)"
  }`,
);

function fileSpec(name) {
  const filename = tarballs.get(name);
  if (!filename) throw new Error(`Missing tarball for ${name}`);
  return `file:${filename}`;
}

async function rewriteWorkspaceDependencies(packageDir) {
  const packageJsonPath = join(packageDir, "package.json");
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries(pkg[section] ?? {})) {
      if (String(version).startsWith("workspace:")) {
        pkg[section][name] = fileSpec(name);
      }
    }
  }
  await writeFile(packageJsonPath, JSON.stringify(pkg, null, 2) + "\n");
}

async function writePnpmBuildPolicy(dir) {
  await writeFile(
    join(dir, "pnpm-workspace.yaml"),
    "allowBuilds:\n  esbuild: true\n  sharp: true\n  workerd: true\n",
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, CI: "true", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
  return result;
}

function runJson(command, args) {
  const result = run(command, args);
  return JSON.parse(result.stdout);
}

function smokeAuthTestSource() {
  return `import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import app from "./src/index";
import { applyD1Migrations, createSqliteD1Database } from "@cf-auth/testing";

describe("generated auth app", () => {
  it("signs up and logs in against migrated D1", async () => {
    const db = createSqliteD1Database();
    await applyD1Migrations(db, [
      await readFile(join(process.cwd(), "migrations", "0001_initial.sql"), "utf8"),
      await readFile(join(process.cwd(), "migrations", "0002_indexes.sql"), "utf8"),
    ]);
    const env = {
      AUTH_DB: db,
      AUTH_ENV: "development",
      AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
      AUTH_SECRET: "k_smoke.${"A".repeat(43)}",
    };
    const ctx = {
      waitUntil(promise: Promise<unknown>) {
        void promise;
      },
      passThroughOnException() {},
    } as ExecutionContext;
    const signup = await app.fetch(
      new Request("http://localhost:8787/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "smoke@example.com",
          password: "correct horse battery staple",
        }),
      }),
      env,
      ctx,
    );
    expect(signup.status).toBe(200);
    expect(signup.headers.get("Set-Cookie") ?? "").toContain("cfauth-session=");

    const login = await app.fetch(
      new Request("http://localhost:8787/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: "smoke@example.com",
          password: "correct horse battery staple",
        }),
      }),
      env,
      ctx,
    );
    expect(login.status).toBe(200);
    const loginCookie = login.headers.get("Set-Cookie") ?? "";
    expect(loginCookie).toContain("cfauth-session=");
    const cookie = loginCookie.split(";")[0];

    const user = await app.fetch(
      new Request("http://localhost:8787/auth/user", {
        headers: { Cookie: cookie },
      }),
      env,
      ctx,
    );
    expect(user.status).toBe(200);
    await expect(user.json()).resolves.toMatchObject({
      user: { email: "smoke@example.com" },
    });

    const logout = await app.fetch(
      new Request("http://localhost:8787/auth/logout", {
        method: "POST",
        headers: { Cookie: cookie, Origin: "http://localhost:8787" },
      }),
      env,
      ctx,
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("Set-Cookie") ?? "").toContain("Max-Age=0");

    const userAfterLogout = await app.fetch(
      new Request("http://localhost:8787/auth/user", {
        headers: { Cookie: cookie },
      }),
      env,
      ctx,
    );
    expect(userAfterLogout.status).toBe(200);
    await expect(userAfterLogout.json()).resolves.toEqual({ user: null });
  });
});
`;
}
