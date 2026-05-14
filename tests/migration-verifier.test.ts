import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("migration verifier", () => {
  it("rejects table rewrites without deferred foreign keys", async () => {
    const root = await migrationFixture({
      secondMigration: migrationSql({
        body: "ALTER TABLE sessions RENAME TO sessions_old;\nDROP TABLE sessions_old;",
      }),
    });
    const result = runMigrationVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PRAGMA defer_foreign_keys = on");
  });

  it("accepts table rewrites with deferred foreign keys", async () => {
    const root = await migrationFixture({
      secondMigration: migrationSql({
        body: "PRAGMA defer_foreign_keys = on;\nALTER TABLE sessions RENAME TO sessions_old;\nDROP TABLE sessions_old;",
      }),
    });
    const result = runMigrationVerifier(root);

    expect(result.status).toBe(0);
  });

  it("rejects migrations that disable foreign keys", async () => {
    const root = await migrationFixture({
      secondMigration: migrationSql({
        body: "PRAGMA foreign_keys = off;",
      }),
    });
    const result = runMigrationVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must not disable foreign key enforcement");
  });

  it("rejects invalid migration filenames", async () => {
    const root = await migrationFixture({
      secondMigration: migrationSql({
        body: "CREATE INDEX sessions_id_idx ON sessions(id);",
      }),
      extraMigrations: [
        [
          "bad_name.sql",
          migrationSql({
            body: "CREATE INDEX users_id_idx ON users(id);",
            version: "0003",
            name: "users-id",
            schemaVersion: "3",
          }),
        ],
      ],
    });
    const result = runMigrationVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "bad_name.sql: migration filename must be ####_name.sql",
    );
  });

  it("rejects mismatched auth_schema_migrations versions", async () => {
    const root = await migrationFixture({
      secondMigration: migrationSql({
        body: "CREATE INDEX sessions_id_idx ON sessions(id);",
        version: "0003",
      }),
    });
    const result = runMigrationVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "0002_indexes.sql: auth_schema_migrations must record 0002",
    );
  });

  it("rejects mismatched auth_meta schema versions", async () => {
    const root = await migrationFixture({
      secondMigration: migrationSql({
        body: "CREATE INDEX sessions_id_idx ON sessions(id);",
        schemaVersion: "3",
      }),
    });
    const result = runMigrationVerifier(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "0002_indexes.sql: auth_meta schema_version must update to 2",
    );
  });
});

async function migrationFixture(options: {
  secondMigration: string;
  extraMigrations?: Array<[string, string]>;
}) {
  const root = await mkdtemp(join(tmpdir(), "cf-auth-migrations-"));
  await mkdir(join(root, "migrations"), { recursive: true });
  await writeFile(
    join(root, "migrations", "0001_initial.sql"),
    migrationSql({
      body: "CREATE TABLE auth_schema_migrations (version TEXT PRIMARY KEY);\nCREATE TABLE auth_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
      version: "0001",
      name: "initial",
      includeAuthMeta: false,
    }),
  );
  await writeFile(
    join(root, "migrations", "0002_indexes.sql"),
    options.secondMigration,
  );
  for (const [file, sql] of options.extraMigrations ?? []) {
    await writeFile(join(root, "migrations", file), sql);
  }
  return root;
}

function migrationSql(options: {
  body: string;
  version?: string;
  name?: string;
  includeAuthMeta?: boolean;
  schemaVersion?: string;
}) {
  const version = options.version ?? "0002";
  const name = options.name ?? "indexes";
  const schemaVersion = options.schemaVersion ?? String(Number(version));
  return [
    options.body,
    `INSERT INTO auth_schema_migrations (version, name, applied_at) VALUES ('${version}', '${name}', 0);`,
    options.includeAuthMeta === false
      ? ""
      : `UPDATE auth_meta SET value = '${schemaVersion}' WHERE key = 'schema_version';`,
  ]
    .filter(Boolean)
    .join("\n");
}

function runMigrationVerifier(cwd: string) {
  const root = process.cwd();
  return spawnSync(
    process.execPath,
    [resolve(root, "scripts", "verify-migrations.mjs")],
    {
      cwd,
      encoding: "utf8",
      env: process.env,
    },
  );
}
