import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("published smoke package tags", () => {
  it("rejects published quickstart smoke package tags outside the beta channel", () => {
    const result = runScript("scripts/smoke-published-quickstart.mjs", {
      CF_AUTH_PUBLISHED_QUICKSTART_PACKAGE_TAG: "latest",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "CF_AUTH_PUBLISHED_QUICKSTART_PACKAGE_TAG must be beta or a beta prerelease package version",
    );
  });

  it("rejects production smoke package tags outside the beta channel", () => {
    const result = runScript("scripts/smoke-production-cloudflare.mjs", {
      CF_AUTH_PRODUCTION_SMOKE: "1",
      CF_AUTH_PRODUCTION_SMOKE_DATABASE_ID:
        "00000000-0000-0000-0000-000000000000",
      CF_AUTH_PRODUCTION_SMOKE_ORIGIN: "https://auth.cf-auth-release.dev",
      CF_AUTH_PRODUCTION_SMOKE_PACKAGE_TAG: "0.1.0-beta",
      CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "CF_AUTH_PRODUCTION_SMOKE_PACKAGE_TAG must be beta or a beta prerelease package version",
    );
  });
});

function runScript(script: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [resolve(process.cwd(), script)], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}
