import { describe, expect, it } from "vitest";

import { cfAuthPackageName } from "cf-auth";
import {
  AuthClientError,
  clientPackageName,
  createAuthClient,
} from "@cf-auth/client";
import { cliPackageName, runCli } from "@cf-auth/cli";
import {
  corePackageName,
  hashPassword,
  normalizeEmail,
  parseAuthKeyRing,
  resolveSessionCookie,
  validateRedirectTarget,
} from "@cf-auth/core";
import {
  cloudflareEmail,
  defaultEmailVerificationTemplate,
  defaultMagicLinkTemplate,
  defaultPasswordResetTemplate,
  emailCloudflarePackageName,
} from "@cf-auth/email-cloudflare";
import {
  createAuthRoutes,
  getAuthUser,
  honoPackageName,
  optionalUser,
  requireUser,
  requireVerifiedUser,
} from "@cf-auth/hono";
import {
  applyD1Migrations,
  createMockEmailAdapter,
  createSqliteD1Database,
  testingPackageName,
} from "@cf-auth/testing";
import {
  byEnvironment,
  cloudflareRateLimitPrefilter,
  createAuthHandler,
  createD1Repositories,
  defineAuthConfig,
  getAuthSessionFromRequest,
  redactLogValue,
  terminalEmail,
  turnstileEndpointNames,
  verifyTurnstileToken,
  workerPackageName,
} from "@cf-auth/worker";
import { createCloudflareAuthPackageName } from "create-cloudflare-auth";

describe("package boundary exports", () => {
  it("imports every public package through its root export", () => {
    expect(cfAuthPackageName).toBe("cf-auth");
    expect(corePackageName).toBe("@cf-auth/core");
    expect(workerPackageName).toBe("@cf-auth/worker");
    expect(honoPackageName).toBe("@cf-auth/hono");
    expect(clientPackageName).toBe("@cf-auth/client");
    expect(cliPackageName).toBe("@cf-auth/cli");
    expect(emailCloudflarePackageName).toBe("@cf-auth/email-cloudflare");
    expect(testingPackageName).toBe("@cf-auth/testing");
    expect(createCloudflareAuthPackageName).toBe("create-cloudflare-auth");
  });

  it("imports documented runtime symbols through package roots", () => {
    for (const symbol of [
      runCli,
      createAuthClient,
      normalizeEmail,
      validateRedirectTarget,
      parseAuthKeyRing,
      hashPassword,
      resolveSessionCookie,
      defineAuthConfig,
      createAuthHandler,
      getAuthSessionFromRequest,
      createD1Repositories,
      terminalEmail,
      byEnvironment,
      verifyTurnstileToken,
      cloudflareRateLimitPrefilter,
      redactLogValue,
      createAuthRoutes,
      getAuthUser,
      optionalUser,
      requireUser,
      requireVerifiedUser,
      cloudflareEmail,
      defaultMagicLinkTemplate,
      defaultEmailVerificationTemplate,
      defaultPasswordResetTemplate,
      createSqliteD1Database,
      applyD1Migrations,
      createMockEmailAdapter,
    ]) {
      expect(typeof symbol).toBe("function");
    }
    expect(AuthClientError).toBeInstanceOf(Function);
    expect(turnstileEndpointNames).toContain("signup");
  });
});
