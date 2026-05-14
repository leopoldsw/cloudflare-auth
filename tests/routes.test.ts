import { readFile } from "node:fs/promises";

import {
  AuthCryptoError,
  hashRawAuthToken,
  parseAuthKeyRing,
} from "@cf-auth/core";
import {
  applyD1Migrations,
  createMockEmailAdapter,
  createSqliteD1Database,
} from "@cf-auth/testing";
import {
  createAuthHandler,
  defineAuthConfig,
  type AuthConfig,
} from "@cf-auth/worker";
import { describe, expect, it } from "vitest";

const origin = "http://localhost:8787";
const authSecret = "k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function setup(overrides: Partial<AuthConfig> = {}) {
  const db = createSqliteD1Database();
  await applyD1Migrations(db, [
    await readFile("migrations/0001_initial.sql", "utf8"),
    await readFile("migrations/0002_indexes.sql", "utf8"),
  ]);
  const email = createMockEmailAdapter();
  const config = defineAuthConfig({
    appName: "Route Test",
    basePath: "/auth",
    email,
    runtime: {
      mode: "from-env",
      publicOrigin: "from-env",
      trustedHosts: ["localhost:8787", "example.com"],
    },
    passwordHashing: {
      profile: "development-fast",
      maxConcurrentHashesPerIsolate: 1,
    },
    redirects: {
      defaultAfterLogin: "/dashboard",
      defaultAfterLogout: "/",
      defaultAfterEmailVerification: "/dashboard",
      defaultAfterPasswordReset: "/login",
      allowedOrigins: ["https://example.com"],
      allowedPreviewOrigins: [],
    },
    ...overrides,
  });
  const handler = createAuthHandler(config);
  const env = {
    AUTH_DB: db,
    AUTH_SECRET: authSecret,
    AUTH_ENV: "development",
    AUTH_PUBLIC_ORIGIN: origin,
  };
  const deferred: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      deferred.push(Promise.resolve(promise));
    },
  } as unknown as ExecutionContext;
  async function flushDeferred() {
    while (deferred.length > 0) {
      await Promise.all(deferred.splice(0));
    }
  }
  async function authFetch(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (init.method && init.method !== "GET" && !headers.has("Origin"))
      headers.set("Origin", origin);
    const response = await handler.fetch(
      new Request(`${origin}${path}`, { ...init, headers }),
      env,
      ctx,
    );
    await flushDeferred();
    if (!response) throw new Error(`No auth response for ${path}`);
    return response;
  }
  return { db, email, config, handler, env, authFetch, ctx, flushDeferred };
}

