import { spawn, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertNoWorkspaceDependencies as assertNoWorkspaceDependencySpecs,
  readJsonObject,
} from "./package-json-utils.mjs";
import { isBetaPackageTag } from "./release-version-policy.mjs";

const root = process.cwd();
const packageTag =
  process.env.CF_AUTH_PUBLISHED_QUICKSTART_PACKAGE_TAG?.trim() || "beta";
if (!isBetaPackageTag(packageTag)) {
  throw new Error(
    "CF_AUTH_PUBLISHED_QUICKSTART_PACKAGE_TAG must be beta or a beta prerelease package version.",
  );
}
const temp = await mkdtemp(join(tmpdir(), "cf-auth-published-quickstart-"));
const appName = "my-app";
const appDir = join(temp, appName);
const port = await findOpenPort();
const origin = `http://127.0.0.1:${port}`;
const authSecret = `k_smoke.${"A".repeat(43)}`;

runCfAuth(["init", appName, "--template", "hono-basic"], { cwd: temp });
await assertNoWorkspaceDependencies(appDir);

run("pnpm", ["install", "--no-frozen-lockfile"], { cwd: appDir });
run("pnpm", ["build"], { cwd: appDir });
runCfAuth(["migrate", "--local"], { cwd: appDir });

const dev = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--var",
    `AUTH_SECRET:${authSecret}`,
    "--var",
    `AUTH_PUBLIC_ORIGIN:${origin}`,
    "--show-interactive-dev-session=false",
    "--log-level",
    "error",
  ],
  {
    cwd: appDir,
    env: { ...process.env, CI: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let output = "";
dev.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
dev.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

try {
  await waitForHttp(`${origin}/auth/user`);
  await exerciseAuth(origin);
  console.log(
    `published quickstart smoke passed: @cf-auth/cli@${packageTag} in ${appDir}`,
  );
} finally {
  await stopDevServer();
}

async function assertNoWorkspaceDependencies(appDir) {
  const pkg = await readJsonObject(
    join(appDir, "package.json"),
    "generated quickstart package.json",
  );
  assertNoWorkspaceDependencySpecs(pkg, "generated quickstart package.json");
}

function runCfAuth(args, options = {}) {
  return run(
    "npx",
    ["--yes", "--package", `@cf-auth/cli@${packageTag}`, "cf-auth", ...args],
    options,
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
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

async function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate local port"));
      });
    });
  });
}

async function waitForHttp(originUrl) {
  const deadline = Date.now() + 30_000;
  let lastError;
  let lastStatus;
  while (Date.now() < deadline) {
    if (dev.exitCode !== null) {
      throw new Error(`wrangler dev exited early:\n${output}`);
    }
    try {
      const response = await fetch(originUrl);
      if (response.ok) return;
      lastStatus = response.status;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  const detail =
    lastStatus === undefined
      ? lastError instanceof Error
        ? lastError.message
        : String(lastError)
      : `HTTP ${lastStatus}`;
  throw new Error(
    `Timed out waiting for wrangler dev at ${originUrl}: ${detail}\n${output}`,
  );
}

async function exerciseAuth(originUrl) {
  const email = `smoke-${Date.now()}@example.com`;
  const password = "correct horse battery staple";
  const signup = await jsonPost(`${originUrl}/auth/signup`, {
    email,
    password,
  });
  if (signup.status !== 200) {
    throw new Error(`signup failed: ${signup.status} ${await signup.text()}`);
  }
  const signupCookie = signup.headers.get("Set-Cookie") ?? "";
  assertLocalSessionCookie(signupCookie, "signup");

  const login = await jsonPost(`${originUrl}/auth/login`, {
    identifier: email,
    password,
  });
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${await login.text()}`);
  }
  const loginCookie = login.headers.get("Set-Cookie") ?? "";
  assertLocalSessionCookie(loginCookie, "login");
  const cookie = loginCookie.split(";")[0];

  const user = await fetch(`${originUrl}/auth/user`, {
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

  const logout = await fetch(`${originUrl}/auth/logout`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: originUrl,
    },
  });
  if (logout.status !== 200) {
    throw new Error(`logout failed: ${logout.status} ${await logout.text()}`);
  }
  assertLocalSessionCookie(logout.headers.get("Set-Cookie") ?? "", "logout", {
    cleared: true,
  });

  const userAfterLogout = await fetch(`${originUrl}/auth/user`, {
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

function assertLocalSessionCookie(
  setCookie,
  context,
  options = { cleared: false },
) {
  if (!setCookie.startsWith("cfauth-session=")) {
    throw new Error(`${context} did not set the local cfauth-session cookie`);
  }
  if (setCookie.includes("__Host-cfauth-session=")) {
    throw new Error(`${context} local session cookie must not use __Host-`);
  }
  if (setCookie.includes("__Secure-cfauth-session=")) {
    throw new Error(`${context} local session cookie must not use __Secure-`);
  }
  if (/;\s*Secure(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${context} local session cookie must not use Secure`);
  }
  if (/;\s*Domain=/iu.test(setCookie)) {
    throw new Error(`${context} local session cookie must not set Domain`);
  }
  if (!/;\s*HttpOnly(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${context} local session cookie missing HttpOnly`);
  }
  if (!/;\s*Path=\/(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${context} local session cookie missing Path=/`);
  }
  if (options.cleared && !/;\s*Max-Age=0(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${context} did not clear the session cookie`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopDevServer() {
  if (dev.exitCode !== null) return;
  await new Promise((resolve) => {
    dev.once("close", resolve);
    dev.kill();
  });
}
