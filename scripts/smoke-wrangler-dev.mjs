import { spawn, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const exampleDir = process.argv[2] ?? "examples/hono-basic";
const persistTo = await mkdtemp(join(tmpdir(), "cf-auth-wrangler-dev-"));
const port = await findOpenPort();
const origin = `http://127.0.0.1:${port}`;
const authSecret = `k_smoke.${"A".repeat(43)}`;

run("pnpm", [
  "--dir",
  exampleDir,
  "exec",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "AUTH_DB",
  "--local",
  "--persist-to",
  persistTo,
]);

const dev = spawn(
  "pnpm",
  [
    "--dir",
    exampleDir,
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--persist-to",
    persistTo,
    "--var",
    `AUTH_SECRET:${authSecret}`,
    "--var",
    `AUTH_PUBLIC_ORIGIN:${origin}`,
    "--show-interactive-dev-session=false",
    "--log-level",
    "error",
  ],
  {
    cwd: root,
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
  await waitForHttp(origin);
  await exerciseAuth(origin);
  console.log(`wrangler dev smoke passed: ${exampleDir} at ${origin}`);
} finally {
  await stopDevServer();
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
  while (Date.now() < deadline) {
    if (dev.exitCode !== null) {
      throw new Error(`wrangler dev exited early:\n${output}`);
    }
    try {
      const response = await fetch(originUrl);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(
    `Timed out waiting for wrangler dev: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }\n${output}`,
  );
}

async function exerciseAuth(originUrl) {
  const email = "smoke@example.com";
  const password = "correct horse battery staple";
  const signup = await jsonPost(`${originUrl}/auth/signup`, {
    email,
    password,
  });
  if (signup.status !== 200) {
    throw new Error(`signup failed: ${signup.status} ${await signup.text()}`);
  }
  const signupCookie = signup.headers.get("Set-Cookie") ?? "";
  if (!signupCookie.includes("cfauth-session=")) {
    throw new Error("signup did not set a session cookie");
  }

  const login = await jsonPost(`${originUrl}/auth/login`, {
    identifier: email,
    password,
  });
  if (login.status !== 200) {
    throw new Error(`login failed: ${login.status} ${await login.text()}`);
  }
  const loginCookie = login.headers.get("Set-Cookie") ?? "";
  if (!loginCookie.includes("cfauth-session=")) {
    throw new Error("login did not set a session cookie");
  }
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
  if (!(logout.headers.get("Set-Cookie") ?? "").includes("Max-Age=0")) {
    throw new Error("logout did not clear the session cookie");
  }

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
