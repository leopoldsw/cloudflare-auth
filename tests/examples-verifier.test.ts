import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("examples verifier", () => {
  it("accepts buildable example and template fixtures", async () => {
    const root = await examplesFixture();
    const result = runExamplesVerifier(root);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("rejects non-object example package manifests", async () => {
    const root = await examplesFixture();
    await writeFile(
      join(root, "examples", "hono-basic", "package.json"),
      "null\n",
    );
    const result = runExamplesVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "examples/hono-basic/package.json: top-level JSON value must be an object",
    );
  });

  it("rejects non-object Wrangler JSONC", async () => {
    const root = await examplesFixture();
    await writeFile(
      join(root, "templates", "worker-basic", "wrangler.jsonc"),
      "null\n",
    );
    const result = runExamplesVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "templates/worker-basic/wrangler.jsonc: top-level JSON value must be an object",
    );
  });

  it("rejects invalid version matrix JSON", async () => {
    const root = await examplesFixture();
    await writeFile(join(root, "scripts", "version-matrix.json"), "not json\n");
    const result = runExamplesVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "scripts/version-matrix.json: must be valid JSON",
    );
  });
});

async function examplesFixture() {
  const root = await mkdtemp(join(tmpdir(), "cf-auth-examples-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "packages", "cli"), { recursive: true });
  await mkdir(join(root, "migrations"), { recursive: true });
  await writeFakePnpm(root);
  await writeJson(join(root, "scripts", "version-matrix.json"), {
    node: ">=22.12.0",
    pnpm: "11.1.1",
    hono: "4.12.18",
    typescript: "6.0.3",
    tsup: "8.5.1",
    vitest: "4.1.6",
    zod: "4.4.3",
    changesets: "2.31.0",
    wrangler: "4.90.1",
    workersCompatibilityDate: "2026-05-14",
    workersCompatibilityDateFloor: "2024-09-23",
  });
  await writeJson(join(root, "packages", "cli", "package.json"), {
    name: "@cf-auth/cli",
    version: "0.1.0-beta.0",
  });
  for (const file of ["0001_initial.sql", "0002_indexes.sql"]) {
    await writeFile(join(root, "migrations", file), `${file}\n`);
  }
  for (const dir of [
    "examples/hono-basic",
    "examples/react-vite-worker",
    "examples/worker-basic",
    "templates/hono-basic",
    "templates/react-vite-worker",
    "templates/worker-basic",
  ]) {
    await writeProject(root, dir);
  }
  return root;
}

async function writeProject(root: string, dir: string) {
  const project = join(root, dir);
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "migrations"), { recursive: true });
  await writeJson(join(project, "package.json"), {
    name: dir.replace("/", "-"),
    packageManager: "pnpm@11.1.1",
    scripts: {
      build: 'node -e ""',
      test: 'node -e ""',
    },
    dependencies: {
      hono: "4.12.18",
    },
    devDependencies: {
      typescript: "6.0.3",
      vitest: "4.1.6",
      wrangler: "4.90.1",
    },
    engines: {
      node: ">=22.12.0",
    },
  });
  await writeJson(join(project, "wrangler.jsonc"), {
    $schema: "./node_modules/wrangler/config-schema.json",
    compatibility_date: "2026-05-14",
    compatibility_flags: ["nodejs_compat"],
    observability: { enabled: true, head_sampling_rate: 1 },
    vars: {
      AUTH_ENV: "development",
      AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
    },
    d1_databases: [
      {
        binding: "AUTH_DB",
        database_name: "auth",
        database_id: "local-development",
        migrations_dir: dir.startsWith("examples/")
          ? "../../migrations"
          : "migrations",
      },
    ],
  });
  await writeFile(
    join(project, ".dev.vars.example"),
    [
      "AUTH_ENV=development",
      "AUTH_PUBLIC_ORIGIN=http://localhost:8787",
      "AUTH_SECRET=k_dev.REPLACE_WITH_GENERATED_BASE64URL_SECRET",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(project, "src", "auth.config.ts"),
    [
      "export default defineAuthConfig({",
      "  passwordHashing: {",
      '    profile: "workers-balanced",',
      "    maxConcurrentHashesPerIsolate: 1,",
      "    queueTimeoutMs: 2000,",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  if (dir.startsWith("templates/")) {
    for (const file of ["0001_initial.sql", "0002_indexes.sql"]) {
      await writeFile(join(project, "migrations", file), `${file}\n`);
    }
  }
}

async function writeFakePnpm(root: string) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const pnpm = join(bin, "pnpm");
  await writeFile(
    pnpm,
    `#!/usr/bin/env node
process.exit(0);
`,
  );
  await chmod(pnpm, 0o755);
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runExamplesVerifier(cwd: string) {
  const root = process.cwd();
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", "verify-examples.mjs")],
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
