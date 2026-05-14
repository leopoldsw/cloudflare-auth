import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("package name registry checks", () => {
  it("validates reserved package registry versions without publishing private shims", async () => {
    const fixture = await packageNameFixture();
    const result = runPackageNameCheck(fixture.root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("@cf-auth/cli@0.1.0-beta.0");
  });

  it("rejects stale reserved package registry versions", async () => {
    const fixture = await packageNameFixture({
      cfAuthRegistryVersion: "1.0.1",
    });
    const result = runPackageNameCheck(fixture.root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cf-auth reservedPackages registryVersion");
    expect(result.stderr).toContain("1.0.2");
  });

  it("rejects placeholder publish versions", async () => {
    const fixture = await packageNameFixture({
      packageVersion: "0.0.0",
    });
    const result = runPackageNameCheck(fixture.root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "@cf-auth/cli: release workflow must not publish placeholder version 0.0.0",
    );
  });
});

async function packageNameFixture(
  options: { cfAuthRegistryVersion?: string; packageVersion?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "cf-auth-package-names-"));
  await mkdir(join(root, "packages"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });

  const publishable = [
    ["cli", "@cf-auth/cli"],
    ["client", "@cf-auth/client"],
    ["core", "@cf-auth/core"],
    ["email-cloudflare", "@cf-auth/email-cloudflare"],
    ["hono", "@cf-auth/hono"],
    ["testing", "@cf-auth/testing"],
    ["worker", "@cf-auth/worker"],
  ] as const;
  for (const [dir, name] of publishable) {
    await writePackageJson(root, dir, {
      name,
      version: options.packageVersion ?? "0.1.0-beta.0",
    });
  }
  await writePackageJson(root, "cf-auth-shim", {
    name: "cf-auth",
    version: options.packageVersion ?? "0.1.0-beta.0",
    private: true,
  });
  await writePackageJson(root, "create-cloudflare-auth", {
    name: "create-cloudflare-auth",
    version: options.packageVersion ?? "0.1.0-beta.0",
    private: true,
  });

  await writeFile(
    join(root, "docs", "package-ownership.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        verifiedAt: "2026-05-14T00:00:00.000Z",
        verifiedBy: "release-reviewer",
        packages: publishable.map(([, name]) => ({
          name,
          registry: "https://registry.npmjs.org/",
          version: options.packageVersion ?? "0.1.0-beta.0",
          ownershipConfirmed: true,
          publisherTwoFactorEnabled: true,
          provenancePublish: true,
        })),
        reservedPackages: [
          {
            name: "cf-auth",
            registry: "https://registry.npmjs.org/",
            registryVersion: options.cfAuthRegistryVersion ?? "1.0.2",
            publishableAfterOwnershipConfirmed: true,
          },
          {
            name: "create-cloudflare-auth",
            registry: "https://registry.npmjs.org/",
            publishableAfterOwnershipConfirmed: true,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const npmPath = join(root, "bin", "npm");
  await writeFile(
    npmPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const query = args[1] || "";
if (args[0] !== "view") process.exit(2);
if (query === "cf-auth") {
  console.log(JSON.stringify({ name: "cf-auth", version: "1.0.2" }));
  process.exit(0);
}
console.error("npm error code E404");
process.exit(1);
`,
  );
  await chmod(npmPath, 0o755);

  return { root };
}

async function writePackageJson(
  root: string,
  dir: string,
  pkg: { name: string; version: string; private?: boolean },
) {
  const packageDir = join(root, "packages", dir);
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, "package.json"), `${JSON.stringify(pkg)}\n`);
}

function runPackageNameCheck(cwd: string) {
  const root = process.cwd();
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", "check-package-names.mjs")],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(cwd, "bin")}:${process.env.PATH ?? ""}`,
      },
    },
  );
}
