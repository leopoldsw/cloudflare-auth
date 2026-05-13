import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runCli } from "@cf-auth/cli";
import { describe, expect, it } from "vitest";

describe("CLI MVP", () => {
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
    expect(existsSync(join(app, "migrations", "0001_initial.sql"))).toBe(true);
    const generatedPackage = JSON.parse(
      await readFile(join(app, "package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
    };
    expect(generatedPackage.dependencies["@cf-auth/hono"]).toBe("0.0.0");
    expect(generatedPackage.dependencies["@cf-auth/worker"]).toBe("0.0.0");
    expect(JSON.stringify(generatedPackage)).not.toContain("workspace:");
    expect(await readFile(join(app, "src", "index.ts"), "utf8")).toContain(
      "app.route(authConfig.basePath",
    );
    expect(
      await readFile(join(app, "migrations", "0001_initial.sql"), "utf8"),
    ).toBe(await readFile("migrations/0001_initial.sql", "utf8"));
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
    await expect(
      readFile(
        join(cwd, "standalone", "migrations", "0002_indexes.sql"),
        "utf8",
      ),
    ).resolves.toBe(await readFile("migrations/0002_indexes.sql", "utf8"));
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

  it("constructs local and remote Wrangler migration commands", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const local: string[] = [];
    await runCli(["migrate", "--status", "--local"], {
      cwd,
      stdout: (line) => local.push(line),
    });
    expect(local[0]).toBe("wrangler d1 migrations list app-auth-dev --local");

    const remote: string[] = [];
    await runCli(["migrate", "--remote", "--env", "production"], {
      cwd,
      stdout: (line) => remote.push(line),
    });
    expect(remote[0]).toBe(
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
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain(
      "Cloudflare Email binding AUTH_EMAIL is missing",
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

  it("prints deploy dry-run and safe recovery helper output", async () => {
    const cwd = await tempDir();
    await writeWrangler(cwd);
    const deploy: string[] = [];
    await runCli(["deploy", "--dry-run", "--env", "production"], {
      cwd,
      stdout: (line) => deploy.push(line),
    });
    expect(deploy.join("\n")).toContain("doctor --env production: ok");
    expect(deploy.join("\n")).toContain(
      "wrangler d1 migrations list app-auth --remote --env production",
    );
    expect(deploy.join("\n")).toContain("wrangler deploy --env production");

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
});

async function tempDir() {
  return mkdtemp(join(tmpdir(), "cf-auth-cli-"));
}

async function writeWrangler(cwd: string) {
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
            send_email: [{ name: "AUTH_EMAIL" }],
          },
        },
      },
      null,
      2,
    ),
  );
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
  } else if (schema.type === "string" && typeof value !== "string") {
    failures.push(`${path}: expected string`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    failures.push(`${path}: expected boolean`);
  } else if (
    schema.type === "integer" &&
    (!Number.isInteger(value) || typeof value !== "number")
  ) {
    failures.push(`${path}: expected integer`);
  }
  return failures;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