describe("auth HTTP runtime", () => {
  it("rejects invalid origin allowlists and unsupported SameSite config", () => {
    expect(() =>
      defineAuthConfig({
        appName: "Bad Redirect",
        basePath: "/auth",
        redirects: {
          allowedOrigins: ["https://example.com/path"],
        } as AuthConfig["redirects"],
      }),
    ).toThrow(AuthCryptoError);
    expect(() =>
      defineAuthConfig({
        appName: "Bad Request Origin",
        basePath: "/auth",
        security: {
          allowedRequestOrigins: ["https://*.example.com"],
        } as AuthConfig["security"],
      }),
    ).toThrow(AuthCryptoError);
    expect(() =>
      defineAuthConfig({
        appName: "Bad Runtime Origin",
        basePath: "/auth",
        runtime: {
          mode: "production",
          publicOrigin: "https://example.com/path",
          trustedHosts: [],
        },
      }),
    ).toThrow(AuthCryptoError);
    expect(() =>
      defineAuthConfig({
        appName: "Bad Cookie",
        basePath: "/auth",
        session: { sameSite: "none" } as unknown as AuthConfig["session"],
      }),
    ).toThrow(AuthCryptoError);
    expect(() =>
      defineAuthConfig({
        appName: "Bad Cookie Name",
        basePath: "/auth",
        session: { cookieName: "bad name" } as AuthConfig["session"],
      }),
    ).toThrow(AuthCryptoError);
    expect(() =>
      defineAuthConfig({
        appName: "Bad Cookie Domain",
        basePath: "/auth",
        session: { domain: "example.com" } as AuthConfig["session"],
      }),
    ).toThrow(AuthCryptoError);
    expect(() =>
      defineAuthConfig({
        appName: "Bad Host Cookie Domain",
        basePath: "/auth",
        session: {
          cookieName: "__Host-app",
          domain: ".example.com",
        } as AuthConfig["session"],
      }),
    ).toThrow(AuthCryptoError);
    expect(() =>
      defineAuthConfig({
        appName: "Bad Request Body Limit",
        basePath: "/auth",
        request: {
          maxBodyBytes: 0,
          requireOriginOnUnsafeMethods: true,
        },
      }),
    ).toThrow(AuthCryptoError);
    expect(
      defineAuthConfig({
        appName: "Local Request Origin",
        basePath: "/auth",
        security: {
          allowedRequestOrigins: ["http://localhost:5173"],
        } as AuthConfig["security"],
      }).security.allowedRequestOrigins,
    ).toEqual(["http://localhost:5173"]);
  });

  it("rejects invalid feature flag combinations", () => {
    const invalid = (overrides: Partial<AuthConfig>) =>
      defineAuthConfig({
        appName: "Invalid Feature Config",
        basePath: "/auth",
        ...overrides,
      });
    expect(() =>
      invalid({
        magicLink: {
          allowSignups: true,
        } as AuthConfig["magicLink"],
        signup: {
          enabled: false,
        } as AuthConfig["signup"],
      }),
    ).toThrow(AuthCryptoError);
    expect(() =>
      invalid({
        magicLink: {
          activeTokenPolicy: "bad-policy",
        } as unknown as AuthConfig["magicLink"],
      }),
    ).toThrow(AuthCryptoError);
    expect(() =>
      invalid({
        signup: {
          enumerationSafe: true,
          requireEmailVerificationBeforeSession: false,
          username: { enabled: true, required: false },
        } as AuthConfig["signup"],
      }),
    ).toThrow(AuthCryptoError);
    expect(() =>
      invalid({
        emailVerification: {
          enabled: false,
        } as AuthConfig["emailVerification"],
        login: { requireVerifiedEmail: true } as AuthConfig["login"],
      }),
    ).toThrow(AuthCryptoError);
  });

  it("signs up, reads current user, logs out, and logs in", async () => {
    const { authFetch } = await setup();
    const signup = await authFetch("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "Person@example.com",
        username: "person",
        password: "correct horse battery staple",
      }),
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get("Set-Cookie") ?? "";
    expect(cookie).toContain("cfauth-session=");

    const me = await authFetch("/auth/user", { headers: { Cookie: cookie } });
    await expect(me.json()).resolves.toMatchObject({
      user: { email: "Person@example.com", username: "person" },
    });

    const logout = await authFetch("/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
    const loggedOut = await authFetch("/auth/user", {
      headers: { Cookie: cookie },
    });
    await expect(loggedOut.json()).resolves.toEqual({ user: null });

    const login = await authFetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "person",
        password: "correct horse battery staple",
      }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("Set-Cookie")).toContain("cfauth-session=");
  });

  it("uses confirmation-post magic links and does not consume on GET", async () => {
    const { authFetch, email, db } = await setup();
    await signup(authFetch, "magic@example.com");
    const request = await authFetch("/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "magic@example.com",
        redirectTo: "/inside",
      }),
    });
    expect(request.status).toBe(200);
    const message = email.messages.find((item) => item.type === "magic");
    expect(message?.url).toContain("/auth/magic-link/verify?token=");
    const token = message?.token ?? "";
    const tokenHash = hashRawAuthToken(
      token,
      parseAuthKeyRing(authSecret),
      "magic_link",
    );

    const get = await authFetch(
      `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    );
    expect(get.status).toBe(200);
    const beforeConsume = await db
      .prepare(
        "SELECT used_at, attempts FROM verification_tokens WHERE token_hash = ?",
      )
      .bind(tokenHash)
      .first<{
        used_at: number | null;
        attempts: number;
      }>();
    expect(beforeConsume).toEqual({ used_at: null, attempts: 0 });

    const consume = await authFetch("/auth/magic-link/consume", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    expect(consume.status).toBe(303);
    expect(consume.headers.get("Location")).toBe("/inside");
    expect(consume.headers.get("Set-Cookie")).toContain("cfauth-session=");

    const replay = await authFetch("/auth/magic-link/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(replay.status).toBe(400);
  });

  it("verifies email and resets password through POST confirmation flows", async () => {
    const { authFetch, email } = await setup();
    const signupResponse = await signup(authFetch, "verify@example.com");
    const oldCookie = signupResponse.headers.get("Set-Cookie") ?? "";
    const verify =
      email.messages.find((item) => item.type === "verify")?.token ?? "";

    const verifyGet = await authFetch(
      `/auth/email/verify?token=${encodeURIComponent(verify)}`,
    );
    expect(verifyGet.status).toBe(200);
    const verifyPost = await authFetch("/auth/email/verify/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: verify }),
    });
    await expect(verifyPost.json()).resolves.toMatchObject({
      user: { emailVerified: true },
      redirectTo: "/dashboard",
    });

    const request = await authFetch("/auth/password/reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "verify@example.com",
        afterResetRedirectTo: "/login",
      }),
    });
    expect(request.status).toBe(200);
    const reset =
      email.messages.find((item) => item.type === "reset")?.token ?? "";
    const resetGet = await authFetch(
      `/auth/password/reset?token=${encodeURIComponent(reset)}`,
    );
    expect(resetGet.status).toBe(200);
    const confirm = await authFetch("/auth/password/reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: reset,
        password: "new correct horse battery staple",
      }),
    });
    await expect(confirm.json()).resolves.toMatchObject({
      user: { email: "verify@example.com" },
      redirectTo: "/login",
    });
    const oldSession = await authFetch("/auth/user", {
      headers: { Cookie: oldCookie },
    });
    await expect(oldSession.json()).resolves.toEqual({ user: null });
  });

  it("rejects verification and reset confirmation for disabled users", async () => {
    const { authFetch, email, db } = await setup();
    await signup(authFetch, "disabled-reset@example.com");
    const verify =
      email.messages.find((item) => item.type === "verify")?.token ?? "";
    await authFetch("/auth/password/reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "disabled-reset@example.com" }),
    });
    const reset =
      email.messages.find((item) => item.type === "reset")?.token ?? "";
    const before = await db
      .prepare("SELECT password_hash FROM users WHERE normalized_email = ?")
      .bind("disabled-reset@example.com")
      .first<{ password_hash: string }>();
    await db
      .prepare("UPDATE users SET disabled_at = ? WHERE normalized_email = ?")
      .bind(Date.now(), "disabled-reset@example.com")
      .run();

    const verifyResponse = await authFetch("/auth/email/verify/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: verify }),
    });
    expect(verifyResponse.status).toBe(400);
    await expect(verifyResponse.json()).resolves.toMatchObject({
      error: { code: "invalid_token" },
    });
    await expect(
      db
        .prepare(
          "SELECT email_verified_at FROM users WHERE normalized_email = ?",
        )
        .bind("disabled-reset@example.com")
        .first("email_verified_at"),
    ).resolves.toBeNull();

    const confirm = await authFetch("/auth/password/reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: reset,
        password: "new correct horse battery staple",
      }),
    });

    expect(confirm.status).toBe(400);
    await expect(confirm.json()).resolves.toMatchObject({
      error: { code: "invalid_token" },
    });
    const after = await db
      .prepare("SELECT password_hash FROM users WHERE normalized_email = ?")
      .bind("disabled-reset@example.com")
      .first<{ password_hash: string }>();
    expect(after?.password_hash).toBe(before?.password_hash);
  });

  it("rejects unsafe redirects, oversized bodies, missing production origins, and disallowed preflights", async () => {
    const limited = await setup({
      request: { maxBodyBytes: 8, requireOriginOnUnsafeMethods: true },
    });
    const oversized = await limited.authFetch("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ too: "large" }),
    });
    expect(oversized.status).toBe(413);

    const { authFetch, handler, env } = await setup();
    const unsafe = await authFetch("/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "a@example.com",
        redirectTo: "%2f%2fevil.com",
      }),
    });
    expect(unsafe.status).toBe(400);

    const invalidJson = await authFetch("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toMatchObject({
      error: { code: "validation_failed" },
    });

    const prod = await handler.fetch(
      new Request("https://example.com/auth/logout", { method: "POST" }),
      {
        ...env,
        AUTH_ENV: "production",
        AUTH_PUBLIC_ORIGIN: "https://example.com",
      },
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(prod?.status).toBe(403);

    const badPublicOrigin = await handler.fetch(
      new Request("https://example.com/auth/user"),
      {
        ...env,
        AUTH_ENV: "production",
        AUTH_PUBLIC_ORIGIN: "https://example.com/path",
      },
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(badPublicOrigin?.status).toBe(500);
    await expect(badPublicOrigin?.json()).resolves.toMatchObject({
      error: { code: "config_error" },
    });

    const allowedPreflight = await handler.fetch(
      new Request(`${origin}/auth/signup`, {
        method: "OPTIONS",
        headers: { Origin: origin },
      }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(allowedPreflight?.status).toBe(204);
    expect(allowedPreflight?.headers.get("Access-Control-Allow-Origin")).toBe(
      origin,
    );
  });

  it("keeps rate-limit keys opaque and feature-disabled endpoints side-effect free", async () => {
    const { authFetch, db } = await setup({
      passwordReset: { enabled: false } as AuthConfig["passwordReset"],
    });
    const response = await authFetch("/auth/password/reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "raw@example.com" }),
    });
    expect(response.status).toBe(404);
    const tokenCount = await db
      .prepare("SELECT count(*) AS count FROM verification_tokens")
      .first<number>("count");
    expect(tokenCount).toBe(0);
    const rows = await db
      .prepare("SELECT key FROM rate_limits")
      .all<{ key: string }>();
    expect(JSON.stringify(rows.results)).not.toContain("raw@example.com");
  });

  it("writes redacted auth events for core auth outcomes", async () => {
    const { authFetch, db } = await setup();
    const headers = {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.9",
      "User-Agent": "Secret Test Browser",
    };
    await authFetch("/auth/signup", {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: "events@example.com",
        password: "correct horse battery staple",
      }),
    });
    const failed = await authFetch("/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({
        identifier: "events@example.com",
        password: "wrong horse battery staple",
      }),
    });
    expect(failed.status).toBe(401);
    const ok = await authFetch("/auth/login", {
      method: "POST",
      headers,
      body: JSON.stringify({
        identifier: "events@example.com",
        password: "correct horse battery staple",
      }),
    });
    expect(ok.status).toBe(200);

    const events = await db
      .prepare(
        "SELECT event_type, ip_hash, user_agent_hash, metadata_json FROM auth_events ORDER BY created_at",
      )
      .all<{
        event_type: string;
        ip_hash: string | null;
        user_agent_hash: string | null;
        metadata_json: string;
      }>();
    expect(events.results?.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        "signup_success",
        "password_login_failed",
        "password_login_success",
      ]),
    );
    for (const event of events.results ?? []) {
      expect(event.ip_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(event.user_agent_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.stringify(event)).not.toMatch(
        /events@example\.com|203\.0\.113\.9|Secret Test Browser|correct horse|wrong horse/,
      );
    }
  });

  it("supports enumeration-safe signup without setting a session", async () => {
    const { authFetch } = await setup({
      signup: {
        enabled: true,
        requireEmailVerificationBeforeSession: true,
        enumerationSafe: true,
        username: { enabled: true, required: false },
      } as AuthConfig["signup"],
    });
    const response = await authFetch("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "safe@example.com",
        password: "correct horse battery staple",
      }),
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });

  it("creates at most one magic-link JIT signup session for concurrent consumes", async () => {
    const { authFetch, email, db } = await setup({
      magicLink: {
        allowSignups: true,
        expiresInMinutes: 15,
        activeTokenPolicy: "invalidate-previous",
      },
    });
    await authFetch("/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "jit@example.com" }),
    });
    const token =
      email.messages.find((item) => item.type === "magic")?.token ?? "";
    const [first, second] = await Promise.all([
      authFetch("/auth/magic-link/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      authFetch("/auth/magic-link/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);
    await expect(
      db
        .prepare(
          "SELECT count(*) AS count FROM users WHERE normalized_email = ?",
        )
        .bind("jit@example.com")
        .first("count"),
    ).resolves.toBe(1);
    await expect(
      db.prepare("SELECT count(*) AS count FROM sessions").first("count"),
    ).resolves.toBe(1);
  });
});

async function signup(
  authFetch: (path: string, init?: RequestInit) => Promise<Response>,
  email: string,
) {
  return authFetch("/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery staple" }),
  });
}
