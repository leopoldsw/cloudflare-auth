import { readFile } from "node:fs/promises";

import { AuthCryptoError } from "@cf-auth/core";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";
import { applyD1Migrations, createSqliteD1Database } from "@cf-auth/testing";
import {
  type AuthEmailAdapter,
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
    const adapter = terminalEmail({
      outbox: true,
      print: (line) => printed.push(line),
    });
    await adapter.sendMagicLink(sampleEmail(), runtime("development"));
    expect(adapter.outbox).toHaveLength(1);
    expect(printed[0]).toContain(
      "cfauth.magic.k1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    await expect(
      adapter.sendMagicLink(sampleEmail(), runtime("production")),
    ).rejects.toThrow(AuthCryptoError);
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
      { waitUntil() {} } as unknown as ExecutionContext,
    );
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
      { waitUntil() {} } as unknown as ExecutionContext,
    );
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
