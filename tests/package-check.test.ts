import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
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

  it("rejects workspace dependency ranges in packed manifests", async () => {
    const root = await packageCheckFixture();
    await writeFakePackTools(root);
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "packed package.json must not contain workspace: dependency ranges",
    );
  });

  it("rejects publishing reserved package shims without ownership evidence", async () => {
    const root = await packageCheckFixture();
    await updatePackageJson(root, "packages/cf-auth-shim/package.json", {
      privateValue: false,
      version: "0.1.0-beta.0",
    });
    await writeChangesetFixedGroup(root, [
      ...defaultPublishablePackages,
      "cf-auth",
    ]);
    const result = runPackageCheck(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs/package-ownership.json: required before publishing reserved packages",
    );
    expect(result.stderr).toContain(
      "cf-auth: docs/package-ownership.json must include ownership evidence before removing private: true",
    );
  });

  it("allows reserved package shims to publish after ownership evidence", async () => {
    const root = await packageCheckFixture();
    await updatePackageJson(root, "packages/cf-auth-shim/package.json", {
      privateValue: false,
      version: "0.1.0-beta.0",
    });
    await updatePackageJson(
      root,
      "packages/create-cloudflare-auth/package.json",
      {
        privateValue: false,
        version: "0.1.0-beta.0",
      },
    );
    await writeOwnershipEvidence(root, ["cf-auth", "create-cloudflare-auth"]);
    await writeChangesetFixedGroup(root, [
      ...defaultPublishablePackages,
      "cf-auth",
      "create-cloudflare-auth",
    ]);
    const result = runPackageCheck(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});

const defaultPublishablePackages = [
  "@cf-auth/cli",
  "@cf-auth/client",
  "@cf-auth/core",
  "@cf-auth/email-cloudflare",
  "@cf-auth/hono",
  "@cf-auth/testing",
  "@cf-auth/worker",
];

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

async function updatePackageJson(
  root: string,
  path: string,
  options: { privateValue: boolean; version: string },
) {
  const target = join(root, path);
  const pkg = JSON.parse(await readFile(target, "utf8"));
  pkg.private = options.privateValue;
  pkg.version = options.version;
  await writeFile(target, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function writeChangesetFixedGroup(root: string, packageNames: string[]) {
  const target = join(root, ".changeset", "config.json");
  const config = JSON.parse(await readFile(target, "utf8"));
  config.fixed = [[...packageNames].sort()];
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`);
}

async function writeOwnershipEvidence(root: string, packageNames: string[]) {
  await writeFile(
    join(root, "docs", "package-ownership.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        verifiedAt: "2026-05-14T00:00:00.000Z",
        verifiedBy: "release-reviewer",
        packages: packageNames.map((name) => ({
          name,
          registry: "https://registry.npmjs.org/",
          version: "0.1.0-beta.0",
          ownershipConfirmed: true,
          publisherTwoFactorEnabled: true,
          provenancePublish: true,
        })),
        reservedPackages: [],
      },
      null,
      2,
    )}\n`,
  );
}

async function writeFakePackTools(root: string) {
  const binDir = join(root, "bin");
  await mkdir(binDir, { recursive: true });
  const pnpmPath = join(binDir, "pnpm");
  await writeFile(
    pnpmPath,
    `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
const args = process.argv.slice(2);
const dir = args[args.indexOf("--dir") + 1];
const destination = args[args.indexOf("--pack-destination") + 1];
const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
mkdirSync(destination, { recursive: true });
const filename = join(destination, basename(dir) + ".tgz");
writeFileSync(filename, "");
writeFileSync(filename + ".package.json", JSON.stringify(pkg));
const paths = new Set(["package.json", "README.md", "LICENSE"]);
for (const value of [pkg.types, pkg.main, pkg.module]) {
  if (value) paths.add(String(value).replace(/^\\.\\//, ""));
}
for (const entry of Object.values(pkg.exports?.["."] ?? {})) {
  if (entry) paths.add(String(entry).replace(/^\\.\\//, ""));
}
for (const entry of Object.values(pkg.bin ?? {})) {
  if (entry) paths.add(String(entry).replace(/^\\.\\//, ""));
}
console.log(JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  filename,
  files: [...paths].map((path) => ({ path }))
}));
`,
  );
  await chmod(pnpmPath, 0o755);

  const tarPath = join(binDir, "tar");
  await writeFile(
    tarPath,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const filename = process.argv[3];
process.stdout.write(readFileSync(filename + ".package.json", "utf8"));
`,
  );
  await chmod(tarPath, 0o755);
}

function runPackageCheck(cwd: string) {
  const root = process.cwd();
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", "package-check.mjs")],
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
