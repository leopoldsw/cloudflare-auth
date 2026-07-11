import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runCli as runCliRaw } from "@cf-auth/cli";
import { describe, expect, it } from "vitest";

const runCli: typeof runCliRaw = (args, io = {}) =>
  runCliRaw(args, {
    benchmarkPasswordProfile: async (profile) => ({
      profile,
      runtime: "workers-local",
      warmupHashes: 3,
      measuredHashes: 10,
      p50Ms: 50,
      p95Ms: 58,
      throughputHashesPerSecond: 17.24,
    }),
    ...io,
  });
const generatedPackageVersion = JSON.parse(
  await readFile("packages/cli/package.json", "utf8"),
).version as string;
const rootMigrationFiles = (await readdir("migrations"))
  .filter((file) => file.endsWith(".sql"))
  .sort();

describe("CLI MVP", () => {
  it("rejects non-v1 command aliases from the implementation plan", async () => {
    const upgradeErrors: string[] = [];
    const upgradeCode = await runCli(["upgrade"], {
      stderr: (line) => upgradeErrors.push(line),
    });
    const turnstileErrors: string[] = [];
    const turnstileCode = await runCli(["add", "turnstile"], {
      stderr: (line) => turnstileErrors.push(line),
    });

    expect(upgradeCode).toBe(1);
    expect(upgradeErrors.join("\n")).toContain("Unknown command: upgrade");
    expect(turnstileCode).toBe(1);
    expect(turnstileErrors.join("\n")).toContain("Unknown command: add");
  });

  it("scaffolds a new Hono app without manual source mutation", async () => {
    const cwd = await tempDir();
    const output: string[] = [];
    const code = await runCli(["init", "my-app", "--yes"], {
      cwd,
      stdout: (line) => output.push(line),
    });
    const app = join(cwd, "my-app");
    expect(code).toBe(0);
    expect(existsSync(join(app, "src", "auth.config.ts"))).toBe(true);
    expect(existsSync(join(app, "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(join(app, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(app, ".dev.vars"))).toBe(true);
    expect(existsSync(join(app, "migrations", "0001_initial.sql"))).toBe(true);
    const generatedPackage = JSON.parse(
      await readFile(join(app, "package.json"), "utf8"),
    ) as {
      name: string;
      packageManager: string;
      dependencies: Record<string, string>;
      scripts: Record<string, string>;
      pnpm: { onlyBuiltDependencies: string[] };
    };
    expect(generatedPackage.name).toBe("my-app");
    expect(generatedPackage.packageManager).toBe("pnpm@11.1.1");
    expect(generatedPackage.dependencies["@cf-auth/email-cloudflare"]).toBe(
      generatedPackageVersion,
    );
    expect(generatedPackage.dependencies["@cf-auth/hono"]).toBe(
      generatedPackageVersion,
    );
    expect(generatedPackage.dependencies["@cf-auth/worker"]).toBe(
      generatedPackageVersion,
    );
    expect(generatedPackage.scripts.test).toBe("vitest run --passWithNoTests");
    expect(generatedPackage.pnpm.onlyBuiltDependencies).toEqual([
      "esbuild",
      "sharp",
      "workerd",
    ]);
    const pnpmWorkspace = await readFile(
      join(app, "pnpm-workspace.yaml"),
      "utf8",
    );
    expect(pnpmWorkspace).toContain("allowBuilds:");
    expect(pnpmWorkspace).toContain("workerd: true");
    expect(JSON.stringify(generatedPackage)).not.toContain("workspace:");
    const tsconfig = await readFile(join(app, "tsconfig.json"), "utf8");
    expect(tsconfig).toContain('"module": "NodeNext"');
    expect(tsconfig).not.toContain("../../tsconfig");
    const devVars = await readFile(join(app, ".dev.vars"), "utf8");
    expect(devVars).toMatch(/AUTH_SECRET=k_dev\.[A-Za-z0-9_-]{43}(?:\n|$)/);
    const gitignore = await readFile(join(app, ".gitignore"), "utf8");
    expect(gitignore).toContain("*.cf-auth-backup");
    const source = await readFile(join(app, "src", "index.ts"), "utf8");
    expect(source).toContain('import authConfig from "./auth.config.js"');
    expect(source).toContain("app.route(authConfig.basePath");
    const wrangler = await readFile(join(app, "wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"$schema"');
    expect(wrangler).toContain('"name": "my-app-dev"');
    expect(wrangler).toContain('"compatibility_date": "2026-05-15"');
    expect(wrangler).toContain('"compatibility_flags": ["nodejs_compat"]');
    expect(wrangler).toContain('"database_name": "my-app-auth-dev"');
    expect(wrangler).toContain('"database_id": "local-development"');
    expect(wrangler).toContain('"migrations_dir": "migrations"');
    expect(wrangler).toContain('"observability"');
    expect(wrangler).toContain('"head_sampling_rate": 1');
    for (const file of rootMigrationFiles) {
      await expect(
        readFile(join(app, "migrations", file), "utf8"),
      ).resolves.toBe(await readFile(join("migrations", file), "utf8"));
    }
    expect(output.join("\n")).toContain("Initialized Cloudflare Auth");
  });

  it("scaffolds bundled migrations without relying on the repo cwd", async () => {
    const cwd = await tempDir();
    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      const code = await runCli(["init", "standalone", "--yes"], { cwd });
      expect(code).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
    for (const file of rootMigrationFiles) {
      await expect(
        readFile(join(cwd, "standalone", "migrations", file), "utf8"),
      ).resolves.toBe(await readFile(join("migrations", file), "utf8"));
    }
  });

  it("uses Worker-safe names in generated Wrangler config", async () => {
    const cwd = await tempDir();
    const code = await runCli(["init", "My_App.v2", "--yes"], { cwd });
    const app = join(cwd, "My_App.v2");

    expect(code).toBe(0);
    const generatedPackage = JSON.parse(
      await readFile(join(app, "package.json"), "utf8"),
    ) as { name: string };
    const wrangler = JSON.parse(
      await readFile(join(app, "wrangler.jsonc"), "utf8"),
    ) as {
      name: string;
      d1_databases: Array<{ database_name: string }>;
      env: {
        production: {
          name: string;
          d1_databases: Array<{ database_name: string }>;
        };
      };
    };
    expect(generatedPackage.name).toBe("my_app.v2");
    expect(wrangler.name).toBe("my-app-v2-dev");
    expect(wrangler.d1_databases[0]?.database_name).toBe("my-app-v2-auth-dev");
    expect(wrangler.env.production.name).toBe("my-app-v2");
    expect(wrangler.env.production.d1_databases[0]?.database_name).toBe(
      "my-app-v2-auth",
    );
  });

  it("honors the plain Worker init template", async () => {
    const cwd = await tempDir();
    const code = await runCli(
      ["init", "worker-app", "--template", "worker-basic", "--yes"],
      {
        cwd,
      },
    );
    const app = join(cwd, "worker-app");
    expect(code).toBe(0);
    const generatedPackage = JSON.parse(
      await readFile(join(app, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(generatedPackage.dependencies["@cf-auth/worker"]).toBe(
      generatedPackageVersion,
    );
    expect(generatedPackage.dependencies["@cf-auth/email-cloudflare"]).toBe(
      generatedPackageVersion,
    );
    expect(generatedPackage.dependencies["@cf-auth/hono"]).toBeUndefined();
    expect(generatedPackage.dependencies.hono).toBeUndefined();
    const source = await readFile(join(app, "src", "index.ts"), "utf8");
    expect(source).toContain("createAuthHandler(authConfig)");
    expect(source).not.toContain("createAuthRoutes");
    const wrangler = JSON.parse(
      await readFile(join(app, "wrangler.jsonc"), "utf8"),
    ) as {
      name: string;
      d1_databases: Array<{
        database_name: string;
        migrations_dir?: string;
      }>;
      env: {
        production: {
          name: string;
          d1_databases: Array<{
            database_name: string;
            migrations_dir?: string;
          }>;
        };
      };
    };
    expect(wrangler.name).toBe("worker-app-dev");
    expect(wrangler.d1_databases[0]).toMatchObject({
      database_name: "worker-app-auth-dev",
      migrations_dir: "migrations",
    });
    expect(wrangler.env.production.name).toBe("worker-app");
    expect(wrangler.env.production.d1_databases[0]).toMatchObject({
      database_name: "worker-app-auth",
      migrations_dir: "migrations",
    });
  });

  it("prints snippets and writes nothing in dry-run init", async () => {
    const cwd = await tempDir();
    const output: string[] = [];
    const code = await runCli(["init", "--dry-run"], {
      cwd,
      stdout: (line) => output.push(line),
    });
    expect(code).toBe(0);
    expect(output.join("\n")).toContain("Hono mount");
    expect(existsSync(join(cwd, "auth.config.ts"))).toBe(false);
  });

  it("rejects unknown init templates", async () => {
    const cwd = await tempDir();
    const errors: string[] = [];
    const code = await runCli(["init", "bad-app", "--template", "unknown"], {
      cwd,
      stderr: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Unsupported template: unknown");
    expect(existsSync(join(cwd, "bad-app"))).toBe(false);
  });

  it("patches existing app package metadata without changing source", async () => {
    const cwd = await tempDir();
    const app = join(cwd, "existing-app");
    await mkdir(join(app, "src"), { recursive: true });
    const existingSource =
      "export default { fetch: () => new Response('ok') };\n";
    await writeFile(
      join(app, "package.json"),
      JSON.stringify(
        {
          name: "existing-app",
          type: "module",
          dependencies: { hono: "4.12.18" },
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(join(app, "src", "index.ts"), existingSource);
    await writeFile(
      join(app, "wrangler.json"),
      JSON.stringify(
        {
          name: "existing-app-dev",
          main: "src/index.ts",
          vars: {},
        },
        null,
        2,
      ) + "\n",
    );
    const output: string[] = [];

    const code = await runCli(["init", "existing-app"], {
      cwd,
      stdout: (line) => output.push(line),
    });

    expect(code).toBe(0);
    const packageJson = JSON.parse(
      await readFile(join(app, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(packageJson.dependencies.hono).toBe("4.12.18");
    expect(packageJson.dependencies["@cf-auth/hono"]).toBe(
      generatedPackageVersion,
    );
    expect(packageJson.dependencies["@cf-auth/worker"]).toBe(
      generatedPackageVersion,
    );
    expect(packageJson.dependencies["@cf-auth/email-cloudflare"]).toBe(
      generatedPackageVersion,
    );
    expect(packageJson.devDependencies.wrangler).toBe("4.90.1");
    await expect(readFile(join(app, "src", "index.ts"), "utf8")).resolves.toBe(
      existingSource,
    );
    expect(existsSync(join(app, "wrangler.jsonc"))).toBe(false);
    const wrangler = JSON.parse(
      await readFile(join(app, "wrangler.json"), "utf8"),
    ) as {
      vars: Record<string, string>;
      d1_databases: Array<{ binding: string; migrations_dir?: string }>;
      env: {
        production: {
          vars: Record<string, string>;
          d1_databases: Array<{ binding: string; migrations_dir?: string }>;
        };
      };
    };
    expect(wrangler.vars.AUTH_ENV).toBe("development");
    expect(wrangler.d1_databases[0]).toMatchObject({
      binding: "AUTH_DB",
      migrations_dir: "migrations",
    });
    expect(wrangler.env.production.vars.AUTH_ENV).toBe("production");
    expect(wrangler.env.production.d1_databases[0]).toMatchObject({
      binding: "AUTH_DB",
      migrations_dir: "migrations",
    });
    const backup = JSON.parse(
      await readFile(join(app, "wrangler.json.cf-auth-backup"), "utf8"),
    ) as {
      vars: Record<string, string>;
      d1_databases?: unknown;
    };
    expect(backup.vars).toEqual({});
    expect(backup.d1_databases).toBeUndefined();
    expect(output.join("\n")).toContain(
      "Repaired Wrangler auth bindings and vars.",
    );
    expect(output.join("\n")).toContain("wrangler.json.cf-auth-backup");
    expect(output.join("\n")).toContain(
      "Existing src/index.ts was left unchanged",
    );
    expect(output.join("\n")).toContain("app.route(authConfig.basePath");
  });

  it("reports malformed existing package metadata during init", async () => {
    const cwd = await tempDir();
    const app = join(cwd, "bad-package-app");
    await mkdir(app, { recursive: true });
    await writeFile(join(app, "package.json"), "null\n");
    const scalarErrors: string[] = [];

    const scalarCode = await runCli(["init", "bad-package-app"], {
      cwd,
      stderr: (line) => scalarErrors.push(line),
    });

    expect(scalarCode).toBe(1);
    expect(scalarErrors.join("\n")).toContain(
      "package.json: top-level JSON value must be an object",
    );

    await writeFile(
      join(app, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            hono: true,
          },
        },
        null,
        2,
      ),
    );
    const dependencyErrors: string[] = [];

    const dependencyCode = await runCli(["init", "bad-package-app"], {
      cwd,
      stderr: (line) => dependencyErrors.push(line),
    });

    expect(dependencyCode).toBe(1);
    expect(dependencyErrors.join("\n")).toContain(
      "package.json: dependencies.hono must be a string version",
    );
  });

  it("repairs malformed Wrangler auth sections without crashing", async () => {
    const cwd = await tempDir();
    const app = join(cwd, "malformed-wrangler-app");
    await mkdir(join(app, "src"), { recursive: true });
    await writeFile(
      join(app, "package.json"),
      JSON.stringify({
        name: "malformed-wrangler-app",
        dependencies: { hono: "4.12.18" },
      }),
    );
    await writeFile(
      join(app, "wrangler.jsonc"),
      JSON.stringify({
        name: "malformed-wrangler-app-dev",
        main: "src/index.ts",
        compatibility_flags: "nodejs_compat",
        observability: "enabled",
        vars: "bad-vars",
        d1_databases: "bad-d1",
        env: {
          production: {
            compatibility_flags: "nodejs_compat",
            observability: "enabled",
            vars: "bad-vars",
            d1_databases: "bad-d1",
            send_email: "bad-email",
          },
        },
      }),
    );
    const output: string[] = [];

    const code = await runCli(["init", "malformed-wrangler-app"], {
      cwd,
      stdout: (line) => output.push(line),
    });

    expect(code).toBe(0);
    expect(output.join("\n")).toContain(
      "Repaired Wrangler auth bindings and vars.",
    );
    const wrangler = JSON.parse(
      await readFile(join(app, "wrangler.jsonc"), "utf8"),
    ) as {
      compatibility_flags: string[];
      observability: { enabled: boolean; head_sampling_rate: number };
      vars: Record<string, string>;
      d1_databases: Array<{ binding: string; database_id: string }>;
      env: {
        production: {
          compatibility_flags: string[];
          observability: { enabled: boolean; head_sampling_rate: number };
          vars: Record<string, string>;
          d1_databases: Array<{ binding: string; database_id: string }>;
          send_email: Array<{ name: string; remote?: boolean }>;
        };
      };
    };
    expect(wrangler.compatibility_flags).toContain("nodejs_compat");
    expect(wrangler.observability.head_sampling_rate).toBe(1);
    expect(wrangler.vars.AUTH_ENV).toBe("development");
    expect(wrangler.d1_databases[0]).toMatchObject({
      binding: "AUTH_DB",
      database_id: "local-development",
    });
    expect(wrangler.env.production.compatibility_flags).toContain(
      "nodejs_compat",
    );
    expect(wrangler.env.production.observability.head_sampling_rate).toBe(1);
    expect(wrangler.env.production.vars.AUTH_ENV).toBe("production");
    expect(wrangler.env.production.d1_databases[0]).toMatchObject({
      binding: "AUTH_DB",
      database_id: "REPLACE_WITH_DATABASE_ID",
    });
    expect(wrangler.env.production.send_email).toContainEqual({
      name: "AUTH_EMAIL",
      remote: true,
    });
  });

  it("repairs missing auth Wrangler bindings without changing source", async () => {
    const cwd = await tempDir();
    const app = join(cwd, "repair-app");
    await mkdir(join(app, "src"), { recursive: true });
    const existingSource =
      "export default { fetch: () => new Response('ok') };\n";
    await writeFile(join(app, "src", "index.ts"), existingSource);
    await writeFile(
      join(app, "wrangler.jsonc"),
      JSON.stringify(
        {
          name: "repair-app-dev",
          main: "src/index.ts",
          vars: {},
          env: { production: { name: "repair-app" } },
        },
        null,
        2,
      ),
    );
    const output: string[] = [];

    const code = await runCli(["init", "repair-app", "--repair"], {
      cwd,
      stdout: (line) => output.push(line),
    });

    expect(code).toBe(0);
    await expect(readFile(join(app, "src", "index.ts"), "utf8")).resolves.toBe(
      existingSource,
    );
    const wrangler = JSON.parse(
      await readFile(join(app, "wrangler.jsonc"), "utf8"),
    ) as {
      $schema?: string;
      compatibility_date?: string;
      compatibility_flags?: string[];
      vars: Record<string, string>;
      observability?: { enabled?: boolean; head_sampling_rate?: number };
      d1_databases: Array<{
        binding: string;
        database_id: string;
        migrations_dir?: string;
      }>;
      env: {
        production: {
          vars: Record<string, string>;
          d1_databases: Array<{
            binding: string;
            database_id: string;
            migrations_dir?: string;
          }>;
          send_email: Array<{ name: string; remote?: boolean }>;
        };
      };
    };
    expect(wrangler.$schema).toBe("./node_modules/wrangler/config-schema.json");
    expect(wrangler.compatibility_date).toBe("2026-05-15");
    expect(wrangler.compatibility_flags).toContain("nodejs_compat");
    expect(wrangler.vars.AUTH_ENV).toBe("development");
    expect(wrangler.observability).toEqual({
      enabled: true,
      head_sampling_rate: 1,
    });
    expect(wrangler.d1_databases[0]).toMatchObject({
      binding: "AUTH_DB",
      database_id: "local-development",
      migrations_dir: "migrations",
    });
    expect(wrangler.env.production.vars.AUTH_ENV).toBe("production");
    expect(wrangler.env.production.d1_databases[0]).toMatchObject({
      binding: "AUTH_DB",
      database_id: "REPLACE_WITH_DATABASE_ID",
      migrations_dir: "migrations",
    });
    expect(wrangler.env.production.send_email).toContainEqual({
      name: "AUTH_EMAIL",
      remote: true,
    });
    const backup = JSON.parse(
      await readFile(join(app, "wrangler.jsonc.cf-auth-backup"), "utf8"),
    ) as {
      vars: Record<string, string>;
      d1_databases?: unknown;
    };
    expect(backup.vars).toEqual({});
    expect(backup.d1_databases).toBeUndefined();
    expect(output.join("\n")).toContain(
      "Repaired Wrangler auth bindings and vars.",
    );
    expect(output.join("\n")).toContain("wrangler.jsonc.cf-auth-backup");
  });

  it("constructs local and remote Wrangler migration commands", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const local: string[] = [];
    const localCalls: string[] = [];
    await runCli(["migrate", "--status", "--local"], {
      cwd,
      stdout: (line) => local.push(line),
      runCommand: (command, args) => {
        localCalls.push([command, ...args].join(" "));
        return { status: 0, stdout: "local migrations\n", stderr: "" };
      },
    });
    expect(localCalls).toEqual([
      "wrangler d1 migrations list app-auth-dev --local",
    ]);
    expect(local.join("\n")).toContain(
      "wrangler d1 migrations list app-auth-dev --local",
    );
    expect(local.join("\n")).toContain("local migrations");

    const localApply: string[] = [];
    const localApplyCalls: string[] = [];
    await runCli(["migrate", "--local"], {
      cwd,
      stdout: (line) => localApply.push(line),
      runCommand: (command, args) => {
        localApplyCalls.push([command, ...args].join(" "));
        if (args[0] === "d1" && args[1] === "execute") {
          return { status: 0, stdout: migrationStateJson(), stderr: "" };
        }
        return { status: 0, stdout: "local migrated\n", stderr: "" };
      },
    });
    expect(localApplyCalls).toEqual([
      "wrangler d1 migrations apply app-auth-dev --local",
      `wrangler d1 execute app-auth-dev --local --json --command ${migrationStateSql()}`,
    ]);
    expect(localApply.join("\n")).toContain(
      "wrangler d1 migrations apply app-auth-dev --local",
    );
    expect(localApply.join("\n")).toContain(
      "D1 migrations are applied locally",
    );

    const remote: string[] = [];
    const remoteCalls: string[] = [];
    await runCli(["migrate", "--remote", "--env", "production"], {
      cwd,
      stdout: (line) => remote.push(line),
      runCommand: (command, args) => {
        remoteCalls.push([command, ...args].join(" "));
        if (args[0] === "d1" && args[1] === "execute") {
          return { status: 0, stdout: migrationStateJson(), stderr: "" };
        }
        return { status: 0, stdout: "remote migrated\n", stderr: "" };
      },
    });
    expect(remoteCalls).toEqual([
      "wrangler d1 migrations apply app-auth --remote --env production",
      `wrangler d1 execute app-auth --remote --env production --json --command ${migrationStateSql()}`,
    ]);
    expect(remote.join("\n")).toContain(
      "wrangler d1 migrations apply app-auth --remote --env production",
    );
    expect(remote.join("\n")).toContain("D1 migrations are applied remotely");

    const remoteStatus: string[] = [];
    const remoteStatusCalls: string[] = [];
    await runCli(["migrate", "--status", "--remote", "--env", "production"], {
      cwd,
      stdout: (line) => remoteStatus.push(line),
      runCommand: (command, args) => {
        remoteStatusCalls.push([command, ...args].join(" "));
        return { status: 0, stdout: "remote migrations\n", stderr: "" };
      },
    });
    expect(remoteStatusCalls).toEqual([
      "wrangler d1 migrations list app-auth --remote --env production",
    ]);
    expect(remoteStatus.join("\n")).toContain(
      "wrangler d1 migrations list app-auth --remote --env production",
    );
    expect(remoteStatus.join("\n")).toContain("remote migrations");

    const dryRun: string[] = [];
    await runCli(["migrate", "--dry-run", "--remote", "--env", "production"], {
      cwd,
      stdout: (line) => dryRun.push(line),
    });
    expect(dryRun[0]).toBe(
      "wrangler d1 migrations apply app-auth --remote --env production",
    );

    const errors: string[] = [];
    const code = await runCli(["migrate", "--remote"], {
      cwd,
      stderr: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Remote migrations require --env");
  });

  it("rejects remote migrations without --env for top-level development configs", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, "migrations"), { recursive: true });
    await writeFile(join(cwd, "migrations", "0001_initial.sql"), "-- test\n");
    await writeFile(
      join(cwd, "wrangler.jsonc"),
      JSON.stringify(
        {
          vars: {
            AUTH_ENV: "development",
            AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
          },
          d1_databases: [
            {
              binding: "AUTH_DB",
              database_name: "app-auth-dev",
              database_id: "local-id",
            },
          ],
        },
        null,
        2,
      ),
    );

    const errors: string[] = [];
    const code = await runCli(["migrate", "--remote"], {
      cwd,
      stderr: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Remote migrations without --env require top-level vars.AUTH_ENV=production",
    );
  });

  it("rejects named remote migrations with development AUTH_ENV", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const wranglerPath = join(cwd, "wrangler.jsonc");
    const config = JSON.parse(await readFile(wranglerPath, "utf8")) as {
      env: { production: { vars: Record<string, string> } };
    };
    config.env.production.vars.AUTH_ENV = "development";
    config.env.production.vars.AUTH_PUBLIC_ORIGIN = "http://localhost:8787";
    await writeFile(wranglerPath, JSON.stringify(config, null, 2));

    const errors: string[] = [];
    const code = await runCli(["migrate", "--remote", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Remote migrations must not target vars.AUTH_ENV=development",
    );
  });

  it("rejects named remote migrations without explicit remote AUTH_ENV", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const wranglerPath = join(cwd, "wrangler.jsonc");
    const config = JSON.parse(await readFile(wranglerPath, "utf8")) as {
      env: { production: { vars: Record<string, string> } };
    };
    delete config.env.production.vars.AUTH_ENV;
    await writeFile(wranglerPath, JSON.stringify(config, null, 2));

    const errors: string[] = [];
    const calls: string[] = [];
    const code = await runCli(["migrate", "--remote", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: (command, args) => {
        calls.push([command, ...args].join(" "));
        return { status: 0, stdout: "remote migrated\n", stderr: "" };
      },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Remote migrations must target vars.AUTH_ENV=preview or production",
    );
    expect(calls).toEqual([]);
  });

  it("parses Wrangler JSONC comments and trailing commas", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, "migrations"), { recursive: true });
    await writeFile(join(cwd, "migrations", "0001_initial.sql"), "-- test\n");
    await writeFile(
      join(cwd, "wrangler.jsonc"),
      `{
  // Local development Worker
  "name": "jsonc-app-dev",
  "compatibility_date": "2026-05-15",
  "compatibility_flags": ["nodejs_compat",],
  "vars": {
    "AUTH_ENV": "development",
    "AUTH_PUBLIC_ORIGIN": "http://localhost:8787", // keep URL slashes
  },
  "d1_databases": [
    {
      "binding": "AUTH_DB",
      "database_name": "jsonc-app-auth-dev",
      "database_id": "local-development",
    },
  ],
}
`,
    );
    const output: string[] = [];

    const code = await runCli(["migrate", "--dry-run", "--local"], {
      cwd,
      stdout: (line) => output.push(line),
    });

    expect(code).toBe(0);
    expect(output[0]).toBe(
      "wrangler d1 migrations apply jsonc-app-auth-dev --local",
    );
  });

  it("rejects unknown generate snippets instead of aliasing them", async () => {
    const workerOutput: string[] = [];
    const typeOutput: string[] = [];
    const errors: string[] = [];
    const ok = await runCli(["generate", "worker-snippet"], {
      stdout: (line) => workerOutput.push(line),
    });
    const types = await runCli(["generate", "types"], {
      stdout: (line) => typeOutput.push(line),
    });
    const bad = await runCli(["generate", "turnstile"], {
      stderr: (line) => errors.push(line),
    });

    expect(ok).toBe(0);
    expect(types).toBe(0);
    expect(workerOutput.join("\n")).toContain("createAuthHandler(authConfig)");
    expect(workerOutput.join("\n")).toContain(
      "if (authResponse) return authResponse;",
    );
    expect(typeOutput.join("\n")).toContain("AUTH_DB: D1Database");
    expect(typeOutput.join("\n")).toContain("AUTH_EMAIL?:");
    expect(typeOutput.join("\n")).toContain("send(message:");
    expect(typeOutput.join("\n")).toContain("AUTH_RATE_LIMITER?:");
    expect(typeOutput.join("\n")).toContain(
      "limit(input: { key: string }): Promise<{ success: boolean }>",
    );
    expect(typeOutput.join("\n")).toContain("AUTH_SECRET_PREVIOUS?: string");
    expect(typeOutput.join("\n")).toContain(
      'AUTH_ENV: "development" | "preview" | "production"',
    );
    expect(typeOutput.join("\n")).toContain("TURNSTILE_SECRET_KEY?: string");
    expect(bad).toBe(1);
    expect(errors.join("\n")).toContain("Unsupported generator: turnstile");
  });

  it("doctor reports missing D1 and secret fixes without leaking sensitive values", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, "wrangler.jsonc"),
      JSON.stringify(
        {
          vars: {
            AUTH_ENV: "development",
            AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
          },
        },
        null,
        2,
      ),
    );
    const errors: string[] = [];
    const code = await runCli(["doctor"], {
      cwd,
      stderr: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("D1 binding AUTH_DB is missing");
    expect(errors.join("\n")).not.toMatch(/cfauth\.|AUTH_SECRET=/);
  });

  it("doctor reports invalid Wrangler config files cleanly", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "wrangler.jsonc"), "not json\n");
    const invalidErrors: string[] = [];
    const invalidCode = await runCli(["doctor"], {
      cwd,
      stderr: (line) => invalidErrors.push(line),
      runCommand: localDoctorRunner(),
    });

    expect(invalidCode).toBe(1);
    expect(invalidErrors.join("\n")).toContain(
      "wrangler.jsonc: must be valid JSONC",
    );
    expect(invalidErrors.join("\n")).toContain("fix the Wrangler config JSONC");

    await writeFile(join(cwd, "wrangler.jsonc"), "null\n");
    const scalarErrors: string[] = [];
    const scalarCode = await runCli(["doctor"], {
      cwd,
      stderr: (line) => scalarErrors.push(line),
      runCommand: localDoctorRunner(),
    });

    expect(scalarCode).toBe(1);
    expect(scalarErrors.join("\n")).toContain(
      "wrangler.jsonc: top-level JSON value must be an object",
    );
  });

  it("doctor reports malformed nested Wrangler sections cleanly", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    let text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const badEnvConfig = JSON.parse(text) as { env?: unknown };
    badEnvConfig.env = "bad-env";
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(badEnvConfig));
    const envErrors: string[] = [];

    const envCode = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => envErrors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(envCode).toBe(1);
    expect(envErrors.join("\n")).toContain("Wrangler env must be an object");

    await writeWrangler(cwd);
    text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const badD1Config = JSON.parse(text) as {
      env: { production: { d1_databases?: unknown } };
    };
    badD1Config.env.production.d1_databases = "bad-d1";
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(badD1Config));
    const d1Errors: string[] = [];

    const d1Code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => d1Errors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(d1Code).toBe(1);
    expect(d1Errors.join("\n")).toContain(
      "Wrangler d1_databases must be an array",
    );
  });

  it("doctor validates readable local auth secrets", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await writeFile(
      join(cwd, ".dev.vars"),
      `AUTH_SECRET=k_dev.${"A".repeat(43)}\n`,
    );
    const output: string[] = [];
    const ok = await runCli(["doctor"], {
      cwd,
      stdout: (line) => output.push(line),
      runCommand: localDoctorRunner(),
    });
    expect(ok).toBe(0);
    expect(output.join("\n")).toContain("Local AUTH_SECRET format is valid");

    await writeFile(join(cwd, ".dev.vars"), "AUTH_SECRET=bad-secret\n");
    const errors: string[] = [];
    const invalid = await runCli(["doctor"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: localDoctorRunner(),
    });
    expect(invalid).toBe(1);
    expect(errors.join("\n")).toContain(
      "Local AUTH_SECRET or AUTH_SECRET_PREVIOUS is invalid",
    );
    expect(errors.join("\n")).not.toContain("bad-secret");
  });

  it("doctor reports unavailable Wrangler before deployment checks", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: () => ({ status: 1, stdout: "", stderr: "not found" }),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Wrangler is unavailable");
    expect(errors.join("\n")).toContain("install wrangler 4.110.0");
  });

  it("doctor reports missing Workers compatibility settings", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(text) as {
      compatibility_date?: string;
      compatibility_flags?: string[];
    };
    delete config.compatibility_date;
    delete config.compatibility_flags;
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    const missingErrors: string[] = [];

    const missingCode = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => missingErrors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(missingCode).toBe(1);
    expect(missingErrors.join("\n")).toContain(
      "Workers compatibility_date is missing",
    );
    expect(missingErrors.join("\n")).toContain(
      "Workers nodejs_compat compatibility flag is missing",
    );

    config.compatibility_date = "2024-09-22";
    config.compatibility_flags = ["nodejs_compat"];
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    const floorErrors: string[] = [];
    const floorCode = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => floorErrors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(floorCode).toBe(1);
    expect(floorErrors.join("\n")).toContain(
      "Workers compatibility_date 2024-09-22 is below required floor 2024-09-23",
    );
  });

  it("doctor reports failed Cloudflare login without leaking Wrangler output", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: (_command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "4.90.1\n", stderr: "" };
        }
        if (args[0] === "whoami") {
          return {
            status: 1,
            stdout: "",
            stderr: "not logged in as person@example.com",
          };
        }
        if (args[0] === "d1" && args[1] === "execute") {
          return { status: 0, stdout: migrationStateJson(), stderr: "" };
        }
        return {
          status: 0,
          stdout: JSON.stringify([{ name: "AUTH_SECRET" }]),
          stderr: "",
        };
      },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Cloudflare login could not be verified",
    );
    expect(errors.join("\n")).not.toContain("person@example.com");
  });

  it("doctor reports unavailable configured Cloudflare accounts", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(text) as { account_id?: string };
    config.account_id = "missing-account";
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Wrangler account_id is not available to the authenticated user",
    );
  });

  it("doctor validates environment-specific Cloudflare account selections", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(text) as {
      account_id?: string;
      env: { production: { account_id?: string } };
    };
    config.account_id = "acct_prod";
    config.env.production.account_id = "missing-account";
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    const errors: string[] = [];

    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: remoteSecretRunner([{ id: "acct_prod" }]),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Wrangler account_id is not available to the authenticated user",
    );
  });

  it("doctor warns when production account selection is implicit", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const output: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stdout: (line) => output.push(line),
      runCommand: remoteSecretRunner([
        { id: "acct_prod" },
        { id: "acct_other" },
      ]),
    });

    expect(code).toBe(0);
    expect(output.join("\n")).toContain(
      "Multiple Cloudflare accounts available; selection is implicit",
    );
  });

  it("doctor reports missing production email binding", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(text) as {
      env: { production: { send_email?: unknown } };
    };
    delete config.env.production.send_email;
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: remoteSecretRunner(),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Cloudflare Email binding AUTH_EMAIL is missing",
    );
  });

  it("doctor rejects development AUTH_ENV in named remote targets", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const wranglerPath = join(cwd, "wrangler.jsonc");
    const config = JSON.parse(await readFile(wranglerPath, "utf8")) as {
      env: { production: { vars: Record<string, string> } };
    };
    config.env.production.vars.AUTH_ENV = "development";
    config.env.production.vars.AUTH_PUBLIC_ORIGIN = "http://localhost:8787";
    await writeFile(wranglerPath, JSON.stringify(config));
    const errors: string[] = [];

    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Remote targets must not use AUTH_ENV=development",
    );
  });

  it("doctor rejects remote D1 bindings without database ids", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(text) as {
      env: {
        production: {
          d1_databases: Array<{ binding: string; database_id?: string }>;
        };
      };
    };
    delete config.env.production.d1_databases[0]?.database_id;
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    const errors: string[] = [];

    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "D1 database_id is missing for remote target",
    );
  });

  it("doctor rejects non-HTTPS production public origins for cookies", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(text) as {
      env: { production: { vars: Record<string, string> } };
    };
    config.env.production.vars.AUTH_PUBLIC_ORIGIN = "http://example.com";
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Preview and production public origins must use HTTPS",
    );
  });

  it("doctor requires exact preview and production public origins", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(text) as {
      vars: Record<string, string>;
      env?: { production: { vars: Record<string, string> } };
    };
    config.vars.AUTH_ENV = "preview";
    delete config.vars.AUTH_PUBLIC_ORIGIN;
    delete config.env;
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));

    const missingOriginErrors: string[] = [];
    const missingOriginCode = await runCli(["doctor"], {
      cwd,
      stderr: (line) => missingOriginErrors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(missingOriginCode).toBe(1);
    expect(missingOriginErrors.join("\n")).toContain(
      "Preview public origin is missing",
    );

    config.vars.AUTH_PUBLIC_ORIGIN = "https://preview.example.com/auth";
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    const exactOriginErrors: string[] = [];
    const exactOriginCode = await runCli(["doctor"], {
      cwd,
      stderr: (line) => exactOriginErrors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(exactOriginCode).toBe(1);
    expect(exactOriginErrors.join("\n")).toContain(
      "AUTH_PUBLIC_ORIGIN must be an exact origin",
    );
  });

  it("doctor detects production source config hazards", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await writeAuthSource(
      cwd,
      `import { defineAuthConfig, terminalEmail } from "@cf-auth/worker";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  email: terminalEmail({ outbox: true }),
  request: {
    requireOriginOnUnsafeMethods: false
  },
  security: {
    allowedRequestOrigins: ["https://app.example.com/path"]
  },
  redirects: {
    allowedOrigins: ["https://example.com/path"]
  }
});
`,
    );
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Terminal email/dev outbox is configured for a remote target",
    );
    expect(errors.join("\n")).toContain(
      "Redirect allowedOrigins contains an invalid exact origin",
    );
    expect(errors.join("\n")).toContain(
      "Request allowedRequestOrigins contains an invalid exact origin",
    );
    expect(errors.join("\n")).toContain(
      "Unsafe auth-route methods do not require Origin",
    );
  });

  it("doctor detects invalid session cookie source config", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await writeAuthSource(
      cwd,
      `import { defineAuthConfig } from "@cf-auth/worker";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  email: cloudflareEmail({ from: "no-reply@example.com" }),
  session: {
    cookieName: "__Host-cfauth-session",
    domain: ".example.com"
  }
});
`,
    );
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Session cookie source config is invalid",
    );
  });

  it("doctor checks session cookie source config against local HTTP", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await writeFile(
      join(cwd, ".dev.vars"),
      `AUTH_SECRET=k_dev.${"A".repeat(43)}\n`,
    );
    await writeAuthSource(
      cwd,
      `import { defineAuthConfig } from "@cf-auth/worker";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  session: {
    cookieName: "__Secure-cfauth-session"
  }
});
`,
    );
    const errors: string[] = [];
    const code = await runCli(["doctor"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: localDoctorRunner(),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Session cookie source config is invalid for this environment",
    );
  });

  it("doctor rejects session cookie domains outside the public origin host", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(text) as {
      env: { production: { vars: Record<string, string> } };
    };
    config.env.production.vars.AUTH_PUBLIC_ORIGIN = "https://app.other.com";
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    await writeAuthSource(
      cwd,
      `import { defineAuthConfig } from "@cf-auth/worker";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  email: cloudflareEmail({ from: "no-reply@example.com" }),
  session: {
    domain: ".example.com"
  }
});
`,
    );
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Session cookie source config is invalid for this environment",
    );
  });

  it("doctor warns when request body source limits exceed 64 KiB", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await writeAuthSource(
      cwd,
      `import { defineAuthConfig } from "@cf-auth/worker";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  email: cloudflareEmail({ from: "no-reply@example.com" }),
  request: {
    maxBodyBytes: 128 * 1024
  }
});
`,
    );
    const output: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stdout: (line) => output.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(0);
    expect(output.join("\n")).toContain("Request maxBodyBytes exceeds 64 KiB");
  });

  it("doctor warns when the configured hash queue timeout is too low", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await writeAuthSource(
      cwd,
      `import { defineAuthConfig } from "@cf-auth/worker";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  email: cloudflareEmail({ from: "no-reply@example.com" }),
  passwordHashing: {
    profile: "workers-balanced",
    maxConcurrentHashesPerIsolate: 1,
    queueTimeoutMs: 1
  }
});
`,
    );
    const output: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stdout: (line) => output.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(0);
    expect(output.join("\n")).toContain(
      "Password hashing queue estimate is 116ms",
    );
    expect(output.join("\n")).toContain("timeout=1ms");
  });

  it("doctor reports Cloudflare Auth package version problems", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          type: "module",
          dependencies: {
            "@cf-auth/worker": "1.0.0",
            "@cf-auth/hono": "1.0.1",
          },
        },
        null,
        2,
      ),
    );
    const output: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => output.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(1);
    expect(output.join("\n")).toContain(
      "Cloudflare Auth package versions are inconsistent",
    );

    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          type: "module",
          dependencies: {
            "@cf-auth/worker": "workspace:*",
            "@cf-auth/hono": "workspace:*",
          },
        },
        null,
        2,
      ),
    );
    const workspaceOutput: string[] = [];
    const workspaceCode = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => workspaceOutput.push(line),
      runCommand: remoteSecretRunner(),
    });
    expect(workspaceCode).toBe(1);
    expect(workspaceOutput.join("\n")).toContain(
      "Cloudflare Auth dependencies use workspace protocol",
    );

    await writeFile(join(cwd, "package.json"), "null\n");
    const scalarOutput: string[] = [];
    const scalarCode = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => scalarOutput.push(line),
      runCommand: remoteSecretRunner(),
    });
    expect(scalarCode).toBe(1);
    expect(scalarOutput.join("\n")).toContain(
      "package.json is not a JSON object",
    );

    await writeFile(join(cwd, "package.json"), "not json\n");
    const invalidJsonOutput: string[] = [];
    const invalidJsonCode = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => invalidJsonOutput.push(line),
      runCommand: remoteSecretRunner(),
    });
    expect(invalidJsonCode).toBe(1);
    expect(invalidJsonOutput.join("\n")).toContain(
      "package.json could not be parsed",
    );

    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@cf-auth/worker": true,
          },
        },
        null,
        2,
      ),
    );
    const invalidDependencyOutput: string[] = [];
    const invalidDependencyCode = await runCli(
      ["doctor", "--env", "production"],
      {
        cwd,
        stderr: (line) => invalidDependencyOutput.push(line),
        runCommand: remoteSecretRunner(),
      },
    );
    expect(invalidDependencyCode).toBe(1);
    expect(invalidDependencyOutput.join("\n")).toContain(
      "package.json dependencies.@cf-auth/worker must be a string version",
    );

    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          optionalDependencies: {
            "@cf-auth/worker": "workspace:*",
          },
        },
        null,
        2,
      ),
    );
    const optionalOutput: string[] = [];
    const optionalCode = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => optionalOutput.push(line),
      runCommand: remoteSecretRunner(),
    });
    expect(optionalCode).toBe(1);
    expect(optionalOutput.join("\n")).toContain(
      "Cloudflare Auth dependencies use workspace protocol",
    );

    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@cf-auth/worker": "1.0.0",
          },
          pnpm: {
            overrides: {
              "@cf-auth/worker": "workspace:*",
            },
          },
        },
        null,
        2,
      ),
    );
    const overrideOutput: string[] = [];
    const overrideCode = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => overrideOutput.push(line),
      runCommand: remoteSecretRunner(),
    });
    expect(overrideCode).toBe(1);
    expect(overrideOutput.join("\n")).toContain(
      "Cloudflare Auth dependencies use workspace protocol",
    );

    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@cf-auth/hono": "file:/tmp/cf-auth-hono.tgz",
            "@cf-auth/worker": "file:/tmp/cf-auth-worker.tgz",
          },
        },
        null,
        2,
      ),
    );
    const fileOutput: string[] = [];
    const fileCode = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => fileOutput.push(line),
      runCommand: remoteSecretRunner(),
    });
    expect(fileCode).toBe(1);
    expect(fileOutput.join("\n")).toContain(
      "Cloudflare Auth dependencies use local file specs",
    );

    const previousAllowLocalPackages =
      process.env.CF_AUTH_ALLOW_LOCAL_PACKAGE_SPECS;
    process.env.CF_AUTH_ALLOW_LOCAL_PACKAGE_SPECS = "1";
    try {
      const tarballOutput: string[] = [];
      const tarballCode = await runCli(["doctor", "--env", "production"], {
        cwd,
        stdout: (line) => tarballOutput.push(line),
        runCommand: remoteSecretRunner(),
      });
      expect(tarballCode).toBe(0);
      expect(tarballOutput.join("\n")).toContain(
        "Cloudflare Auth package versions use local tarball specs",
      );
    } finally {
      if (previousAllowLocalPackages === undefined) {
        delete process.env.CF_AUTH_ALLOW_LOCAL_PACKAGE_SPECS;
      } else {
        process.env.CF_AUTH_ALLOW_LOCAL_PACKAGE_SPECS =
          previousAllowLocalPackages;
      }
    }
  });

  it("doctor reports unreadable production package manifests", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await mkdir(join(cwd, "package.json"));
    const output: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => output.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(1);
    expect(output.join("\n")).toContain("package.json could not be read");
  });

  it("doctor accepts byEnvironment terminal email for development only", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await writeAuthSource(
      cwd,
      `import { byEnvironment, defineAuthConfig, terminalEmail } from "@cf-auth/worker";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  email: byEnvironment({
    development: terminalEmail({ outbox: true }),
    preview: cloudflareEmail({ binding: "AUTH_EMAIL", from: "auth@example.com" }),
    production: cloudflareEmail({ binding: "AUTH_EMAIL", from: "auth@example.com" })
  })
});
`,
    );
    const output: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stdout: (line) => output.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(0);
    expect(output.join("\n")).toContain(
      "Production email adapter source does not use terminal email",
    );
    expect(output.join("\n")).toContain(
      "Password hashing benchmark local-estimate workers-balanced",
    );
  });

  it("doctor scopes byEnvironment email checks to the selected target", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const wrangler = JSON.parse(
      await readFile(join(cwd, "wrangler.jsonc"), "utf8"),
    ) as {
      env: Record<string, unknown>;
    };
    wrangler.env.preview = {
      vars: {
        AUTH_ENV: "preview",
        AUTH_PUBLIC_ORIGIN: "https://preview.example.com",
      },
      d1_databases: [
        {
          binding: "AUTH_DB",
          database_name: "app-auth-preview",
          database_id: "preview-id",
        },
      ],
    };
    await writeFile(
      join(cwd, "wrangler.jsonc"),
      JSON.stringify(wrangler, null, 2),
    );
    await writeAuthSource(
      cwd,
      `import { byEnvironment, defineAuthConfig, terminalEmail } from "@cf-auth/worker";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  email: byEnvironment({
    development: terminalEmail({ outbox: true }),
    preview: terminalEmail({ outbox: true }),
    production: cloudflareEmail({ binding: "AUTH_EMAIL", from: "auth@example.com" })
  })
});
`,
    );
    const productionOutput: string[] = [];
    const productionCode = await runCli(["doctor", "--env", "production"], {
      cwd,
      stdout: (line) => productionOutput.push(line),
      runCommand: remoteSecretRunner(),
    });
    expect(productionCode).toBe(0);
    expect(productionOutput.join("\n")).toContain(
      "Production email adapter source does not use terminal email",
    );

    const previewErrors: string[] = [];
    const previewCode = await runCli(["doctor", "--env", "preview"], {
      cwd,
      stderr: (line) => previewErrors.push(line),
      runCommand: remoteSecretRunner(),
    });
    expect(previewCode).toBe(1);
    expect(previewErrors.join("\n")).toContain(
      "Terminal email/dev outbox is configured for a remote target",
    );
  });

  it("doctor does not require AUTH_EMAIL for custom production email adapters", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(text) as {
      env: { production: { send_email?: unknown } };
    };
    delete config.env.production.send_email;
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    await writeAuthSource(
      cwd,
      `import { byEnvironment, defineAuthConfig, terminalEmail } from "@cf-auth/worker";

const customEmail = {
  kind: "custom",
  async sendMagicLink() {},
  async sendEmailVerification() {},
  async sendPasswordReset() {}
};

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  email: byEnvironment({
    development: terminalEmail({ outbox: true }),
    preview: customEmail,
    production: customEmail
  })
});
`,
    );
    const output: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stdout: (line) => output.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(0);
    expect(output.join("\n")).toContain(
      "Cloudflare Email binding not required by inspected auth config",
    );
  });

  it("doctor reports required Turnstile secrets", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await writeAuthSource(
      cwd,
      `import { defineAuthConfig } from "@cf-auth/worker";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  email: cloudflareEmail({ from: "no-reply@example.com" }),
  turnstile: {
    mode: "required",
    endpoints: ["signup"]
  }
});
`,
    );
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "TURNSTILE_SECRET_KEY is missing remotely",
    );
  });

  it("doctor detects double-prefixed auth routes", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await writeAuthSource(
      cwd,
      `import { defineAuthConfig } from "@cf-auth/worker";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  email: cloudflareEmail({ from: "no-reply@example.com" })
});
`,
      `import { Hono } from "hono";
import { createAuthRoutes } from "@cf-auth/hono";
import authConfig from "./auth.config.js";

const app = new Hono();
app.route("/auth/auth", createAuthRoutes(authConfig));
export default app;
`,
    );
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: remoteSecretRunner(),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Auth route appears to include /auth/auth",
    );
  });

  it("emits redaction-safe doctor report JSON matching the checked-in schema id", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const schema = JSON.parse(
      await readFile("schemas/doctor-report.schema.json", "utf8"),
    ) as JsonSchema;
    const output: string[] = [];
    const code = await runCli(["doctor", "--report", "--env", "production"], {
      cwd,
      stdout: (line) => output.push(line),
      runCommand: remoteSecretRunner(),
    });
    const report = JSON.parse(output.join("\n")) as Record<string, unknown>;
    expect(code).toBe(0);
    expect(report.$schema).toBe(schema.$id);
    expect(validateJsonSchema(report, schema)).toEqual([]);
    expect(report).toMatchObject({
      schemaVersion: 1,
      ok: true,
      environment: "production",
      redaction: {
        rawSecrets: "omitted",
        rawTokens: "omitted",
        rawCookies: "omitted",
        rawEmails: "omitted",
        rawIps: "omitted",
        rawUserAgents: "omitted",
      },
    });
    expect(JSON.stringify(report)).not.toMatch(
      /AUTH_SECRET=|cfauth\.|person@example\.com|203\.0\.113\./,
    );
  });

  it("redacts sensitive environment names in doctor report JSON", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const output: string[] = [];
    const code = await runCli(
      ["doctor", "--report", "--env", "person@example.com"],
      {
        cwd,
        stdout: (line) => output.push(line),
        runCommand: remoteSecretRunner(),
      },
    );
    const report = JSON.parse(output.join("\n")) as {
      environment: string;
      checks: Array<{ message: string; fix?: string }>;
    };
    const reportText = JSON.stringify(report);

    expect(code).toBe(1);
    expect(report.environment).toBe("[REDACTED_EMAIL]");
    expect(reportText).toContain("add [REDACTED_EMAIL] to wrangler.jsonc");
    expect(reportText).not.toContain("person@example.com");
  });

  it("logs wrapped Wrangler commands in verbose mode without contaminating reports", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const output: string[] = [];
    const errors: string[] = [];

    const code = await runCli(
      ["doctor", "--report", "--env", "production", "--verbose"],
      {
        cwd,
        stdout: (line) => output.push(line),
        stderr: (line) => errors.push(line),
        runCommand: remoteSecretRunner(),
      },
    );

    expect(code).toBe(0);
    expect(() => JSON.parse(output.join("\n"))).not.toThrow();
    expect(output.join("\n")).not.toContain("$ wrangler");
    expect(errors.join("\n")).toContain("$ wrangler --version");
    expect(errors.join("\n")).toContain("$ wrangler whoami --json");
    expect(errors.join("\n")).toContain(
      "wrangler d1 execute app-auth --remote --env production --json --command <redacted SQL>",
    );
    expect(errors.join("\n")).not.toContain(migrationStateSql());
  });

  it("writes doctor report JSON to an output file", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const output: string[] = [];
    const code = await runCli(
      ["doctor", "--report", "--env", "production", "--output", "report.json"],
      {
        cwd,
        stdout: (line) => output.push(line),
        runCommand: remoteSecretRunner(),
      },
    );

    expect(code).toBe(0);
    expect(output.join("\n")).toContain("Wrote doctor report");
    const report = JSON.parse(
      await readFile(join(cwd, "report.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(report).toMatchObject({
      schemaVersion: 1,
      ok: true,
      environment: "production",
    });
  });

  it("prints deploy dry-run and safe recovery helper output", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const deploy: string[] = [];
    await runCli(["deploy", "--dry-run", "--env", "production"], {
      cwd,
      stdout: (line) => deploy.push(line),
      runCommand: remoteSecretRunner(),
    });
    expect(deploy.join("\n")).toContain("doctor --env production: ok");
    expect(deploy.join("\n")).toContain(
      "wrangler d1 migrations list app-auth --remote --env production",
    );
    expect(deploy.join("\n")).toContain("wrangler deploy --env production");

    const migrateDeploy: string[] = [];
    await runCli(["deploy", "--dry-run", "--migrate", "--env", "production"], {
      cwd,
      stdout: (line) => migrateDeploy.push(line),
      runCommand: remoteSecretRunner(),
    });
    expect(migrateDeploy.join("\n")).toContain(
      "wrangler d1 migrations list app-auth --remote --env production",
    );
    expect(migrateDeploy.join("\n")).toContain(
      "wrangler d1 migrations apply app-auth --remote --env production",
    );
    expect(migrateDeploy.join("\n")).toContain(
      `wrangler d1 execute app-auth --remote --env production --yes --json --command ${migrationStateSql()}`,
    );
    expect(migrateDeploy.join("\n")).toContain(
      "wrangler deploy --env production",
    );

    const ambiguous: string[] = [];
    const deployCode = await runCli(["deploy", "--dry-run"], {
      cwd,
      stderr: (line) => ambiguous.push(line),
    });
    expect(deployCode).toBe(1);
    expect(ambiguous.join("\n")).toContain("Deploy requires --env");

    const recovery: string[] = [];
    await runCli(
      ["users", "disable", "person@example.com", "--local", "--dry-run"],
      {
        cwd,
        stdout: (line) => recovery.push(line),
      },
    );
    expect(recovery.join("\n")).toContain("Dry run only");
    expect(recovery.join("\n")).not.toMatch(/cfauth\.|cookie=.*cfauth/i);
  });

  it("executes recovery helpers through redaction-safe D1 SQL", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const userCalls: Array<{ args: string[]; sql: string }> = [];
    const userOutput: string[] = [];
    const tokenHash = `hmac-sha256$v=1$kid=k1$purpose=session$hash=${"B".repeat(43)}`;
    const passwordHash = `scrypt$v=1$n=16384$r=8$p=1$keylen=32$maxmem=67108864$salt=${"C".repeat(22)}$hash=${"D".repeat(43)}`;
    const colonToken = `cfauth.magic.k1.${"E".repeat(43)}`;
    const secretMaterial = "F".repeat(43);
    const disableCode = await runCli(
      ["users", "disable", "person@example.com", "--local"],
      {
        cwd,
        stdout: (line) => userOutput.push(line),
        runCommand: (_command, args) => {
          userCalls.push({ args, sql: args.at(-1) ?? "" });
          return {
            status: 0,
            stdout: `disabled token=cfauth.magic.k1.${"A".repeat(43)} identifier=raw-identifier username=raw-user token_hash=${tokenHash} passwordHash=${passwordHash} user_agent="Mozilla/5.0 Secret Browser" leaked ${tokenHash} ${passwordHash} person@example.com 2001:db8::1 __Host-cfauth-session=raw-cookie; token: ${colonToken} identifier: colon-identifier username: colon-user password: correct horse battery staple User-Agent: Mozilla/5.0 Colon Browser CF-Connecting-IP: [2001:db8::1] AUTH_SECRET:k1.${secretMaterial}`,
            stderr: "",
          };
        },
      },
    );

    expect(disableCode).toBe(0);
    expect(userCalls).toHaveLength(1);
    expect(userCalls[0]?.args.slice(0, -1)).toEqual([
      "d1",
      "execute",
      "app-auth-dev",
      "--local",
      "--yes",
      "--command",
    ]);
    expect(userCalls[0]?.sql).toContain(
      "normalized_email = 'person@example.com'",
    );
    expect(userCalls[0]?.sql).toContain("UPDATE sessions SET revoked_at");
    expect(userOutput.join("\n")).not.toContain("person@example.com");
    expect(userOutput.join("\n")).not.toContain("2001:db8::1");
    expect(userOutput.join("\n")).not.toContain("raw-cookie");
    expect(userOutput.join("\n")).not.toContain("cfauth.magic");
    expect(userOutput.join("\n")).not.toContain("raw-identifier");
    expect(userOutput.join("\n")).not.toContain("raw-user");
    expect(userOutput.join("\n")).not.toContain(colonToken);
    expect(userOutput.join("\n")).not.toContain("colon-identifier");
    expect(userOutput.join("\n")).not.toContain("colon-user");
    expect(userOutput.join("\n")).not.toContain("correct horse battery staple");
    expect(userOutput.join("\n")).not.toContain(secretMaterial);
    expect(userOutput.join("\n")).not.toContain(tokenHash);
    expect(userOutput.join("\n")).not.toContain(passwordHash);
    expect(userOutput.join("\n")).not.toContain("hmac-sha256");
    expect(userOutput.join("\n")).not.toContain("scrypt$v=1");
    expect(userOutput.join("\n")).not.toContain("Secret Browser");
    expect(userOutput.join("\n")).not.toContain("Colon Browser");
    expect(userOutput.join("\n")).toContain("identifier=[REDACTED]");
    expect(userOutput.join("\n")).toContain("username=[REDACTED]");
    expect(userOutput.join("\n")).toContain("identifier: [REDACTED]");
    expect(userOutput.join("\n")).toContain("username: [REDACTED]");
    expect(userOutput.join("\n")).toContain("password: [REDACTED]");
    expect(userOutput.join("\n")).toContain("User-Agent: [REDACTED]");
    expect(userOutput.join("\n")).toContain("AUTH_SECRET:[REDACTED]");
    expect(userOutput.join("\n")).toContain("[REDACTED_EMAIL]");
    expect(userOutput.join("\n")).toContain("[REDACTED_IP]");
    expect(userOutput.join("\n")).toContain("user_agent=[REDACTED]");

    const sessionCalls: Array<{ args: string[]; sql: string }> = [];
    const output: string[] = [];
    const listCode = await runCli(
      [
        "sessions",
        "list",
        "--user",
        "usr_safe",
        "--remote",
        "--env",
        "production",
      ],
      {
        cwd,
        stdout: (line) => output.push(line),
        runCommand: (_command, args) => {
          sessionCalls.push({ args, sql: args.at(-1) ?? "" });
          return {
            status: 0,
            stdout: JSON.stringify([
              {
                results: [
                  {
                    id: "ses_one",
                    created_at: 10,
                    expires_at: 20,
                    revoked_at: null,
                    last_seen_at: 15,
                  },
                ],
              },
            ]),
            stderr: "",
          };
        },
      },
    );

    expect(listCode).toBe(0);
    expect(sessionCalls[0]?.args.slice(0, -1)).toEqual([
      "d1",
      "execute",
      "app-auth",
      "--remote",
      "--env",
      "production",
      "--yes",
      "--json",
      "--command",
    ]);
    expect(sessionCalls[0]?.sql).toContain("SELECT id, created_at");
    expect(sessionCalls[0]?.sql).not.toContain("token_hash");
    expect(sessionCalls[0]?.sql).not.toContain("ip_hash");
    expect(output.join("\n")).toContain("id=ses_one");
    expect(output.join("\n")).not.toContain("token_hash");
  });

  it("escapes recovery helper identifiers before embedding them in D1 SQL", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const calls: Array<{ args: string[]; sql: string }> = [];

    const disableCode = await runCli(
      ["users", "disable", "O'Hara@example.com", "--local"],
      {
        cwd,
        runCommand: (_command, args) => {
          calls.push({ args, sql: args.at(-1) ?? "" });
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );
    const revokeCode = await runCli(
      ["sessions", "revoke", "--user", "usr_' OR 1=1 --", "--local"],
      {
        cwd,
        runCommand: (_command, args) => {
          calls.push({ args, sql: args.at(-1) ?? "" });
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(disableCode).toBe(0);
    expect(revokeCode).toBe(0);
    expect(calls[0]?.sql).toContain("normalized_email = 'o''hara@example.com'");
    expect(calls[1]?.sql).toContain("id = 'usr_'' OR 1=1 --'");
    expect(calls[1]?.sql).not.toContain("id = 'usr_' OR 1=1 --'");
  });

  it("rejects malformed D1 JSON for session recovery lists", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const invalidErrors: string[] = [];
    const invalidCode = await runCli(
      [
        "sessions",
        "list",
        "--user",
        "usr_safe",
        "--remote",
        "--env",
        "production",
      ],
      {
        cwd,
        stderr: (line) => invalidErrors.push(line),
        runCommand: () => ({ status: 0, stdout: "not json", stderr: "" }),
      },
    );

    expect(invalidCode).toBe(1);
    expect(invalidErrors.join("\n")).toContain(
      "D1 JSON response could not be parsed",
    );

    const shapeErrors: string[] = [];
    const shapeCode = await runCli(
      [
        "sessions",
        "list",
        "--user",
        "usr_safe",
        "--remote",
        "--env",
        "production",
      ],
      {
        cwd,
        stderr: (line) => shapeErrors.push(line),
        runCommand: () => ({
          status: 0,
          stdout: JSON.stringify([{ results: "not rows" }]),
          stderr: "",
        }),
      },
    );

    expect(shapeCode).toBe(1);
    expect(shapeErrors.join("\n")).toContain(
      "D1 JSON response had unexpected shape",
    );
  });

  it("rejects remote recovery without an explicit named environment", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const errors: string[] = [];
    const code = await runCli(
      ["sessions", "revoke", "--user", "usr_safe", "--remote"],
      {
        cwd,
        stderr: (line) => errors.push(line),
      },
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Remote recovery requires --env");
  });

  it("rejects remote recovery from top-level development configs", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(text) as { env?: unknown };
    delete config.env;
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    const errors: string[] = [];

    const code = await runCli(
      ["sessions", "revoke", "--user", "usr_safe", "--remote"],
      {
        cwd,
        stderr: (line) => errors.push(line),
      },
    );

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Remote recovery without --env requires top-level vars.AUTH_ENV=production",
    );
  });

  it("runs clean through Wrangler and keeps dry-runs redacted", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const dryRun: string[] = [];
    const dryRunCode = await runCli(
      ["clean", "--dry-run", "--remote", "--env", "production"],
      {
        cwd,
        stdout: (line) => dryRun.push(line),
      },
    );
    expect(dryRunCode).toBe(0);
    expect(dryRun.join("\n")).toContain(
      "wrangler d1 execute app-auth --remote --env production --command <redacted cleanup SQL>",
    );
    expect(dryRun.join("\n")).not.toContain("DELETE FROM");

    const calls: Array<{ args: string[]; sql: string }> = [];
    const cleanOutput: string[] = [];
    const verboseErrors: string[] = [];
    const cleanCode = await runCli(["clean", "--local"], {
      cwd,
      stdout: (line) => cleanOutput.push(line),
      runCommand: (_command, args) => {
        calls.push({
          args,
          sql: args.at(-1) ?? "",
        });
        return { status: 0, stdout: "cleaned", stderr: "" };
      },
    });
    expect(cleanCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(0, -1)).toEqual([
      "d1",
      "execute",
      "app-auth-dev",
      "--local",
      "--yes",
      "--command",
    ]);
    expect(calls[0]?.sql).toContain("DELETE FROM sessions");
    expect(calls[0]?.sql).toContain("DELETE FROM verification_tokens");
    expect(calls[0]?.sql).toContain("DELETE FROM rate_limits");
    expect(calls[0]?.sql).toContain("DELETE FROM auth_events");
    expect(cleanOutput.join("\n")).toContain(
      "wrangler d1 execute app-auth-dev --local --command <redacted cleanup SQL>",
    );
    expect(cleanOutput.join("\n")).not.toContain("DELETE FROM");

    const verboseCode = await runCli(["clean", "--local", "--verbose"], {
      cwd,
      stderr: (line) => verboseErrors.push(line),
      runCommand: () => ({ status: 0, stdout: "cleaned", stderr: "" }),
    });
    expect(verboseCode).toBe(0);
    expect(verboseErrors.join("\n")).toContain(
      "wrangler d1 execute app-auth-dev --local --yes --command <redacted SQL>",
    );
    expect(verboseErrors.join("\n")).not.toContain("DELETE FROM");
  });

  it("rejects remote clean without an explicit named environment", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const errors: string[] = [];
    const code = await runCli(["clean", "--remote"], {
      cwd,
      stderr: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("Remote cleanup requires --env");
  });

  it("rejects named remote cleanup without explicit remote AUTH_ENV", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const wranglerPath = join(cwd, "wrangler.jsonc");
    const config = JSON.parse(await readFile(wranglerPath, "utf8")) as {
      env: { production: { vars: Record<string, string> } };
    };
    delete config.env.production.vars.AUTH_ENV;
    await writeFile(wranglerPath, JSON.stringify(config, null, 2));

    const errors: string[] = [];
    const calls: string[] = [];
    const code = await runCli(["clean", "--remote", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: (command, args) => {
        calls.push([command, ...args].join(" "));
        return { status: 0, stdout: "cleaned\n", stderr: "" };
      },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Remote cleanup must target vars.AUTH_ENV=preview or production",
    );
    expect(calls).toEqual([]);
  });

  it("rejects remote cleanup from top-level development configs", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const text = await readFile(join(cwd, "wrangler.jsonc"), "utf8");
    const config = JSON.parse(text) as { env?: unknown };
    delete config.env;
    await writeFile(join(cwd, "wrangler.jsonc"), JSON.stringify(config));
    const errors: string[] = [];

    const code = await runCli(["clean", "--remote"], {
      cwd,
      stderr: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Remote cleanup without --env requires top-level vars.AUTH_ENV=production",
    );
  });

  it("doctor reports missing remote production secrets", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: (_command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "4.90.1\n", stderr: "" };
        }
        if (args[0] === "whoami") {
          return { status: 0, stdout: healthyWhoamiJson(), stderr: "" };
        }
        if (args[0] === "d1" && args[1] === "execute") {
          return { status: 0, stdout: migrationStateJson(), stderr: "" };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("AUTH_SECRET is missing remotely");
    expect(errors.join("\n")).toContain(
      "npx --package @cf-auth/cli@latest cf-auth rotate-secret --apply --env production",
    );
    expect(errors.join("\n")).not.toContain("k_dev.");
  });

  it("doctor reports invalid remote secret list output as unavailable", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: (_command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "4.90.1\n", stderr: "" };
        }
        if (args[0] === "whoami") {
          return { status: 0, stdout: healthyWhoamiJson(), stderr: "" };
        }
        if (args[0] === "d1" && args[1] === "execute") {
          return { status: 0, stdout: migrationStateJson(), stderr: "" };
        }
        return { status: 0, stdout: "not json", stderr: "" };
      },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Remote AUTH_SECRET could not be verified",
    );
    expect(errors.join("\n")).toContain("run wrangler login");
    expect(errors.join("\n")).not.toContain("AUTH_SECRET is missing remotely");
  });

  it("doctor detects secrets that exist only in local dev vars", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await writeFile(
      join(cwd, ".dev.vars"),
      `AUTH_SECRET=k_dev.${"A".repeat(43)}\nAUTH_SECRET_PREVIOUS=k_old.${"B".repeat(43)}\n`,
    );
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: (_command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "4.90.1\n", stderr: "" };
        }
        if (args[0] === "whoami") {
          return { status: 0, stdout: healthyWhoamiJson(), stderr: "" };
        }
        if (args[0] === "d1" && args[1] === "execute") {
          return { status: 0, stdout: migrationStateJson(), stderr: "" };
        }
        return { status: 0, stdout: "[]", stderr: "" };
      },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "AUTH_SECRET exists in .dev.vars but is missing remotely",
    );
    expect(errors.join("\n")).toContain(
      "AUTH_SECRET_PREVIOUS exists in .dev.vars but is missing remotely",
    );
    expect(errors.join("\n")).not.toMatch(/k_dev\.|k_old\.|A{20}|B{20}/);
  });

  it("doctor reports unapplied remote D1 migrations", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: (_command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "4.90.1\n", stderr: "" };
        }
        if (args[0] === "whoami") {
          return { status: 0, stdout: healthyWhoamiJson(), stderr: "" };
        }
        if (args[0] === "d1" && args[1] === "execute") {
          return {
            status: 0,
            stdout: migrationStateJson(["0001"], "1"),
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify([{ name: "AUTH_SECRET" }]),
          stderr: "",
        };
      },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "D1 migration 0002 has not been applied remotely",
    );
    expect(errors.join("\n")).toContain(
      "npx --package @cf-auth/cli@latest cf-auth migrate --remote --env production",
    );
  });

  it("doctor rejects malformed remote D1 migration state JSON", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const errors: string[] = [];
    const code = await runCli(["doctor", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: (_command, args) => {
        if (args[0] === "--version") {
          return { status: 0, stdout: "4.90.1\n", stderr: "" };
        }
        if (args[0] === "whoami") {
          return { status: 0, stdout: healthyWhoamiJson(), stderr: "" };
        }
        if (args[0] === "d1" && args[1] === "execute") {
          return {
            status: 0,
            stdout: JSON.stringify([{ results: "not rows" }]),
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify([{ name: "AUTH_SECRET" }]),
          stderr: "",
        };
      },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "D1 migration state response had unexpected shape",
    );
    expect(errors.join("\n")).not.toContain(
      "D1 migration 0001 has not been applied remotely",
    );
  });

  it("executes deploy through Wrangler after doctor and migration status", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const calls: Array<{ command: string; args: string[]; cwd: string }> = [];
    const output: string[] = [];
    const code = await runCli(["deploy", "--env", "production"], {
      cwd,
      stdout: (line) => output.push(line),
      runCommand: (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        if (args[0] === "--version") {
          return { status: 0, stdout: "4.90.1\n", stderr: "" };
        }
        if (args[0] === "whoami") {
          return { status: 0, stdout: healthyWhoamiJson(), stderr: "" };
        }
        if (args[0] === "d1" && args[1] === "execute") {
          return { status: 0, stdout: migrationStateJson(), stderr: "" };
        }
        return {
          status: 0,
          stdout:
            args[0] === "secret"
              ? JSON.stringify([{ name: "AUTH_SECRET" }])
              : `ok ${command} ${args.join(" ")}`,
          stderr: "",
        };
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      {
        command: "wrangler",
        args: ["--version"],
        cwd,
      },
      {
        command: "wrangler",
        args: ["whoami", "--json"],
        cwd,
      },
      {
        command: "wrangler",
        args: [
          "d1",
          "execute",
          "app-auth",
          "--remote",
          "--env",
          "production",
          "--json",
          "--command",
          migrationStateSql(),
        ],
        cwd,
      },
      {
        command: "wrangler",
        args: ["secret", "list", "--format", "json", "--env", "production"],
        cwd,
      },
      {
        command: "wrangler",
        args: [
          "d1",
          "migrations",
          "list",
          "app-auth",
          "--remote",
          "--env",
          "production",
        ],
        cwd,
      },
      {
        command: "wrangler",
        args: ["deploy", "--env", "production"],
        cwd,
      },
    ]);
    expect(output.join("\n")).toContain("doctor --env production: ok");
    expect(output.join("\n")).toContain(
      "deployed with wrangler --env production",
    );
    expect(output.join("\n")).toContain("Auth endpoints:");
    expect(output.join("\n")).toContain("/auth/password/reset/request");
    expect(output.join("\n")).toContain("/auth/email/verify/request");
    expect(output.join("\n")).toContain("Cloudflare Email/DNS");
  });

  it("rejects production deploys when package versions are unsafe", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@cf-auth/hono": "workspace:*",
            "@cf-auth/worker": "workspace:*",
          },
        },
        null,
        2,
      ),
    );
    const calls: string[] = [];
    const errors: string[] = [];
    const code = await runCli(["deploy", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: (command, args) => {
        calls.push([command, ...args].join(" "));
        if (args[0] === "--version") {
          return { status: 0, stdout: "4.90.1\n", stderr: "" };
        }
        if (args[0] === "whoami") {
          return { status: 0, stdout: healthyWhoamiJson(), stderr: "" };
        }
        if (args[0] === "d1" && args[1] === "execute") {
          return { status: 0, stdout: migrationStateJson(), stderr: "" };
        }
        return {
          status: 0,
          stdout:
            args[0] === "secret"
              ? JSON.stringify([{ name: "AUTH_SECRET" }])
              : "",
          stderr: "",
        };
      },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("doctor failed before deploy");
    expect(errors.join("\n")).toContain(
      "Cloudflare Auth dependencies use workspace protocol",
    );
    expect(calls).not.toContain("wrangler deploy --env production");
  });

  it("executes remote migrations before deploy when requested", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const calls: string[] = [];
    const code = await runCli(["deploy", "--migrate", "--env", "production"], {
      cwd,
      runCommand: (command, args) => {
        calls.push([command, ...args].join(" "));
        if (args[0] === "--version") {
          return { status: 0, stdout: "4.90.1\n", stderr: "" };
        }
        if (args[0] === "whoami") {
          return { status: 0, stdout: healthyWhoamiJson(), stderr: "" };
        }
        if (args[0] === "d1" && args[1] === "execute") {
          return { status: 0, stdout: migrationStateJson(), stderr: "" };
        }
        return {
          status: 0,
          stdout:
            args[0] === "secret"
              ? JSON.stringify([{ name: "AUTH_SECRET" }])
              : "",
          stderr: "",
        };
      },
    });

    expect(code).toBe(0);
    expect(calls).toEqual([
      "wrangler --version",
      "wrangler whoami --json",
      `wrangler d1 execute app-auth --remote --env production --json --command ${migrationStateSql()}`,
      "wrangler secret list --format json --env production",
      "wrangler d1 migrations list app-auth --remote --env production",
      "wrangler d1 migrations apply app-auth --remote --env production",
      `wrangler d1 execute app-auth --remote --env production --json --command ${migrationStateSql()}`,
      "wrangler deploy --env production",
    ]);
  });

  it("allows deploy --migrate to apply pending migrations before deploy", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const calls: string[] = [];
    let migrationReads = 0;
    const code = await runCli(["deploy", "--migrate", "--env", "production"], {
      cwd,
      runCommand: (command, args) => {
        calls.push([command, ...args].join(" "));
        if (args[0] === "--version") {
          return { status: 0, stdout: "4.90.1\n", stderr: "" };
        }
        if (args[0] === "whoami") {
          return { status: 0, stdout: healthyWhoamiJson(), stderr: "" };
        }
        if (args[0] === "d1" && args[1] === "execute") {
          migrationReads += 1;
          return {
            status: 0,
            stdout:
              migrationReads === 1
                ? JSON.stringify([{ results: [{ version: "0001" }] }])
                : migrationStateJson(),
            stderr: "",
          };
        }
        return {
          status: 0,
          stdout:
            args[0] === "secret"
              ? JSON.stringify([{ name: "AUTH_SECRET" }])
              : "",
          stderr: "",
        };
      },
    });

    expect(code).toBe(0);
    expect(calls).toContain(
      "wrangler d1 migrations apply app-auth --remote --env production",
    );
    expect(calls.at(-1)).toBe("wrangler deploy --env production");
  });

  it("rejects top-level development deploys without an explicit environment", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, "wrangler.jsonc"),
      JSON.stringify(
        {
          vars: {
            AUTH_ENV: "development",
            AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
          },
          d1_databases: [
            {
              binding: "AUTH_DB",
              database_name: "app-auth-dev",
              database_id: "local-id",
            },
          ],
        },
        null,
        2,
      ),
    );
    const errors: string[] = [];
    const code = await runCli(["deploy", "--dry-run"], {
      cwd,
      stderr: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Deploy without --env requires top-level vars.AUTH_ENV=production",
    );
  });

  it("rejects named deploys that would run with development AUTH_ENV", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const wranglerPath = join(cwd, "wrangler.jsonc");
    const config = JSON.parse(await readFile(wranglerPath, "utf8")) as {
      env: { production: { vars: Record<string, string> } };
    };
    config.env.production.vars.AUTH_ENV = "development";
    config.env.production.vars.AUTH_PUBLIC_ORIGIN = "http://localhost:8787";
    await writeFile(wranglerPath, JSON.stringify(config));
    const calls: string[] = [];
    const errors: string[] = [];

    const code = await runCli(["deploy", "--env", "production"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: (command, args) => {
        calls.push([command, ...args].join(" "));
        return remoteSecretRunner()(command, args);
      },
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Remote targets must not use AUTH_ENV=development",
    );
    expect(calls).not.toContain("wrangler deploy --env production");
  });

  it("applies a new remote auth secret without printing the secret", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const calls: Array<{
      command: string;
      args: string[];
      input: string | undefined;
    }> = [];
    const output: string[] = [];
    const code = await runCli(
      ["rotate-secret", "--apply", "--env", "production"],
      {
        cwd,
        stdout: (line) => output.push(line),
        runCommand: (command, args, options) => {
          calls.push({ command, args, input: options.input });
          return { status: 0, stdout: "", stderr: "" };
        },
      },
    );

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("wrangler");
    expect(calls[0]?.args).toEqual([
      "secret",
      "put",
      "AUTH_SECRET",
      "--env",
      "production",
    ]);
    expect(calls[0]?.input).toMatch(/^k1\.[A-Za-z0-9_-]{43}$/);
    expect(output.join("\n")).toContain("Remote AUTH_SECRET updated.");
    expect(output.join("\n")).not.toContain(calls[0]?.input ?? "");
  });

  it("rejects remote auth secret rotation for top-level development configs", async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, "wrangler.jsonc"),
      JSON.stringify(
        {
          vars: {
            AUTH_ENV: "development",
            AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
          },
          d1_databases: [
            {
              binding: "AUTH_DB",
              database_name: "app-auth-dev",
              database_id: "local-id",
            },
          ],
        },
        null,
        2,
      ),
    );
    const calls: string[] = [];
    const errors: string[] = [];
    const code = await runCli(["rotate-secret", "--apply"], {
      cwd,
      stderr: (line) => errors.push(line),
      runCommand: (command, args) => {
        calls.push([command, ...args].join(" "));
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain(
      "rotate-secret --apply must not target vars.AUTH_ENV=development",
    );
  });

  it("applies previous auth secret from environment before the new remote secret", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const previous = `k_old.${"A".repeat(43)}`;
    process.env.AUTH_SECRET_OLD = previous;
    const calls: Array<{ args: string[]; input: string | undefined }> = [];
    try {
      const code = await runCli(
        [
          "rotate-secret",
          "--apply",
          "--previous-from-env",
          "AUTH_SECRET_OLD",
          "--env",
          "production",
        ],
        {
          cwd,
          runCommand: (_command, args, options) => {
            calls.push({ args, input: options.input });
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(code).toBe(0);
    } finally {
      delete process.env.AUTH_SECRET_OLD;
    }

    expect(calls[0]).toMatchObject({
      args: ["secret", "put", "AUTH_SECRET_PREVIOUS", "--env", "production"],
      input: previous,
    });
    expect(calls[1]?.args).toEqual([
      "secret",
      "put",
      "AUTH_SECRET",
      "--env",
      "production",
    ]);
  });

  it("rejects invalid previous auth secrets before remote writes", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const calls: string[] = [];
    const errors: string[] = [];
    process.env.AUTH_SECRET_OLD = "not-a-secret";
    try {
      const code = await runCli(
        [
          "rotate-secret",
          "--apply",
          "--previous-from-env",
          "AUTH_SECRET_OLD",
          "--env",
          "production",
        ],
        {
          cwd,
          stderr: (line) => errors.push(line),
          runCommand: (command, args) => {
            calls.push([command, ...args].join(" "));
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(code).toBe(1);
    } finally {
      delete process.env.AUTH_SECRET_OLD;
    }

    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain(
      "AUTH_SECRET must be <kid>.<base64url>",
    );
  });

  it("rejects duplicate current and previous auth secret kids", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const calls: string[] = [];
    const errors: string[] = [];
    process.env.AUTH_SECRET_OLD = `k1.${"A".repeat(43)}`;
    try {
      const code = await runCli(
        [
          "rotate-secret",
          "--apply",
          "--previous-from-env",
          "AUTH_SECRET_OLD",
          "--env",
          "production",
        ],
        {
          cwd,
          stderr: (line) => errors.push(line),
          runCommand: (command, args) => {
            calls.push([command, ...args].join(" "));
            return { status: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(code).toBe(1);
    } finally {
      delete process.env.AUTH_SECRET_OLD;
    }

    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("duplicate auth-secret kid: k1");
  });
});

async function tempDir() {
  return mkdtemp(join(tmpdir(), "cf-auth-cli-"));
}

async function writeWrangler(cwd: string) {
  await mkdir(join(cwd, "migrations"), { recursive: true });
  await writeFile(join(cwd, "migrations", "0001_initial.sql"), "-- test\n");
  await writeFile(join(cwd, "migrations", "0002_indexes.sql"), "-- test\n");
  await writeFile(
    join(cwd, "wrangler.jsonc"),
    JSON.stringify(
      {
        compatibility_date: "2026-05-15",
        compatibility_flags: ["nodejs_compat"],
        vars: {
          AUTH_ENV: "development",
          AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
        },
        d1_databases: [
          {
            binding: "AUTH_DB",
            database_name: "app-auth-dev",
            database_id: "local-id",
          },
        ],
        env: {
          production: {
            vars: {
              AUTH_ENV: "production",
              AUTH_PUBLIC_ORIGIN: "https://example.com",
            },
            d1_databases: [
              {
                binding: "AUTH_DB",
                database_name: "app-auth",
                database_id: "prod-id",
              },
            ],
            send_email: [{ name: "AUTH_EMAIL", remote: true }],
          },
        },
      },
      null,
      2,
    ),
  );
}

async function writeAuthSource(
  cwd: string,
  configSource: string,
  indexSource = `import { Hono } from "hono";
import { createAuthRoutes } from "@cf-auth/hono";
import authConfig from "./auth.config.js";

const app = new Hono();
app.route(authConfig.basePath, createAuthRoutes(authConfig));
export default app;
`,
) {
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src", "auth.config.ts"), configSource);
  await writeFile(join(cwd, "src", "index.ts"), indexSource);
}

function remoteSecretRunner(accounts = [{ id: "acct_prod" }]) {
  return (_command: string, args: string[]) => {
    if (args[0] === "--version") {
      return { status: 0, stdout: "4.90.1\n", stderr: "" };
    }
    if (args[0] === "whoami") {
      return { status: 0, stdout: healthyWhoamiJson(accounts), stderr: "" };
    }
    if (args[0] === "d1" && args[1] === "execute") {
      return { status: 0, stdout: migrationStateJson(), stderr: "" };
    }
    return {
      status: 0,
      stdout: JSON.stringify([{ name: "AUTH_SECRET" }]),
      stderr: "",
    };
  };
}

function localDoctorRunner() {
  return (_command: string, args: string[]) => {
    if (args[0] === "--version") {
      return { status: 0, stdout: "4.90.1\n", stderr: "" };
    }
    if (args[0] === "d1" && args[1] === "execute") {
      return { status: 0, stdout: migrationStateJson(), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

function migrationStateSql() {
  return "SELECT version FROM auth_schema_migrations ORDER BY version; SELECT value FROM auth_meta WHERE key = 'schema_version';";
}

function migrationStateJson(versions = ["0001", "0002"], schemaVersion = "2") {
  return JSON.stringify([
    { results: versions.map((version) => ({ version })) },
    { results: [{ value: schemaVersion }] },
  ]);
}

function healthyWhoamiJson(accounts = [{ id: "acct_prod" }]) {
  return JSON.stringify({
    loggedIn: true,
    authType: "OAuth Token",
    email: "person@example.com",
    accounts,
    tokenPermissions: [],
  });
}

interface JsonSchema {
  $id?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  minLength?: number;
  minimum?: number;
  pattern?: string;
  format?: string;
}

function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path = "$",
): string[] {
  const failures: string[] = [];
  if ("const" in schema && value !== schema.const) {
    failures.push(`${path}: expected ${String(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    failures.push(`${path}: expected one of ${schema.enum.join(", ")}`);
  }
  if (schema.type === "object") {
    if (!isRecord(value)) return [`${path}: expected object`];
    for (const key of schema.required ?? []) {
      if (!(key in value)) failures.push(`${path}.${key}: missing`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties))
          failures.push(`${path}.${key}: additional property`);
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        failures.push(
          ...validateJsonSchema(value[key], child, `${path}.${key}`),
        );
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array`];
    if (schema.items) {
      value.forEach((item, index) => {
        failures.push(
          ...validateJsonSchema(item, schema.items!, `${path}[${index}]`),
        );
      });
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") {
      failures.push(`${path}: expected string`);
    } else {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        failures.push(`${path}: expected at least ${schema.minLength} chars`);
      }
      if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) {
        failures.push(`${path}: expected pattern ${schema.pattern}`);
      }
      if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
        failures.push(`${path}: expected date-time`);
      }
    }
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    failures.push(`${path}: expected boolean`);
  } else if (
    schema.type === "integer" &&
    (!Number.isInteger(value) || typeof value !== "number")
  ) {
    failures.push(`${path}: expected integer`);
  } else if (
    schema.type === "integer" &&
    schema.minimum !== undefined &&
    typeof value === "number" &&
    value < schema.minimum
  ) {
    failures.push(`${path}: expected minimum ${schema.minimum}`);
  }
  return failures;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
