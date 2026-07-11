import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("deploy template verifier", () => {
  it("accepts a generated deploy template fixture", async () => {
    const root = await deployTemplateFixture();
    const result = runDeployTemplateVerifier(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deploy template verified");
    expect(result.stderr).toBe("");
  });

  it("rejects invalid generated package JSON", async () => {
    const root = await deployTemplateFixture({
      packageJson: "not json\n",
    });
    const result = runDeployTemplateVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package.json: must be valid JSON");
  });

  it("rejects non-object generated Wrangler JSON", async () => {
    const root = await deployTemplateFixture({
      wranglerJson: "null\n",
    });
    const result = runDeployTemplateVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "wrangler.jsonc: top-level JSON value must be an object",
    );
  });

  it("rejects invalid version matrix JSON", async () => {
    const root = await deployTemplateFixture();
    await writeFile(join(root, "scripts", "version-matrix.json"), "not json\n");
    const result = runDeployTemplateVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "scripts/version-matrix.json: must be valid JSON",
    );
  });

  it("rejects generated templates without the Cloudflare Email binding", async () => {
    const root = await deployTemplateFixture({
      wranglerJson: `${JSON.stringify(
        { ...wranglerJson(), send_email: [] },
        null,
        2,
      )}\n`,
    });
    const result = runDeployTemplateVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "wrangler.jsonc: missing AUTH_EMAIL send_email binding",
    );
  });

  it("rejects malformed generated Wrangler binding sections", async () => {
    const root = await deployTemplateFixture({
      wranglerJson: `${JSON.stringify(
        {
          ...wranglerJson(),
          d1_databases: "bad-d1",
        },
        null,
        2,
      )}\n`,
    });
    const result = runDeployTemplateVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "wrangler.jsonc: d1_databases must be an array",
    );
  });

  it("rejects malformed generated Cloudflare Email binding sections", async () => {
    const root = await deployTemplateFixture({
      wranglerJson: `${JSON.stringify(
        { ...wranglerJson(), send_email: "bad-email" },
        null,
        2,
      )}\n`,
    });
    const result = runDeployTemplateVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "wrangler.jsonc: send_email must be an array",
    );
  });

  it("rejects generated templates with local secret env files", async () => {
    const root = await deployTemplateFixture({
      extraExporterSource: [
        'await writeFile(dir + "/.dev.vars", "AUTH_SECRET=k1.secret\\n");',
        'await writeFile(dir + "/.env.production", "AUTH_SECRET=k1.secret\\n");',
        'await writeFile(dir + "/src/.env.local", "AUTH_SECRET=k1.secret\\n");',
      ].join("\n"),
    });
    const result = runDeployTemplateVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "template tree: must not include .dev.vars",
    );
    expect(result.stderr).toContain(
      "template tree: must not include .env.production",
    );
    expect(result.stderr).toContain(
      "template tree: must not include src/.env.local",
    );
  });

  it("rejects generated templates that do not ignore env secret variants", async () => {
    const root = await deployTemplateFixture({
      gitignore: "node_modules/\n.wrangler/\n.dev.vars\n.env\n*.log\n",
    });
    const result = runDeployTemplateVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".gitignore: missing .env.*");
  });

  it("rejects deploy scripts that run Wrangler before migrations", async () => {
    const pkg = packageJson();
    pkg.scripts.deploy = "wrangler deploy && pnpm db:migrations:apply";
    const root = await deployTemplateFixture({
      packageJson: `${JSON.stringify(pkg, null, 2)}\n`,
    });
    const result = runDeployTemplateVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "package.json: deploy script must apply D1 migrations before deploy",
    );
  });

  it("rejects generated templates with drifted migrations", async () => {
    const root = await deployTemplateFixture({
      extraExporterSource:
        'await writeFile(dir + "/migrations/0002_indexes.sql", "-- drifted\\n");',
    });
    const result = runDeployTemplateVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "migrations/0002_indexes.sql: must match root migration",
    );
  });
});

