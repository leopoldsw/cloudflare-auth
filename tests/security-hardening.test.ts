import { readFile } from "node:fs/promises";

import {
  applyD1Migrations,
  createMockEmailAdapter,
  createSqliteD1Database,
} from "@cf-auth/testing";
import {
  cloudflareRateLimitPrefilter,
  createAuthHandler,
  defineAuthConfig,
  redactLogValue,
  type AuthConfig,
  verifyTurnstileToken,
} from "@cf-auth/worker";
import { describe, expect, it } from "vitest";

const origin = "http://localhost:8787";
const authSecret = "k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function setup(
  overrides: Partial<AuthConfig> = {},
  envOverrides: Record<string, unknown> = {},
) {
  const db = createSqliteD1Database();
  await applyD1Migrations(db, [
    await readFile("migrations/0001_initial.sql", "utf8"),
    await readFile("migrations/0002_indexes.sql", "utf8"),
  ]);
  const email = createMockEmailAdapter();
  const config = defineAuthConfig({
    appName: "Security Test",
    basePath: "/auth",
    email,
    runtime: {
      mode: "from-env",
      publicOrigin: "from-env",
      trustedHosts: ["localhost:8787"],
    },
    ...overrides,
  });
  const handler = createAuthHandler(config);
  const env = {
    AUTH_DB: db,
    AUTH_SECRET: authSecret,
    AUTH_ENV: "development",
    AUTH_PUBLIC_ORIGIN: origin,
    ...envOverrides,
  };
  async function authFetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.method && init.method !== "GET" && !headers.has("Origin"))
      headers.set("Origin", origin);
    const response = await handler.fetch(
      new Request(`${origin}${path}`, { ...init, headers }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    if (!response) throw new Error(`No auth response for ${path}`);
    return response;
  }
  return { db, authFetch };
}

describe("security hardening helpers", () => {
  it("enforces Turnstile before account-specific validation", async () => {
    const required = await setup({
      turnstile: {
        mode: "required",
        endpoints: ["magic_link_request"],
        verify: async () => true,
      },
    });
    const missing = await required.authFetch("/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not an email" }),
    });
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: "turnstile_required" },
    });

    const failed = await setup({
      turnstile: {
        mode: "required",
        endpoints: ["magic_link_request"],
        verify: async () => false,
      },
    });
    const response = await failed.authFetch("/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "not an email",
        turnstileToken: "client-token",
      }),
    });
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "turnstile_failed" },
    });
  });

  it("posts Turnstile siteverify requests with secret, response, and remote IP", async () => {
    let postedUrl = "";
    let postedBody = "";
    const ok = await verifyTurnstileToken({
      token: "client-token",
      secret: "server-secret",
      remoteIp: "203.0.113.9",
      fetcher: async (url, init) => {
        postedUrl = String(url);
        postedBody =
          init?.body instanceof URLSearchParams
            ? init.body.toString()
            : String(init?.body ?? "");
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const params = new URLSearchParams(postedBody);
    expect(ok).toBe(true);
    expect(postedUrl).toBe(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    );
    expect(params.get("secret")).toBe("server-secret");
    expect(params.get("response")).toBe("client-token");
    expect(params.get("remoteip")).toBe("203.0.113.9");
  });

  it("short-circuits D1 rate-limit writes when a Cloudflare binding denies", async () => {
    const { authFetch, db } = await setup(
      {},
      {
        AUTH_RATE_LIMITER: {
          limit: async () => ({ success: false }),
        },
      },
    );
    const response = await authFetch("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "prefilter@example.com",
        password: "correct horse battery staple",
      }),
    });
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "rate_limited" },
    });
    await expect(
      db.prepare("SELECT count(*) AS count FROM rate_limits").first("count"),
    ).resolves.toBe(0);
    await expect(
      db.prepare("SELECT count(*) AS count FROM users").first("count"),
    ).resolves.toBe(0);
  });

  it("allows missing Cloudflare rate-limit bindings and forwards keys to present bindings", async () => {
    await expect(
      cloudflareRateLimitPrefilter({ env: {}, key: "auth-key" }),
    ).resolves.toBe(true);

    let receivedKey = "";
    await expect(
      cloudflareRateLimitPrefilter({
        env: {
          CUSTOM_LIMITER: {
            limit: async ({ key }: { key: string }) => {
              receivedKey = key;
              return { success: false };
            },
          },
        },
        binding: "CUSTOM_LIMITER",
        key: "auth-key",
      }),
    ).resolves.toBe(false);
    expect(receivedKey).toBe("auth-key");
  });

  it("redacts auth tokens and secrets from log strings", () => {
    const rawToken = `cfauth.magic.k1.${"A".repeat(43)}`;
    const redacted = redactLogValue(
      `token=${rawToken} AUTH_SECRET=k1.${"B".repeat(43)}`,
    );
    expect(redacted).toContain("token=[REDACTED_TOKEN]");
    expect(redacted).toContain("AUTH_SECRET=[REDACTED]");
    expect(redacted).not.toContain(rawToken);
  });
});
