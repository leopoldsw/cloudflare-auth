import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("deploy template export", () => {
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
});

async function deployTemplateSourceFixture(packageJson: string) {
  const root = await mkdtemp(join(tmpdir(), "cf-auth-deploy-export-"));
  const template = join(root, "templates", "hono-basic");
  await mkdir(template, { recursive: true });
  await writeFile(join(template, "package.json"), packageJson);
  return root;
}

function runExportDeployTemplate(cwd: string) {
  const root = process.cwd();
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", "export-deploy-template.mjs"), "template-out"],
    {
      cwd,
      encoding: "utf8",
    },
  );
}
