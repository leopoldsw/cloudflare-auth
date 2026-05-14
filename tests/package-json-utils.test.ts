import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

type PackageJsonUtils = {
  assertNoWorkspaceDependencies(
    pkg: Record<string, unknown>,
    label: string,
  ): void;
  getObjectSection(
    object: Record<string, unknown>,
    section: string,
    label: string,
    options?: { create?: boolean },
  ): Record<string, unknown> | undefined;
  parseJsonObject(text: string, label: string): Record<string, unknown>;
  parsePnpmPackOutput(text: string, label: string): Record<string, unknown>;
  readJsonObject(
    path: string,
    label?: string,
  ): Promise<Record<string, unknown>>;
  rewriteWorkspaceDependencySpecs(
    pkg: Record<string, unknown>,
    label: string,
    resolveSpec: (name: string, section: string) => string,
  ): void;
};

describe("package JSON utilities", () => {
  it("rejects invalid and non-object JSON", async () => {
    const utils = await loadUtils();

    expect(() => utils.parseJsonObject("not json", "package.json")).toThrow(
      "package.json: must be valid JSON",
    );
    expect(() => utils.parseJsonObject("null", "package.json")).toThrow(
      "package.json: top-level JSON value must be an object",
    );
  });

  it("reads JSON object manifests with clear failures", async () => {
    const utils = await loadUtils();
    const dir = await mkdtemp(join(tmpdir(), "cf-auth-json-utils-"));
    const path = join(dir, "package.json");
    await writeFile(path, '{"name":"fixture"}\n');

    await expect(
      utils.readJsonObject(path, "fixture package.json"),
    ).resolves.toMatchObject({
      name: "fixture",
    });

    await writeFile(path, "[]\n");
    await expect(
      utils.readJsonObject(path, "fixture package.json"),
    ).rejects.toThrow(
      "fixture package.json: top-level JSON value must be an object",
    );
  });

  it("validates pnpm pack JSON output shape", async () => {
    const utils = await loadUtils();

    expect(() => utils.parsePnpmPackOutput("[]", "@cf-auth/core")).toThrow(
      "@cf-auth/core: pnpm pack JSON output: top-level JSON value must be an object",
    );
    expect(() =>
      utils.parsePnpmPackOutput('{"name":"@cf-auth/core"}', "@cf-auth/core"),
    ).toThrow("@cf-auth/core: pnpm pack JSON output must include filename");
    expect(
      utils.parsePnpmPackOutput(
        '{"name":"@cf-auth/core","filename":"/tmp/core.tgz"}',
        "@cf-auth/core",
      ),
    ).toMatchObject({
      filename: "/tmp/core.tgz",
      name: "@cf-auth/core",
    });
  });

  it("rejects malformed dependency sections before scanning workspace specs", async () => {
    const utils = await loadUtils();

    expect(() =>
      utils.assertNoWorkspaceDependencies(
        { dependencies: "@cf-auth/core" },
        "generated app package.json",
      ),
    ).toThrow("generated app package.json: dependencies must be an object");
  });

  it("detects and rewrites workspace dependency specs", async () => {
    const utils = await loadUtils();
    const pkg = {
      dependencies: {
        "@cf-auth/core": "workspace:*",
        hono: "4.12.18",
      },
      devDependencies: {
        "@cf-auth/cli": "workspace:^",
      },
    };

    expect(() =>
      utils.assertNoWorkspaceDependencies(pkg, "tarball smoke package.json"),
    ).toThrow(
      "tarball smoke package.json contains workspace protocol dependencies: dependencies.@cf-auth/core, devDependencies.@cf-auth/cli",
    );

    utils.rewriteWorkspaceDependencySpecs(pkg, "package.json", (name) => {
      return `file:/tmp/${name.split("/").pop()}.tgz`;
    });

    expect(pkg.dependencies["@cf-auth/core"]).toBe("file:/tmp/core.tgz");
    expect(pkg.devDependencies["@cf-auth/cli"]).toBe("file:/tmp/cli.tgz");
    expect(() =>
      utils.assertNoWorkspaceDependencies(pkg, "tarball smoke package.json"),
    ).not.toThrow();
  });

  it("creates object sections and rejects scalar sections", async () => {
    const utils = await loadUtils();
    const pkg: Record<string, unknown> = {};

    expect(
      utils.getObjectSection(pkg, "dependencies", "package.json", {
        create: true,
      }),
    ).toEqual({});
    expect(pkg.dependencies).toEqual({});

    pkg.pnpm = "invalid";
    expect(() => utils.getObjectSection(pkg, "pnpm", "package.json")).toThrow(
      "package.json: pnpm must be an object",
    );
  });
});

async function loadUtils(): Promise<PackageJsonUtils> {
  const moduleUrl = pathToFileURL(
    resolve(process.cwd(), "scripts/package-json-utils.mjs"),
  ).href;
  return (await import(moduleUrl)) as PackageJsonUtils;
}
