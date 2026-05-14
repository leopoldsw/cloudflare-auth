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
  type AuthConfigInput,
} from "@cf-auth/worker";
import { describe, expect, it } from "vitest";

const origin = "http://localhost:8787";
const authSecret = "k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

async function setup(overrides: Partial<AuthConfigInput> = {}) {
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
    expect(() =>
      defineAuthConfig({
        appName: "Bad Hash Queue Timeout",
        basePath: "/auth",
        passwordHashing: {
          queueTimeoutMs: 0,
        },
      }),
    ).toThrow(AuthCryptoError);
    expect(() =>
      defineAuthConfig({
        appName: "Bad Enumeration Delay",
        basePath: "/auth",
        request: {
          enumerationMinResponseMs: -1,
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

  it("normalizes partial runtime overrides passed directly to the handler", async () => {
    const db = createSqliteD1Database();
    await applyD1Migrations(db, [
      await readFile("migrations/0001_initial.sql", "utf8"),
      await readFile("migrations/0002_indexes.sql", "utf8"),
    ]);
    const handler = createAuthHandler({
      appName: "Partial Runtime Test",
      basePath: "/auth",
      email: createMockEmailAdapter(),
      runtime: {
        mode: "from-env",
        publicOrigin: "from-env",
        trustedHosts: ["custom.example"],
      },
      passwordHashing: {
        profile: "development-fast",
      },
    });

    const response = await handler.fetch(
      new Request("https://custom.example/auth/user"),
      {
        AUTH_DB: db,
        AUTH_SECRET: authSecret,
        AUTH_ENV: "production",
        AUTH_PUBLIC_ORIGIN: "https://custom.example",
      },
      { waitUntil() {} } as unknown as ExecutionContext,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ user: null });
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

  it("returns not_found for disabled token feature pages and consumes", async () => {
    const magic = await setup({
      login: {
        emailPassword: true,
        usernamePassword: true,
        magicLink: false,
        requireVerifiedEmail: false,
      },
    });
    const magicToken = `cfauth.magic.k_test.${"A".repeat(43)}`;
    const magicPage = await magic.authFetch(
      `/auth/magic-link/verify?token=${magicToken}`,
    );
    expect(magicPage.status).toBe(404);
    const magicConsume = await magic.authFetch("/auth/magic-link/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: magicToken }),
    });
    expect(magicConsume.status).toBe(404);
    const magicRequest = await magic.authFetch("/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "disabled-magic@example.com" }),
    });
    expect(magicRequest.status).toBe(404);
    await expect(authRowCounts(magic.db)).resolves.toEqual({
      events: 0,
      rateLimits: 0,
      tokens: 0,
    });

    const verify = await setup({
      emailVerification: {
        enabled: false,
        expiresInHours: 24,
        createSessionAfterVerification: false,
        activeTokenPolicy: "invalidate-previous",
      },
    });
    const verifyToken = `cfauth.verify.k_test.${"A".repeat(43)}`;
    const verifyPage = await verify.authFetch(
      `/auth/email/verify?token=${verifyToken}`,
    );
    expect(verifyPage.status).toBe(404);
    const verifyConsume = await verify.authFetch("/auth/email/verify/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: verifyToken }),
    });
    expect(verifyConsume.status).toBe(404);
    const verifyRequest = await verify.authFetch("/auth/email/verify/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "disabled-verify@example.com" }),
    });
    expect(verifyRequest.status).toBe(404);
    await expect(authRowCounts(verify.db)).resolves.toEqual({
      events: 0,
      rateLimits: 0,
      tokens: 0,
    });

    const reset = await setup({
      passwordReset: {
        enabled: false,
        expiresInMinutes: 30,
        revokeExistingSessions: true,
        createSessionAfterReset: false,
        markEmailVerifiedOnReset: true,
        activeTokenPolicy: "invalidate-previous",
      },
    });
    const resetToken = `cfauth.reset.k_test.${"A".repeat(43)}`;
    const resetPageResponse = await reset.authFetch(
      `/auth/password/reset?token=${resetToken}`,
    );
    expect(resetPageResponse.status).toBe(404);
    const resetConfirm = await reset.authFetch("/auth/password/reset/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: resetToken,
        password: "new correct horse battery staple",
      }),
    });
    expect(resetConfirm.status).toBe(404);
    const resetRequest = await reset.authFetch("/auth/password/reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "disabled-reset@example.com" }),
    });
    expect(resetRequest.status).toBe(404);
    await expect(authRowCounts(reset.db)).resolves.toEqual({
      events: 0,
      rateLimits: 0,
      tokens: 0,
    });
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

  it("runs dummy password verification for absent and passwordless users", async () => {
    const { authFetch, db } = await setup();
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO users (
          id, email, normalized_email, username, normalized_username,
          password_hash, email_verified_at, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, '{}')`,
      )
      .bind(
        "usr_passwordless",
        "passwordless@example.com",
        "passwordless@example.com",
        now,
        now,
      )
      .run();

    const absent = await authFetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "absent@example.com",
        password: "correct horse battery staple",
      }),
    });
    const passwordless = await authFetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "passwordless@example.com",
        password: "correct horse battery staple",
      }),
    });

    expect(absent.status).toBe(401);
    expect(passwordless.status).toBe(401);
    const events = await db
      .prepare(
        "SELECT event_type, user_id, metadata_json FROM auth_events WHERE event_type = 'dummy_password_verification' ORDER BY created_at",
      )
      .all<{
        event_type: string;
        user_id: string | null;
        metadata_json: string;
      }>();
    expect(events.results).toHaveLength(2);
    expect(events.results?.map((event) => event.user_id)).toEqual([null, null]);
    expect(
      events.results?.map((event) => JSON.parse(event.metadata_json)),
    ).toEqual([
      { subjectType: "email", userPresent: false },
      { subjectType: "email", userPresent: true },
    ]);
    expect(JSON.stringify(events.results)).not.toContain(
      "passwordless@example.com",
    );
  });

  it("returns public rate limit errors when the password hash queue times out", async () => {
    const { authFetch } = await setup({
      passwordHashing: {
        profile: "development-fast",
        maxConcurrentHashesPerIsolate: 1,
        queueTimeoutMs: 1,
      },
    });
    const responses = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        authFetch("/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: `queue-${index}@example.com`,
            password: "correct horse battery staple",
          }),
        }),
      ),
    );
    const limited = responses.find((response) => response.status === 429);
    expect(limited).toBeDefined();
    if (!limited) throw new Error("expected a rate-limited response");
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: "rate_limited" },
    });
  });

  it("uses confirmation-post magic links and does not consume on GET", async () => {
    const { authFetch, email, db, handler, env } = await setup();
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
    const noD1Get = await handler.fetch(
      new Request(
        `${origin}/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
      ),
      { ...env, AUTH_DB: throwingD1Database() },
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(noD1Get?.status).toBe(200);
    expect(noD1Get?.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(noD1Get?.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    expect(noD1Get?.headers.get("Content-Security-Policy")).toContain(
      "script-src 'unsafe-inline'",
    );
    await expect(noD1Get?.text()).resolves.toContain("history.replaceState");
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
    const { authFetch, email, handler, env } = await setup();
    const signupResponse = await signup(authFetch, "verify@example.com");
    const oldCookie = signupResponse.headers.get("Set-Cookie") ?? "";
    const verify =
      email.messages.find((item) => item.type === "verify")?.token ?? "";

    const verifyGet = await authFetch(
      `/auth/email/verify?token=${encodeURIComponent(verify)}`,
    );
    expect(verifyGet.status).toBe(200);
    const noD1VerifyGet = await handler.fetch(
      new Request(
        `${origin}/auth/email/verify?token=${encodeURIComponent(verify)}`,
      ),
      { ...env, AUTH_DB: throwingD1Database() },
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(noD1VerifyGet?.status).toBe(200);
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
    const noD1ResetGet = await handler.fetch(
      new Request(
        `${origin}/auth/password/reset?token=${encodeURIComponent(reset)}`,
      ),
      { ...env, AUTH_DB: throwingD1Database() },
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(noD1ResetGet?.status).toBe(200);
    expect(noD1ResetGet?.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(noD1ResetGet?.headers.get("Content-Security-Policy")).toContain(
      "script-src 'unsafe-inline'",
    );
    await expect(noD1ResetGet?.text()).resolves.toContain(
      "history.replaceState",
    );
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

  it("invalidates prior active email tokens by default", async () => {
    const { authFetch, db } = await setup();
    await signup(authFetch, "single-token@example.com");
    await requestEmailTokens(authFetch, "single-token@example.com");

    const counts = await tokenCounts(db);
    expect(counts.magic_link).toMatchObject({ active: 1, revoked: 1 });
    expect(counts.email_verification).toMatchObject({ active: 1, revoked: 1 });
    expect(counts.password_reset).toMatchObject({ active: 1, revoked: 1 });
  });

  it("allows multiple active email tokens when configured", async () => {
    const { authFetch, db } = await setup({
      magicLink: {
        allowSignups: false,
        expiresInMinutes: 15,
        activeTokenPolicy: "allow-multiple-active",
      },
      emailVerification: {
        enabled: true,
        expiresInHours: 24,
        createSessionAfterVerification: false,
        activeTokenPolicy: "allow-multiple-active",
      },
      passwordReset: {
        enabled: true,
        expiresInMinutes: 30,
        revokeExistingSessions: true,
        createSessionAfterReset: false,
        markEmailVerifiedOnReset: true,
        activeTokenPolicy: "allow-multiple-active",
      },
    });
    await signup(authFetch, "multi-token@example.com");
    await requestEmailTokens(authFetch, "multi-token@example.com");

    const counts = await tokenCounts(db);
    expect(counts.magic_link).toMatchObject({ active: 2, revoked: 0 });
    expect(counts.email_verification).toMatchObject({
      active: 2,
      revoked: 0,
    });
    expect(counts.password_reset).toMatchObject({ active: 2, revoked: 0 });
  });

  it("rejects verification and reset confirmation for disabled users", async () => {
    const { authFetch, email, db } = await setup();
    const signupResponse = await signup(
      authFetch,
      "disabled-reset@example.com",
    );
    const cookie = signupResponse.headers.get("Set-Cookie") ?? "";
    const verify =
      email.messages.find((item) => item.type === "verify")?.token ?? "";
    await authFetch("/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "disabled-reset@example.com" }),
    });
    const magic =
      email.messages.find((item) => item.type === "magic")?.token ?? "";
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

    const userResponse = await authFetch("/auth/user", {
      headers: { Cookie: cookie },
    });
    await expect(userResponse.json()).resolves.toEqual({ user: null });

    const loginResponse = await authFetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "disabled-reset@example.com",
        password: "correct horse battery staple",
      }),
    });
    expect(loginResponse.status).toBe(403);
    await expect(loginResponse.json()).resolves.toMatchObject({
      error: { code: "account_disabled" },
    });

    const magicResponse = await authFetch("/auth/magic-link/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: magic }),
    });
    expect(magicResponse.status).toBe(400);
    await expect(magicResponse.json()).resolves.toMatchObject({
      error: { code: "invalid_token" },
    });

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

  it("does not hash passwords before rejecting inactive reset tokens", async () => {
    const { authFetch } = await setup({
      passwordHashing: {
        profile: "development-fast",
        maxConcurrentHashesPerIsolate: 1,
        queueTimeoutMs: 1,
      },
    });
    const inactiveResetToken = `cfauth.reset.k1.${"A".repeat(43)}`;

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        authFetch("/auth/password/reset/confirm", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": `203.0.113.${index + 1}`,
          },
          body: JSON.stringify({
            token: inactiveResetToken,
            password: "new correct horse battery staple",
          }),
        }),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual(
      Array(10).fill(400),
    );
    await expect(
      Promise.all(responses.map((response) => response.json())),
    ).resolves.toEqual(
      Array(10).fill({
        error: { code: "invalid_token", message: "Invalid token" },
      }),
    );
  });

  it("counts IP-only rate limit buckets once per request", async () => {
    const { authFetch } = await setup();
    const inactiveResetToken = `cfauth.reset.k1.${"B".repeat(43)}`;
    const resetBody = JSON.stringify({
      token: inactiveResetToken,
      password: "new correct horse battery staple",
    });
    const headers = {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.200",
    };
    const allowed: Response[] = [];
    for (let i = 0; i < 10; i += 1) {
      allowed.push(
        await authFetch("/auth/password/reset/confirm", {
          method: "POST",
          headers,
          body: resetBody,
        }),
      );
    }

    expect(allowed.map((response) => response.status)).toEqual(
      Array(10).fill(400),
    );
    await expect(
      Promise.all(allowed.map((response) => response.json())),
    ).resolves.toEqual(
      Array(10).fill({
        error: { code: "invalid_token", message: "Invalid token" },
      }),
    );

    const limited = await authFetch("/auth/password/reset/confirm", {
      method: "POST",
      headers,
      body: resetBody,
    });
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      error: { code: "rate_limited" },
    });
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

    const streamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({ email: "stream@example.com" }),
          ),
        );
        controller.close();
      },
    });
    const oversizedStream = await limited.authFetch("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: streamBody as unknown as BodyInit,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(oversizedStream.status).toBe(413);

    let pulls = 0;
    let canceled = false;
    const boundedStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode("abcdef"));
        if (pulls > 5) controller.close();
      },
      cancel() {
        canceled = true;
      },
    });
    const earlyRejectedStream = await limited.authFetch("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: boundedStream as unknown as BodyInit,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(earlyRejectedStream.status).toBe(413);
    expect(pulls).toBeLessThan(5);
    expect(canceled).toBe(true);

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

    const formSignup = await authFetch("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: "form@example.com",
        password: "correct horse battery staple",
      }),
    });
    expect(formSignup.status).toBe(415);
    await expect(formSignup.json()).resolves.toMatchObject({
      error: { code: "unsupported_content_type" },
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

    const untrustedHost = await handler.fetch(
      new Request("https://evil.example/auth/user"),
      {
        AUTH_SECRET: authSecret,
        AUTH_ENV: "production",
        AUTH_PUBLIC_ORIGIN: "https://example.com",
      },
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(untrustedHost?.status).toBe(403);
    await expect(untrustedHost?.json()).resolves.toMatchObject({
      error: { code: "untrusted_host" },
    });

    const badCookieConfig = await setup({
      session: {
        cookieName: "auto",
        maxAgeDays: 30,
        sameSite: "lax",
        secure: "auto",
        requireVerifiedEmail: false,
        domain: ".example.com",
      },
    });
    const badCookieResponse = await badCookieConfig.handler.fetch(
      new Request("https://app.other.com/auth/user", {
        headers: {
          "CF-Connecting-IP": "203.0.113.10",
          "User-Agent": "Config Failure Browser",
        },
      }),
      {
        ...badCookieConfig.env,
        AUTH_ENV: "production",
        AUTH_PUBLIC_ORIGIN: "https://app.other.com",
      },
      badCookieConfig.ctx,
    );
    await badCookieConfig.flushDeferred();
    expect(badCookieResponse?.status).toBe(500);
    await expect(badCookieResponse?.json()).resolves.toMatchObject({
      error: { code: "config_error" },
    });
    const configEvent = await badCookieConfig.db
      .prepare(
        "SELECT event_type, ip_hash, user_agent_hash, metadata_json FROM auth_events ORDER BY created_at DESC LIMIT 1",
      )
      .first<{
        event_type: string;
        ip_hash: string | null;
        user_agent_hash: string | null;
        metadata_json: string;
      }>();
    expect(configEvent).toMatchObject({
      event_type: "config_error",
      metadata_json: JSON.stringify({ reason: "invalid_cookie_config" }),
    });
    expect(configEvent?.ip_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(configEvent?.user_agent_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);

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
    expect(
      allowedPreflight?.headers.get("Access-Control-Allow-Origin"),
    ).not.toBe("*");
    expect(allowedPreflight?.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, OPTIONS",
    );
    expect(allowedPreflight?.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type",
    );
    expect(
      allowedPreflight?.headers.get("Access-Control-Allow-Credentials"),
    ).toBe("true");
    expect(allowedPreflight?.headers.get("Vary")).toBe("Origin");

    const disallowedPreflight = await handler.fetch(
      new Request(`${origin}/auth/signup`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(disallowedPreflight?.status).toBe(403);
    expect(
      disallowedPreflight?.headers.get("Access-Control-Allow-Origin"),
    ).toBeNull();

    const corsPolicy = await setup({
      security: {
        allowedRequestOrigins: ["http://localhost:5173"],
        allowedPreviewRequestOrigins: [],
      },
    });
    const allowedCorsGet = await corsPolicy.handler.fetch(
      new Request(`${origin}/auth/user`, {
        headers: { Origin: "http://localhost:5173" },
      }),
      corsPolicy.env,
      corsPolicy.ctx,
    );
    await corsPolicy.flushDeferred();
    expect(allowedCorsGet?.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173",
    );
    expect(
      allowedCorsGet?.headers.get("Access-Control-Allow-Credentials"),
    ).toBe("true");
    expect(allowedCorsGet?.headers.get("Vary")).toBe("Origin");

    const disallowedCorsGet = await corsPolicy.handler.fetch(
      new Request(`${origin}/auth/user`, {
        headers: { Origin: "https://evil.example" },
      }),
      corsPolicy.env,
      corsPolicy.ctx,
    );
    await corsPolicy.flushDeferred();
    expect(
      disallowedCorsGet?.headers.get("Access-Control-Allow-Origin"),
    ).toBeNull();

    const sameSitePolicy = await setup({
      runtime: {
        mode: "from-env",
        publicOrigin: "from-env",
        trustedHosts: ["api.example.com"],
      },
      session: {
        cookieName: "auto",
        maxAgeDays: 30,
        sameSite: "lax",
        secure: "auto",
        requireVerifiedEmail: false,
        domain: ".example.com",
      },
      security: {
        allowedRequestOrigins: ["https://app.example.com"],
        allowedPreviewRequestOrigins: [],
      },
    });
    const sameSiteGet = await sameSitePolicy.handler.fetch(
      new Request("https://api.example.com/auth/user", {
        headers: { Origin: "https://app.example.com" },
      }),
      {
        ...sameSitePolicy.env,
        AUTH_ENV: "production",
        AUTH_PUBLIC_ORIGIN: "https://api.example.com",
      },
      sameSitePolicy.ctx,
    );
    await sameSitePolicy.flushDeferred();
    expect(sameSiteGet?.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://app.example.com",
    );

    const crossSitePolicy = await setup({
      runtime: {
        mode: "from-env",
        publicOrigin: "from-env",
        trustedHosts: ["api.example.com"],
      },
      security: {
        allowedRequestOrigins: ["https://app.other.com"],
        allowedPreviewRequestOrigins: [],
      },
    });
    const crossSitePreflight = await crossSitePolicy.handler.fetch(
      new Request("https://api.example.com/auth/signup", {
        method: "OPTIONS",
        headers: { Origin: "https://app.other.com" },
      }),
      {
        ...crossSitePolicy.env,
        AUTH_ENV: "production",
        AUTH_PUBLIC_ORIGIN: "https://api.example.com",
      },
      crossSitePolicy.ctx,
    );
    await crossSitePolicy.flushDeferred();
    expect(crossSitePreflight?.status).toBe(403);
    expect(
      crossSitePreflight?.headers.get("Access-Control-Allow-Origin"),
    ).toBeNull();
    const crossSitePost = await crossSitePolicy.handler.fetch(
      new Request("https://api.example.com/auth/signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://app.other.com",
        },
        body: JSON.stringify({
          email: "cross-site@example.com",
          password: "correct horse battery staple",
        }),
      }),
      {
        ...crossSitePolicy.env,
        AUTH_ENV: "production",
        AUTH_PUBLIC_ORIGIN: "https://api.example.com",
      },
      crossSitePolicy.ctx,
    );
    await crossSitePolicy.flushDeferred();
    expect(crossSitePost?.status).toBe(403);
    await expect(crossSitePost?.json()).resolves.toMatchObject({
      error: { code: "invalid_origin" },
    });
    expect(
      crossSitePost?.headers.get("Access-Control-Allow-Origin"),
    ).toBeNull();

    const previewPolicy = await setup({
      security: {
        allowedRequestOrigins: ["https://prod.example"],
        allowedPreviewRequestOrigins: [],
      },
      runtime: {
        mode: "from-env",
        publicOrigin: "from-env",
        trustedHosts: ["preview.example"],
      },
    });
    const previewPreflight = await previewPolicy.handler.fetch(
      new Request("https://preview.example/auth/signup", {
        method: "OPTIONS",
        headers: { Origin: "https://prod.example" },
      }),
      {
        ...previewPolicy.env,
        AUTH_ENV: "preview",
        AUTH_PUBLIC_ORIGIN: "https://preview.example",
      },
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(previewPreflight?.status).toBe(403);
  });

  it("parses supported content types with parameters", async () => {
    const { authFetch, email } = await setup();
    const signup = await authFetch("/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "Application/JSON; Charset=utf-8" },
      body: JSON.stringify({
        email: "typed@example.com",
        password: "correct horse battery staple",
      }),
    });
    expect(signup.status).toBe(200);

    await authFetch("/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "Application/JSON; Charset=utf-8" },
      body: JSON.stringify({
        email: "typed@example.com",
        redirectTo: "/typed",
      }),
    });
    const token = email.messages.find((item) => item.type === "magic")?.token;
    if (!token) throw new Error("missing magic token");

    const consume = await authFetch("/auth/magic-link/consume", {
      method: "POST",
      headers: {
        "Content-Type": "Application/X-WWW-Form-Urlencoded; Charset=utf-8",
      },
      body: new URLSearchParams({ token }),
    });
    expect(consume.status).toBe(303);
    expect(consume.headers.get("Location")).toBe("/typed");
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

  it("stores only derived route rate-limit keys", async () => {
    const { authFetch, db } = await setup();
    await authFetch("/auth/magic-link/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "198.51.100.77",
      },
      body: JSON.stringify({ email: "rate-raw@example.com" }),
    });
    await authFetch("/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "CF-Connecting-IP": "198.51.100.77",
      },
      body: JSON.stringify({
        identifier: "raw-identifier",
        password: "correct horse battery staple",
      }),
    });

    const rows = await db
      .prepare("SELECT key FROM rate_limits")
      .all<{ key: string }>();
    expect(rows.results?.length).toBeGreaterThan(0);
    expect(rows.results?.every((row) => row.key.startsWith("rl:v1:"))).toBe(
      true,
    );
    expect(JSON.stringify(rows.results)).not.toMatch(
      /rate-raw@example\.com|raw-identifier|198\.51\.100\.77/,
    );
  });

  it("applies configured enumeration response delay to request flows", async () => {
    const { authFetch } = await setup({
      request: {
        enumerationMinResponseMs: 20,
        enumerationJitterMs: 0,
      },
    });

    const startedAt = Date.now();
    const response = await authFetch("/auth/password/reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "absent-delay@example.com" }),
    });

    expect(response.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);
    await expect(response.json()).resolves.toEqual({ ok: true });
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
    const malformed = await authFetch("/auth/magic-link/consume", {
      method: "POST",
      headers,
      body: JSON.stringify({ token: "not-a-token" }),
    });
    expect(malformed.status).toBe(400);

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
        "magic_link_consume_failed",
      ]),
    );
    expect(
      events.results?.some(
        (row) =>
          row.event_type === "magic_link_consume_failed" &&
          row.metadata_json.includes("malformed_token"),
      ),
    ).toBe(true);
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
    await authFetch("/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "jit@example.com" }),
    });
    const jitTokenState = await db
      .prepare(
        `SELECT
          sum(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active,
          sum(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
        FROM verification_tokens
        WHERE type = 'magic_link' AND normalized_email = ?`,
      )
      .bind("jit@example.com")
      .first<{ active: number; revoked: number }>();
    expect(jitTokenState).toMatchObject({ active: 1, revoked: 1 });
    const token =
      email.messages.filter((item) => item.type === "magic").at(-1)?.token ??
      "";
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

