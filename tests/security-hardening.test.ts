import {
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

import { applyRootD1Migrations } from "./migration-helpers.js";

const origin = "http://localhost:8787";
const authSecret = "k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function setup(
  overrides: Partial<AuthConfig> = {},
  envOverrides: Record<string, unknown> = {},
) {
  const db = createSqliteD1Database();
  await applyRootD1Migrations(db);
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
    passwordHashing: {
      profile: "development-fast",
      maxConcurrentHashesPerIsolate: 1,
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
  it("rejects unknown Turnstile endpoint names at config definition time", () => {
    expect(() =>
      defineAuthConfig({
        appName: "Security Test",
        basePath: "/auth",
        turnstile: {
          mode: "required",
          endpoints: ["unknown_endpoint" as never],
        },
      }),
    ).toThrow(/unknown Turnstile endpoint/);
    expect(() =>
      defineAuthConfig({
        appName: "Security Test",
        basePath: "/auth",
        turnstile: {
          contextBinding: "unknown" as never,
        },
      }),
    ).toThrow(/invalid Turnstile context binding/);
  });

  it("rejects invalid password hashing concurrency at config definition time", () => {
    expect(() =>
      defineAuthConfig({
        appName: "Security Test",
        basePath: "/auth",
        passwordHashing: {
          profile: "workers-balanced",
          maxConcurrentHashesPerIsolate: 0,
        },
      }),
    ).toThrow(/invalid password hash concurrency/);
  });

  it("enforces Turnstile before account-specific validation", async () => {
    const required = await setup({
      turnstile: {
        mode: "required",
        endpoints: ["magic_link_request"],
        contextBinding: "strict",
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
        contextBinding: "strict",
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

  it("enforces Turnstile before reset token lookup and password hashing", async () => {
    const required = await setup({
      passwordHashing: {
        profile: "development-fast",
        maxConcurrentHashesPerIsolate: 1,
        queueTimeoutMs: 1,
      },
      turnstile: {
        mode: "required",
        endpoints: ["password_reset_confirm"],
        contextBinding: "strict",
        verify: async () => true,
      },
    });
    const inactiveResetToken = `cfauth.reset.k1.${"A".repeat(43)}`;
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        required.authFetch("/auth/password/reset/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: inactiveResetToken,
            password: "new correct horse battery staple",
          }),
        }),
      ),
    );

    await expect(
      Promise.all(responses.map((response) => response.json())),
    ).resolves.toEqual(
      Array.from({ length: 10 }, () => ({
        error: {
          code: "turnstile_required",
          message: "Turnstile token is required",
        },
        requestId: expect.stringMatching(/^req_/),
      })),
    );
    await expect(
      required.db
        .prepare("SELECT count(*) AS count FROM rate_limits")
        .first("count"),
    ).resolves.toBe(0);
    await expect(
      required.db
        .prepare("SELECT count(*) AS count FROM verification_tokens")
        .first("count"),
    ).resolves.toBe(0);
  });

  it("posts Turnstile siteverify requests with secret, response, and remote IP", async () => {
    let postedUrl = "";
    let postedBody = "";
    const ok = await verifyTurnstileToken({
      token: "client-token",
      secret: "server-secret",
      remoteIp: "203.0.113.9",
      expectedHostname: "app.example.com",
      expectedAction: "password_login",
      fetcher: async (url, init) => {
        postedUrl = String(url);
        postedBody =
          init?.body instanceof URLSearchParams
            ? init.body.toString()
            : String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            success: true,
            hostname: "app.example.com",
            action: "password_login",
          }),
          { headers: { "Content-Type": "application/json" } },
        );
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

  it("rejects missing or mismatched Turnstile hostname and action", async () => {
    const verify = (payload: Record<string, unknown>) =>
      verifyTurnstileToken({
        token: "client-token",
        secret: "server-secret",
        expectedHostname: "app.example.com",
        expectedAction: "password_login",
        fetcher: async () =>
          new Response(JSON.stringify(payload), {
            headers: { "Content-Type": "application/json" },
          }),
      });

    await expect(verify({ success: true })).resolves.toBe(false);
    await expect(
      verify({
        success: true,
        hostname: "other.example.com",
        action: "password_login",
      }),
    ).resolves.toBe(false);
    await expect(
      verify({
        success: true,
        hostname: "app.example.com",
        action: "signup",
      }),
    ).resolves.toBe(false);
  });

  it("derives strict Turnstile context from public origin and endpoint", async () => {
    const seen: Array<{
      expectedHostname: string | undefined;
      expectedAction: string | undefined;
    }> = [];
    for (const contextBinding of ["strict", "disabled"] as const) {
      const configured = await setup({
        turnstile: {
          mode: "required",
          endpoints: ["magic_link_request"],
          contextBinding,
          verify: async (input) => {
            seen.push({
              expectedHostname: input.expectedHostname,
              expectedAction: input.expectedAction,
            });
            return true;
          },
        },
      });
      const response = await configured.authFetch("/auth/magic-link/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `${contextBinding}@example.com`,
          turnstileToken: "client-token",
        }),
      });
      expect(response.status).toBe(200);
    }
    expect(seen).toEqual([
      {
        expectedHostname: "localhost",
        expectedAction: "magic_link_request",
      },
      { expectedHostname: undefined, expectedAction: undefined },
    ]);
  });

  it("treats Turnstile verifier transport and payload errors as failed challenges", async () => {
    await expect(
      verifyTurnstileToken({
        token: "client-token",
        secret: "server-secret",
        fetcher: async () => {
          throw new Error("siteverify unavailable");
        },
      }),
    ).resolves.toBe(false);
    await expect(
      verifyTurnstileToken({
        token: "client-token",
        secret: "server-secret",
        fetcher: async () =>
          new Response("not json", {
            headers: { "Content-Type": "application/json" },
          }),
      }),
    ).resolves.toBe(false);
  });

  it("redacts sensitive values from API error messages", async () => {
    const rawToken = `cfauth.magic.k1.${"A".repeat(43)}`;
    const secretMaterial = "B".repeat(43);
    const previousSecretMaterial = "C".repeat(43);
    const required = await setup({
      turnstile: {
        mode: "required",
        endpoints: ["magic_link_request"],
        contextBinding: "strict",
        verify: async ({ token }) => {
          throw new Error(
            `verifier failed url=https://example.com/auth/magic-link/verify?token=${token}&next=/dashboard token=${token} identifier=raw-identifier username=raw-user email=person@example.com remoteIp=2001:db8::1 userAgent="Mozilla/5.0 Secret Browser" AUTH_SECRET=k1.${secretMaterial}; token: ${token} identifier: colon-identifier username: colon-user User-Agent: Mozilla/5.0 Colon Browser CF-Connecting-IP: [2001:db8::1] AUTH_SECRET_PREVIOUS: k0.${previousSecretMaterial}`,
          );
        },
      },
    });
    const response = await required.authFetch("/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "person@example.com",
        turnstileToken: rawToken,
      }),
    });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('"code":"server_error"');
    expect(body).toContain("url=[REDACTED_TOKEN_URL]");
    expect(body).toContain("token=[REDACTED]");
    expect(body).toContain("email=[REDACTED]");
    expect(body).toContain("AUTH_SECRET=[REDACTED]");
    expect(body).toContain("identifier=[REDACTED]");
    expect(body).toContain("username=[REDACTED]");
    expect(body).toContain("token: [REDACTED]");
    expect(body).toContain("identifier: [REDACTED]");
    expect(body).toContain("username: [REDACTED]");
    expect(body).toContain("User-Agent: [REDACTED]");
    expect(body).toContain("AUTH_SECRET_PREVIOUS: [REDACTED]");
    expect(body).not.toContain(rawToken);
    expect(body).not.toContain("/auth/magic-link/verify?token=");
    expect(body).not.toContain("raw-identifier");
    expect(body).not.toContain("raw-user");
    expect(body).not.toContain("colon-identifier");
    expect(body).not.toContain("colon-user");
    expect(body).not.toContain("person@example.com");
    expect(body).not.toContain("2001:db8::1");
    expect(body).not.toContain("Secret Browser");
    expect(body).not.toContain("Colon Browser");
    expect(body).not.toContain(secretMaterial);
    expect(body).not.toContain(previousSecretMaterial);
    expect(body).toContain("[REDACTED_IP]");
    expect(body).toContain("userAgent=[REDACTED]");
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
    expect(response.status).toBe(429);
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

  it("skips Cloudflare rate-limit bindings when the edge prefilter is disabled", async () => {
    const { authFetch, db } = await setup(
      {
        rateLimit: { adapter: "d1", edgePrefilter: "disabled" },
      },
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
        email: "prefilter-disabled@example.com",
        password: "correct horse battery staple",
      }),
    });
    expect(response.status).toBe(200);
    await expect(
      db.prepare("SELECT count(*) AS count FROM rate_limits").first("count"),
    ).resolves.toBe(2);
    await expect(
      db.prepare("SELECT count(*) AS count FROM users").first("count"),
    ).resolves.toBe(1);
  });

  it("allows missing Cloudflare rate-limit bindings and forwards keys to present bindings", async () => {
    await expect(
      cloudflareRateLimitPrefilter({ env: {}, key: "auth-key" }),
    ).resolves.toBe(true);
    await expect(
      cloudflareRateLimitPrefilter({
        env: {
          AUTH_RATE_LIMITER: {
            limit: async () => {
              throw new Error("transient limiter failure");
            },
          },
        },
        key: "auth-key",
      }),
    ).resolves.toBe(true);
    await expect(
      cloudflareRateLimitPrefilter({
        env: {
          AUTH_RATE_LIMITER: {
            limit: async () => ({}) as { success: boolean },
          },
        },
        key: "auth-key",
      }),
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
      `token=${rawToken} AUTH_SECRET=k1.${"B".repeat(43)} AUTH_SECRET_PREVIOUS=k0.${"C".repeat(43)}`,
    );
    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).toContain("AUTH_SECRET=[REDACTED]");
    expect(redacted).toContain("AUTH_SECRET_PREVIOUS=[REDACTED]");
    expect(redacted).not.toContain(rawToken);
    expect(redacted).not.toContain("B".repeat(43));
    expect(redacted).not.toContain("C".repeat(43));
  });

  it("redacts colon-separated sensitive log fields", () => {
    const rawToken = `cfauth.magic.k1.${"A".repeat(43)}`;
    const secretMaterial = "B".repeat(43);
    const redacted = redactLogValue(
      `AUTH_SECRET:k1.${secretMaterial} token: ${rawToken} identifier: raw-identifier username: raw-user password: correct horse battery staple User-Agent: Mozilla/5.0 Secret Browser CF-Connecting-IP: [2001:db8::1]`,
    );

    expect(redacted).toContain("AUTH_SECRET:[REDACTED]");
    expect(redacted).toContain("token: [REDACTED]");
    expect(redacted).toContain("identifier: [REDACTED]");
    expect(redacted).toContain("username: [REDACTED]");
    expect(redacted).toContain("password: [REDACTED]");
    expect(redacted).toContain("User-Agent: [REDACTED]");
    expect(redacted).toContain("[REDACTED_IP]");
    expect(redacted).not.toContain(rawToken);
    expect(redacted).not.toContain(secretMaterial);
    expect(redacted).not.toContain("raw-identifier");
    expect(redacted).not.toContain("raw-user");
    expect(redacted).not.toContain("correct horse battery staple");
    expect(redacted).not.toContain("Secret Browser");
    expect(redacted).not.toContain("2001:db8::1");
  });

  it("redacts token URLs, passwords, emails, and authorization material", () => {
    const rawToken = `cfauth.reset.k1.${"D".repeat(43)}`;
    const tokenHash = `hmac-sha256$v=1$kid=k1$purpose=session$hash=${"E".repeat(43)}`;
    const passwordHash = `scrypt$v=1$n=16384$r=8$p=1$keylen=32$maxmem=67108864$salt=${"F".repeat(22)}$hash=${"G".repeat(43)}`;
    const payload = JSON.stringify({
      url: `https://example.com/auth/password/reset?token=${rawToken}`,
      password: "correct horse battery staple",
      passwordHash,
      email: "person@example.com",
      identifier: "raw-identifier",
      normalized_username: "raw-user",
      remoteIp: "2001:db8::1",
      userAgent: "Mozilla/5.0 Secret Browser",
      raw_token: rawToken,
      token_hash: tokenHash,
      sessionToken: rawToken,
      tokenType: "password_reset",
      authorization: "Bearer sk-test-secret",
    });
    const redactedJson = redactLogValue(payload);
    const redacted = redactLogValue(
      `${payload} leaked ${tokenHash} ${passwordHash}`,
    );

    expect(redacted).toContain('"url":"[REDACTED_TOKEN_URL]"');
    expect(redacted).toContain('"password":"[REDACTED]"');
    expect(redacted).toContain('"passwordHash":"[REDACTED]"');
    expect(redacted).toContain('"email":"[REDACTED]"');
    expect(redacted).toContain('"identifier":"[REDACTED]"');
    expect(redacted).toContain('"normalized_username":"[REDACTED]"');
    expect(redacted).toContain('"raw_token":"[REDACTED]"');
    expect(redacted).toContain('"token_hash":"[REDACTED]"');
    expect(redacted).toContain('"sessionToken":"[REDACTED]"');
    expect(redacted).toContain('"userAgent":"[REDACTED]"');
    expect(redacted).toContain('"authorization":"[REDACTED]"');
    expect(redacted).toContain('"tokenType":"password_reset"');
    expect(() => JSON.parse(redactedJson)).not.toThrow();
    expect(redacted).not.toContain("/auth/password/reset?token=");
    expect(redacted).not.toContain(rawToken);
    expect(redacted).not.toContain(tokenHash);
    expect(redacted).not.toContain(passwordHash);
    expect(redacted).not.toContain("raw-identifier");
    expect(redacted).not.toContain("raw-user");
    expect(redacted).not.toContain("correct horse battery staple");
    expect(redacted).not.toContain("person@example.com");
    expect(redacted).not.toContain("2001:db8::1");
    expect(redacted).not.toContain("Secret Browser");
    expect(redacted).toContain("[REDACTED_IP]");
    expect(redacted).toContain("[REDACTED_TOKEN_HASH]");
    expect(redacted).toContain("[REDACTED_PASSWORD_HASH]");
  });
});
