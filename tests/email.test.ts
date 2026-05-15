import { readFile } from "node:fs/promises";

import { AuthCryptoError } from "@cf-auth/core";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";
import { applyD1Migrations, createSqliteD1Database } from "@cf-auth/testing";
import {
  type AuthEmailAdapter,
  byEnvironment,
  createAuthHandler,
  defineAuthConfig,
  terminalEmail,
  type AuthEmailRuntime,
} from "@cf-auth/worker";
import { describe, expect, it } from "vitest";

const authSecret = "k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("email adapters and templates", () => {
  it("stores terminal emails in the dev outbox and rejects terminal sends outside development", async () => {
    const printed: string[] = [];
    const logged: unknown[] = [];
    const adapter = terminalEmail({
      outbox: true,
      print: (line) => printed.push(line),
    });
    await adapter.sendMagicLink(sampleEmail(), {
      ...runtime("development"),
      logger: {
        log: (_message, metadata) => logged.push(metadata),
        error() {},
      },
    });
    expect(adapter.outbox).toHaveLength(1);
    expect(printed[0]).toContain(
      "cfauth.magic.k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(JSON.stringify(logged)).not.toContain("person@example.com");
    await expect(
      adapter.sendMagicLink(sampleEmail(), runtime("production")),
    ).rejects.toThrow(AuthCryptoError);
  });

  it("selects email adapters by runtime environment", async () => {
    const calls: string[] = [];
    const adapter = byEnvironment({
      development: recordingEmailAdapter("dev", calls),
      preview: recordingEmailAdapter("preview", calls),
      production: recordingEmailAdapter("prod", calls),
    });

    await adapter.sendMagicLink(sampleEmail(), runtime("development"));
    await adapter.sendEmailVerification(sampleEmail(), runtime("preview"));
    await adapter.sendPasswordReset(sampleEmail(), runtime("production"));

    expect(calls).toEqual([
      "dev:magic:development",
      "preview:verify:preview",
      "prod:reset:production",
    ]);
    expect(Object.keys(adapter).sort()).toEqual([
      "kind",
      "sendEmailVerification",
      "sendMagicLink",
      "sendPasswordReset",
    ]);
    expect("adapters" in adapter).toBe(false);
  });

  it("serves the dev outbox only in development", async () => {
    const db = createSqliteD1Database();
    await applyD1Migrations(db, [
      await readFile("migrations/0001_initial.sql", "utf8"),
      await readFile("migrations/0002_indexes.sql", "utf8"),
    ]);
    const adapter = terminalEmail({ outbox: true });
    const handler = createAuthHandler(
      defineAuthConfig({
        appName: "Email Test",
        basePath: "/auth",
        email: adapter,
      }),
    );
    await adapter.sendMagicLink(sampleEmail(), runtime("development"));
    const dev = await handler.fetch(
      new Request("http://localhost:8787/auth/dev/emails"),
      {
        AUTH_DB: db,
        AUTH_SECRET: authSecret,
        AUTH_ENV: "development",
        AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
      },
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(dev?.status).toBe(200);
    await expect(dev?.json()).resolves.toMatchObject({
      emails: [{ to: "person@example.com", redirectTo: "/dashboard" }],
    });

    const prod = await handler.fetch(
      new Request("https://example.com/auth/dev/emails"),
      {
        AUTH_DB: db,
        AUTH_SECRET: authSecret,
        AUTH_ENV: "production",
        AUTH_PUBLIC_ORIGIN: "https://example.com",
      },
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(prod?.status).toBe(404);
  });

  it("sends through the configured Cloudflare Email binding", async () => {
    const sent: unknown[] = [];
    const adapter = cloudflareEmail({
      binding: "AUTH_EMAIL",
      from: { email: "auth@example.com", name: "Auth" },
      appName: "Email Test",
    });
    await adapter.sendPasswordReset(sampleEmail(), {
      ...runtime("production"),
      env: {
        AUTH_EMAIL: {
          async send(message: unknown) {
            sent.push(message);
            return { messageId: "msg_1" };
          },
        },
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: "person@example.com",
      from: { email: "auth@example.com", name: "Auth" },
      subject: "Reset your Email Test password",
    });
  });

  it("throws a clear error for a missing Cloudflare Email binding and supports custom templates", async () => {
    const adapter = cloudflareEmail({
      binding: "AUTH_EMAIL",
      from: "auth@example.com",
      templates: {
        magicLink(input) {
          return {
            subject: `Custom ${input.appName}`,
            text: input.url,
            html: `<p>${input.url}</p>`,
          };
        },
      },
    });
    await expect(
      adapter.sendEmailVerification(sampleEmail(), runtime("production")),
    ).rejects.toThrow(/AUTH_EMAIL/);

    const sent: Array<{ subject?: string }> = [];
    await adapter.sendMagicLink(sampleEmail(), {
      ...runtime("production"),
      env: {
        AUTH_EMAIL: {
          async send(message: { subject?: string }) {
            sent.push(message);
            return { messageId: "msg_2" };
          },
        },
      },
    });
    expect(sent[0]?.subject).toBe("Custom Cloudflare Auth");
  });

  it("records redacted email send failures and keeps request responses generic", async () => {
    const db = createSqliteD1Database();
    await applyD1Migrations(db, [
      await readFile("migrations/0001_initial.sql", "utf8"),
      await readFile("migrations/0002_indexes.sql", "utf8"),
    ]);
    const adapter: AuthEmailAdapter = {
      kind: "failing-test",
      async sendMagicLink() {
        throw new Error(
          "provider failed for person@example.com cfauth.magic.k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );
      },
      async sendEmailVerification() {},
      async sendPasswordReset() {},
    };
    const handler = createAuthHandler(
      defineAuthConfig({
        appName: "Email Failure Test",
        basePath: "/auth",
        email: adapter,
        passwordHashing: {
          profile: "development-fast",
          maxConcurrentHashesPerIsolate: 1,
        },
      }),
    );
    const env = {
      AUTH_DB: db,
      AUTH_SECRET: authSecret,
      AUTH_ENV: "development",
      AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
    };
    const deferred = testExecutionContext();

    const signup = await handler.fetch(
      new Request("http://localhost:8787/auth/signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:8787",
        },
        body: JSON.stringify({
          email: "person@example.com",
          password: "correct horse battery staple",
        }),
      }),
      env,
      deferred.ctx,
    );
    await deferred.flush();
    expect(signup?.status).toBe(200);

    const request = await handler.fetch(
      new Request("http://localhost:8787/auth/magic-link/request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost:8787",
        },
        body: JSON.stringify({ email: "person@example.com" }),
      }),
      env,
      deferred.ctx,
    );
    await deferred.flush();
    expect(request?.status).toBe(200);
    await expect(request?.json()).resolves.toEqual({ ok: true });
    const event = await db
      .prepare(
        "SELECT event_type, metadata_json FROM auth_events ORDER BY created_at DESC LIMIT 1",
      )
      .first<{ event_type: string; metadata_json: string }>();
    expect(event?.event_type).toBe("email_send_failed");
    expect(event?.metadata_json).toContain('"tokenType":"magic_link"');
    expect(event?.metadata_json).not.toMatch(/person@example\.com|cfauth\./);
  });

  it("handles signup verification email failures by session policy", async () => {
    const db = createSqliteD1Database();
    await applyD1Migrations(db, [
      await readFile("migrations/0001_initial.sql", "utf8"),
      await readFile("migrations/0002_indexes.sql", "utf8"),
    ]);
    const adapter: AuthEmailAdapter = {
      kind: "failing-verification",
      async sendMagicLink() {},
      async sendEmailVerification() {
        throw new Error(
          "provider failed for person@example.com cfauth.verify.k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );
      },
      async sendPasswordReset() {},
    };
    const env = {
      AUTH_DB: db,
      AUTH_SECRET: authSecret,
      AUTH_ENV: "production",
      AUTH_PUBLIC_ORIGIN: "https://example.com",
    };
    const handler = createAuthHandler(
      defineAuthConfig({
        appName: "Signup Email Failure Test",
        basePath: "/auth",
        email: adapter,
        signup: {
          enabled: true,
          requireEmailVerificationBeforeSession: true,
          enumerationSafe: false,
          username: { enabled: true, required: false },
        },
        passwordHashing: {
          profile: "development-fast",
          maxConcurrentHashesPerIsolate: 1,
        },
      }),
    );

    const failed = await handler.fetch(
      new Request("https://example.com/auth/signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
        },
        body: JSON.stringify({
          email: "verify-fail@example.com",
          password: "correct horse battery staple",
        }),
      }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(failed?.status).toBe(500);
    await expect(failed?.json()).resolves.toMatchObject({
      error: { code: "email_send_failed" },
    });

    const safeHandler = createAuthHandler(
      defineAuthConfig({
        appName: "Enumeration Safe Email Failure Test",
        basePath: "/auth",
        email: adapter,
        signup: {
          enabled: true,
          requireEmailVerificationBeforeSession: true,
          enumerationSafe: true,
          username: { enabled: true, required: false },
        },
        passwordHashing: {
          profile: "development-fast",
          maxConcurrentHashesPerIsolate: 1,
        },
      }),
    );
    const safe = await safeHandler.fetch(
      new Request("https://example.com/auth/signup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.com",
        },
        body: JSON.stringify({
          email: "safe-fail@example.com",
          password: "correct horse battery staple",
        }),
      }),
      env,
      { waitUntil() {} } as unknown as ExecutionContext,
    );
    expect(safe?.status).toBe(200);
    expect(safe?.headers.get("Set-Cookie")).toBeNull();
    await expect(safe?.json()).resolves.toEqual({ ok: true });

    const event = await db
      .prepare(
        "SELECT event_type, metadata_json FROM auth_events WHERE event_type = 'email_send_failed' ORDER BY created_at DESC LIMIT 1",
      )
      .first<{ event_type: string; metadata_json: string }>();
    expect(event?.metadata_json).not.toMatch(/example\.com|cfauth\./);
  });
});

