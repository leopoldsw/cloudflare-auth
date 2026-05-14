/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  createAuthHandler,
  defineAuthConfig,
  terminalEmail,
} from "@cf-auth/worker";

describe("Workers runtime smoke", () => {
  it("runs Cloudflare Auth handler code inside the Workers Vitest pool", async () => {
    const handler = createAuthHandler(
      defineAuthConfig({
        appName: "Workers Runtime Smoke",
        basePath: "/auth",
        email: terminalEmail(),
      }),
    );
    const ctx = createExecutionContext();
    const response = await handler.fetch(
      new Request("http://localhost:8787/health"),
      {
        AUTH_ENV: "development",
        AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
        AUTH_SECRET: `k_test.${"A".repeat(43)}`,
      },
      ctx,
    );

    expect(response).toBeNull();
    await waitOnExecutionContext(ctx);
  });

  it("exposes Workers Web Crypto APIs", async () => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("cf-auth"),
    );

    expect(digest.byteLength).toBe(32);
  });
});