async function requestEmailTokens(
  authFetch: (path: string, init?: RequestInit) => Promise<Response>,
  email: string,
) {
  for (let i = 0; i < 2; i += 1) {
    await authFetch("/auth/magic-link/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    await authFetch("/auth/password/reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
  }
  await authFetch("/auth/email/verify/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

function throwingD1Database(): D1Database {
  const fail = () => {
    throw new Error("token GET pages must not touch D1");
  };
  return {
    prepare: fail,
    batch: fail,
    exec: fail,
    dump: fail,
    withSession: fail,
  } as unknown as D1Database;
}

async function tokenCounts(db: D1Database) {
  const rows = await db
    .prepare(
      `SELECT
        type,
        SUM(CASE WHEN used_at IS NULL AND revoked_at IS NULL THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
      FROM verification_tokens
      GROUP BY type`,
    )
    .all<{
      type: "magic_link" | "email_verification" | "password_reset";
      active: number;
      revoked: number;
    }>();
  return Object.fromEntries(
    (rows.results ?? []).map((row) => [
      row.type,
      { active: row.active, revoked: row.revoked },
    ]),
  ) as Record<
    "magic_link" | "email_verification" | "password_reset",
    { active: number; revoked: number }
  >;
}

async function authRowCounts(db: D1Database) {
  const [tokens, rateLimits, events] = await Promise.all([
    db
      .prepare("SELECT count(*) AS count FROM verification_tokens")
      .first<number>("count"),
    db
      .prepare("SELECT count(*) AS count FROM rate_limits")
      .first<number>("count"),
    db
      .prepare("SELECT count(*) AS count FROM auth_events")
      .first<number>("count"),
  ]);
  return { tokens, rateLimits, events };
}
