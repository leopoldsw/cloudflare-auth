import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("deploy template export", () => {
  it("renders toolchain versions from the version matrix", async () => {
    const root = await deployTemplateSourceFixture(
      `${JSON.stringify(
        {
          type: "module",
          packageManager: "pnpm@old",
          dependencies: { hono: "old" },
          devDependencies: {
            typescript: "old",
            vitest: "old",
            wrangler: "old",
          },
          engines: { node: "old" },
        },
        null,
        2,
      )}\n`,
      {
        versionMatrix: {
          ...validVersionMatrix(),
          node: ">=22.13.0",
          pnpm: "11.2.3",
          hono: "4.99.0",
          typescript: "6.9.0",
          vitest: "4.9.0",
          wrangler: "4.99.0",
          workersCompatibilityDate: "2026-05-16",
        },
      },
    );
    const result = runExportDeployTemplate(root);

    expect(result.status).toBe(0);
    const packageJson = JSON.parse(
      await readFile(join(root, "template-out", "package.json"), "utf8"),
    );
    expect(packageJson.packageManager).toBe("pnpm@11.2.3");
    expect(packageJson.engines.node).toBe(">=22.13.0");
    expect(packageJson.dependencies.hono).toBe("4.99.0");
    expect(packageJson.devDependencies.typescript).toBe("6.9.0");
    expect(packageJson.devDependencies.vitest).toBe("4.9.0");
    expect(packageJson.devDependencies.wrangler).toBe("4.99.0");
    const wranglerJson = JSON.parse(
      await readFile(join(root, "template-out", "wrangler.jsonc"), "utf8"),
    );
    expect(wranglerJson.compatibility_date).toBe("2026-05-16");
  });

  it("rejects non-object source package manifests", async () => {
    const root = await deployTemplateSourceFixture("null\n");
    const result = runExportDeployTemplate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "templates/hono-basic/package.json: top-level JSON value must be an object",
    );
  });

  it("rejects invalid source package JSON", async () => {
    const root = await deployTemplateSourceFixture("not json\n");
    const result = runExportDeployTemplate(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "templates/hono-basic/package.json: must be valid JSON",
    );
  });

  it("rejects deploy template package tags outside the beta channel", async () => {
    const root = await deployTemplateSourceFixture("{}\n");
    const result = runExportDeployTemplate(root, {
      CF_AUTH_DEPLOY_TEMPLATE_PACKAGE_TAG: "latest",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "CF_AUTH_DEPLOY_TEMPLATE_PACKAGE_TAG must be beta or a beta prerelease package version",
    );
  });
});

async function deployTemplateSourceFixture(
  packageJson: string,
  options: { versionMatrix?: Record<string, string> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "cf-auth-deploy-export-"));
  const template = join(root, "templates", "hono-basic");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(template, { recursive: true });
  await writeJson(
    join(root, "scripts", "version-matrix.json"),
    options.versionMatrix ?? validVersionMatrix(),
  );
  await writeFile(join(template, "package.json"), packageJson);
  return root;
}

function validVersionMatrix(): Record<string, string> {
  return {
    node: ">=22.13.0",
    pnpm: "11.1.1",
    typescript: "6.0.3",
    wrangler: "4.90.1",
    hono: "4.12.18",
    tsup: "8.5.1",
    vitest: "4.1.6",
    zod: "4.4.3",
    changesets: "2.31.0",
    workersCompatibilityDate: "2026-05-15",
    workersCompatibilityDateFloor: "2024-09-23",
  };
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runExportDeployTemplate(
  cwd: string,
  env: Record<string, string> = {},
) {
  const root = process.cwd();
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", "export-deploy-template.mjs"), "template-out"],
    {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
}
