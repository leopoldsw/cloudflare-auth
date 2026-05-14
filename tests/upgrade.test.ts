import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { applyD1Migrations, createSqliteD1Database } from "@cf-auth/testing";

interface UpgradeManifest {
  schemaVersion: 1;
  betaVersions: Array<{
    version: string;
    schemaVersion: number;
    fixture: string;
  }>;
}

interface UpgradeExpected {
  schemaVersion: string;
  schemaMigrations: string[];
  users: number;
  activeSessions: number;
  invalidatedTokens: number;
}

describe("upgrade fixtures", () => {
  it("requires beta schema fixtures before stable 1.0 packages", async () => {
    const manifest = await readUpgradeManifest();
    const stablePackages = await stableOneOrLaterPackages();

    if (stablePackages.length > 0) {
      expect(
        manifest.betaVersions.length,
        `stable packages require beta schema upgrade fixtures: ${stablePackages.join(", ")}`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps every beta schema fixture addressable", async () => {
    const manifest = await readUpgradeManifest();
    for (const beta of manifest.betaVersions) {
      expect(beta.version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
      expect(Number.isSafeInteger(beta.schemaVersion)).toBe(true);
      expect(beta.schemaVersion).toBeGreaterThan(0);
      const fixtureDir = join("tests", "fixtures", "upgrade", beta.fixture);
      const files = await readdir(fixtureDir);
      expect(files).toContain("schema.sql");
      expect(files).toContain("expected.json");
    }
  });

  it("migrates beta fixtures to the current schema while preserving auth state", async () => {
    const manifest = await readUpgradeManifest();
    for (const beta of manifest.betaVersions) {
      const fixtureDir = join("tests", "fixtures", "upgrade", beta.fixture);
      const db = createSqliteD1Database();
      await db.exec(await readFile(join(fixtureDir, "schema.sql"), "utf8"));
      await applyD1Migrations(db, await migrationsAfter(beta.schemaVersion));

      const expected = JSON.parse(
        await readFile(join(fixtureDir, "expected.json"), "utf8"),
      ) as UpgradeExpected;
      expect(
        await scalar(
          db,
          "SELECT value FROM auth_meta WHERE key = 'schema_version'",
        ),
      ).toBe(expected.schemaVersion);
      const migrations = await db
        .prepare("SELECT version FROM auth_schema_migrations ORDER BY version")
        .all<{ version: string }>();
      expect(migrations.results?.map((row) => row.version)).toEqual(
        expected.schemaMigrations,
      );
      expect(await scalar(db, "SELECT count(*) FROM users")).toBe(
        expected.users,
      );
      expect(
        await scalar(
          db,
          "SELECT count(*) FROM sessions WHERE revoked_at IS NULL",
        ),
      ).toBe(expected.activeSessions);
      expect(
        await scalar(
          db,
          "SELECT count(*) FROM verification_tokens WHERE used_at IS NOT NULL OR revoked_at IS NOT NULL",
        ),
      ).toBe(expected.invalidatedTokens);
    }
  });
});

async function readUpgradeManifest(): Promise<UpgradeManifest> {
  const manifest = JSON.parse(
    await readFile(
      join("tests", "fixtures", "upgrade", "beta-schema-versions.json"),
      "utf8",
    ),
  ) as UpgradeManifest;
  expect(manifest.schemaVersion).toBe(1);
  expect(Array.isArray(manifest.betaVersions)).toBe(true);
  return manifest;
}

async function stableOneOrLaterPackages(): Promise<string[]> {
  const packageRoot = "packages";
  const dirs = await readdir(packageRoot, { withFileTypes: true });
  const stable: string[] = [];
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const pkg = JSON.parse(
      await readFile(join(packageRoot, entry.name, "package.json"), "utf8"),
    ) as { name?: string; private?: boolean; version?: string };
    if (!pkg.private && isStableOneOrLater(pkg.version)) {
      stable.push(`${pkg.name ?? entry.name}@${pkg.version}`);
    }
  }
  return stable.sort();
}

function isStableOneOrLater(version: string | undefined): boolean {
  if (typeof version !== "string") return false;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/);
  if (!match || version.includes("-")) return false;
  return Number(match[1]) >= 1;
}

async function migrationsAfter(schemaVersion: number): Promise<string[]> {
  const files = (await readdir("migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrations: string[] = [];
  for (const file of files) {
    const version = Number(file.slice(0, 4));
    if (version > schemaVersion) {
      migrations.push(await readFile(join("migrations", file), "utf8"));
    }
  }
  return migrations;
}

async function scalar(db: D1Database, sql: string): Promise<string | number> {
  const row = await db.prepare(sql).first<Record<string, string | number>>();
  const value = row ? Object.values(row)[0] : undefined;
  expect(typeof value === "string" || typeof value === "number").toBe(true);
  return value as string | number;
}