function sampleEmail() {
  const token = "cfauth.magic.k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  return {
    to: "person@example.com",
    token,
    url: `https://example.com/auth/magic-link/verify?token=${token}`,
    redirectTo: "/dashboard",
    expiresAt: Date.now() + 1_000,
  };
}

function testExecutionContext(): {
  ctx: ExecutionContext;
  flush: () => Promise<void>;
} {
  const deferred: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(promise: Promise<unknown>) {
        deferred.push(Promise.resolve(promise));
      },
    } as unknown as ExecutionContext,
    async flush() {
      while (deferred.length > 0) {
        await Promise.all(deferred.splice(0));
      }
    },
  };
}

function recordingEmailAdapter(
  name: string,
  calls: string[],
): AuthEmailAdapter {
  return {
    kind: name,
    async sendMagicLink(_input, selectedRuntime) {
      calls.push(`${name}:magic:${selectedRuntime.mode}`);
    },
    async sendEmailVerification(_input, selectedRuntime) {
      calls.push(`${name}:verify:${selectedRuntime.mode}`);
    },
    async sendPasswordReset(_input, selectedRuntime) {
      calls.push(`${name}:reset:${selectedRuntime.mode}`);
    },
  };
}

function runtime(
  mode: "development" | "preview" | "production",
): AuthEmailRuntime {
  return {
    env: {},
    ctx: { waitUntil() {} } as unknown as ExecutionContext,
    mode,
    requestId: "req_test",
    publicOrigin:
      mode === "development" ? "http://localhost:8787" : "https://example.com",
    logger: { log() {}, error() {} },
  };
}
