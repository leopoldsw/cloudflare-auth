import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("package checks", () => {
  it("accepts the release workflow fixture", async () => {
    const root = await packageCheckFixture();
    const result = runPackageCheck(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("requires the production smoke workflow safety gate", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/cloudflare-production-smoke.yml",
      'CF_AUTH_PRODUCTION_SMOKE: "1"',
      'CF_AUTH_PRODUCTION_SMOKE: "0"',
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      '.github/workflows/cloudflare-production-smoke.yml: missing CF_AUTH_PRODUCTION_SMOKE: "1"',
    );
  });

  it("requires the published quickstart package tag input", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/published-quickstart-smoke.yml",
      "CF_AUTH_PUBLISHED_QUICKSTART_PACKAGE_TAG",
      "CF_AUTH_PUBLISHED_QUICKSTART_VERSION",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/published-quickstart-smoke.yml: missing CF_AUTH_PUBLISHED_QUICKSTART_PACKAGE_TAG",
    );
  });

  it("requires release gates before package publication", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "      - run: pnpm release:gates",
      "      - run: pnpm changeset publish --provenance\n      - run: pnpm release:gates",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: pnpm changeset publish --provenance must appear after pnpm benchmark:password",
    );
  });

  it("requires tests before package publication", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "      - run: pnpm typecheck",
      "      - run: pnpm test\n      - run: pnpm typecheck",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: pnpm test must appear after pnpm typecheck",
    );
  });

  it("requires npm auth token wiring for publication", async () => {
    const root = await packageCheckFixture();
    await replaceFixtureText(
      root,
      ".github/workflows/release.yml",
      "NODE_AUTH_TOKEN",
      "NODE_PACKAGE_TOKEN",
    );
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      ".github/workflows/release.yml: missing NODE_AUTH_TOKEN",
    );
  });
});

async function packageCheckFixture() {
  const sourceRoot = process.cwd();
  const root = await mkdtemp(join(tmpdir(), "cf-auth-package-check-"));
  for (const file of ["package.json", "LICENSE", "README.md"]) {
    await cp(join(sourceRoot, file), join(root, file));
  }
  for (const dir of ["docs", "packages", ".github", ".changeset"]) {
    await cp(join(sourceRoot, dir), join(root, dir), { recursive: true });
  }
  await mkdir(join(root, "scripts"), { recursive: true });
  await cp(
    join(sourceRoot, "scripts", "version-matrix.json"),
    join(root, "scripts", "version-matrix.json"),
  );
  return root;
}

async function replaceFixtureText(
  root: string,
  path: string,
  search: string,
  replacement: string,
) {
  const target = join(root, path);
  const text = await readFile(target, "utf8");
  if (!text.includes(search)) {
    throw new Error(`${path}: missing fixture text ${search}`);
  }
  await writeFile(target, text.replace(search, replacement));
}

function runPackageCheck(cwd: string) {
  const root = process.cwd();
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", "package-check.mjs")],
    {
      cwd,
      encoding: "utf8",
    },
  );
}
