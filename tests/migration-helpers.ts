import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { applyD1Migrations } from "@cf-auth/testing";

export async function applyRootD1Migrations(db: D1Database): Promise<void> {
  await applyD1Migrations(db, await rootMigrationSql());
}

export async function rootMigrationVersions(): Promise<string[]> {
  return (await rootMigrationFiles()).map(migrationVersion);
}

export async function rootSchemaVersion(): Promise<string> {
  const versions = await rootMigrationVersions();
  const latest = versions.at(-1);
  if (!latest) throw new Error("No root migrations found");
  return String(Number(latest));
}

async function rootMigrationSql(): Promise<string[]> {
  return Promise.all(
    (await rootMigrationFiles()).map((file) =>
      readFile(join("migrations", file), "utf8"),
    ),
  );
}

async function rootMigrationFiles(): Promise<string[]> {
  return (await readdir("migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
}

function migrationVersion(file: string): string {
  const version = /^(\d+)_/.exec(file)?.[1];
  if (!version) throw new Error(`${file}: migration file is missing a version`);
  return version;
}
