import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("version matrix check", () => {
  it("rejects invalid version matrix JSON", async () => {
    const root = await versionMatrixFixture();
    await writeFile(join(root, "scripts", "version-matrix.json"), "not json\n");
    const result = runVersionMatrixCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "scripts/version-matrix.json: must be valid JSON",
    );
  });

  it("rejects non-object version matrix JSON", async () => {
    const root = await versionMatrixFixture();
    await writeFile(join(root, "scripts", "version-matrix.json"), "null\n");
    const result = runVersionMatrixCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "scripts/version-matrix.json: top-level JSON value must be an object",
    );
  });

  it("rejects incomplete version matrix JSON before deriving undefined requirements", async () => {
    const root = await versionMatrixFixture({
      versionMatrix: {
        ...validVersionMatrix(),
        pnpm: undefined,
      },
    });
    const result = runVersionMatrixCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "scripts/version-matrix.json: pnpm must be a string",
    );
    expect(result.stderr).not.toContain("pnpm@undefined");
  });

  it("rejects non-object root package JSON", async () => {
    const root = await versionMatrixFixture();
    await writeFile(join(root, "package.json"), "null\n");
    const result = runVersionMatrixCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "package.json: top-level JSON value must be an object",
    );
  });
});

async function versionMatrixFixture(
  options: {
    versionMatrix?: Record<string, string | undefined>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "cf-auth-version-matrix-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeJson(
    join(root, "scripts", "version-matrix.json"),
    options.versionMatrix ?? validVersionMatrix(),
  );
  await writeJson(join(root, "package.json"), {
    packageManager: "pnpm@11.1.1",
    engines: {
      node: ">=22.13.0",
      pnpm: ">=11 <12",
    },
    devDependencies: {},
  });
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

function runVersionMatrixCheck(cwd: string) {
  const root = process.cwd();
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", "version-matrix-check.mjs")],
    {
      cwd,
      encoding: "utf8",
    },
  );
}