async function deployTemplateFixture(
  options: {
    packageJson?: string;
    wranglerJson?: string;
    gitignore?: string;
    extraExporterSource?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "cf-auth-deploy-template-test-"));
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "migrations"), { recursive: true });
  await writeFile(
    join(root, "migrations", "0001_initial.sql"),
    "-- initial migration\n",
  );
  await writeFile(
    join(root, "migrations", "0002_indexes.sql"),
    "-- index migration\n",
  );
  await writeJson(join(root, "scripts", "version-matrix.json"), {
    node: ">=22.13.0",
    pnpm: "11.1.1",
    hono: "4.12.18",
    typescript: "6.0.3",
    tsup: "8.5.1",
    vitest: "4.1.6",
    zod: "4.4.3",
    changesets: "2.31.0",
    wrangler: "4.90.1",
    workersCompatibilityDate: "2026-05-15",
    workersCompatibilityDateFloor: "2024-09-23",
  });
  await writeFile(
    join(root, "scripts", "export-deploy-template.mjs"),
    exporterSource({
      packageJson:
        options.packageJson ?? `${JSON.stringify(packageJson(), null, 2)}\n`,
      wranglerJson:
        options.wranglerJson ?? `${JSON.stringify(wranglerJson(), null, 2)}\n`,
      gitignore:
        options.gitignore ??
        "node_modules/\n.wrangler/\n.dev.vars\n.env\n.env.*\n*.log\n",
      extraExporterSource: options.extraExporterSource ?? "",
    }),
  );
  return root;
}

function packageJson() {
  return {
    name: "cloudflare-auth-template",
    private: true,
    packageManager: "pnpm@11.1.1",
    scripts: {
      "db:migrations:apply": "wrangler d1 migrations apply AUTH_DB --remote",
      deploy: "pnpm db:migrations:apply && wrangler deploy",
    },
    dependencies: {
      "@cf-auth/email-cloudflare": "beta",
      "@cf-auth/hono": "beta",
      "@cf-auth/worker": "beta",
      hono: "4.12.18",
    },
    devDependencies: {
      "@cf-auth/cli": "beta",
      typescript: "6.0.3",
      vitest: "4.1.6",
      wrangler: "4.90.1",
    },
    cloudflare: {
      bindings: {
        AUTH_DB: { description: "D1 database" },
        AUTH_SECRET: {
          description:
            "Generate with `npx --package @cf-auth/cli@beta cf-auth rotate-secret --print`.",
        },
        AUTH_PUBLIC_ORIGIN: { description: "Public origin" },
        AUTH_EMAIL: { description: "Email binding" },
      },
    },
  };
}

function wranglerJson() {
  return {
    $schema: "./node_modules/wrangler/config-schema.json",
    compatibility_date: "2026-05-15",
    compatibility_flags: ["nodejs_compat"],
    observability: {
      enabled: true,
      head_sampling_rate: 1,
    },
    vars: {
      AUTH_ENV: "production",
      AUTH_PUBLIC_ORIGIN: "https://auth.example.test",
    },
    d1_databases: [
      {
        binding: "AUTH_DB",
        database_name: "auth",
        database_id: "auth",
        migrations_dir: "migrations",
      },
    ],
    send_email: [{ name: "AUTH_EMAIL", remote: true }],
  };
}

function exporterSource(input: {
  packageJson: string;
  wranglerJson: string;
  gitignore: string;
  extraExporterSource: string;
}) {
  return `import { mkdir, writeFile } from "node:fs/promises";
const dir = process.argv[2];
await mkdir(dir + "/src", { recursive: true });
await mkdir(dir + "/migrations", { recursive: true });
await writeFile(dir + "/migrations/0001_initial.sql", "-- initial migration\\n");
await writeFile(dir + "/migrations/0002_indexes.sql", "-- index migration\\n");
await writeFile(dir + "/package.json", ${JSON.stringify(input.packageJson)});
await writeFile(dir + "/wrangler.jsonc", ${JSON.stringify(input.wranglerJson)});
await writeFile(dir + "/README.md", "https://deploy.workers.cloudflare.com/?url=https://github.com/acme/cloudflare-auth-template\\nAUTH_PUBLIC_ORIGIN\\nAUTH_SECRET\\nAUTH_EMAIL\\nnpx --package @cf-auth/cli@beta cf-auth rotate-secret --print\\n");
await writeFile(dir + "/.dev.vars.example", "AUTH_SECRET=k1.REPLACE_WITH_32_BYTE_BASE64URL_SECRET\\n");
await writeFile(dir + "/.gitignore", ${JSON.stringify(input.gitignore)});
${input.extraExporterSource}
`;
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runDeployTemplateVerifier(cwd: string) {
  const root = process.cwd();
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", "verify-deploy-template.mjs")],
    {
      cwd,
      encoding: "utf8",
    },
  );
}
