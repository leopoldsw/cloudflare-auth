import { readFile, readdir } from "node:fs/promises";

const files = (await readdir("migrations"))
  .filter((file) => file.endsWith(".sql"))
  .sort();
const failures = [];

for (const file of files) {
  const sql = await readFile(`migrations/${file}`, "utf8");
  const filenameMatch = file.match(/^(\d{4})_[a-z0-9_]+\.sql$/u);
  const version = filenameMatch?.[1] ?? file.slice(0, 4);
  const schemaVersion = String(Number(version));
  if (!filenameMatch) {
    failures.push(`${file}: migration filename must be ####_name.sql`);
  }
  if (/\bBEGIN\b|\bCOMMIT\b/i.test(sql))
    failures.push(`${file}: migrations must not include BEGIN/COMMIT`);
  if (/\bPRAGMA\s+foreign_keys\s*=\s*off\b/i.test(sql)) {
    failures.push(
      `${file}: migrations must not disable foreign key enforcement`,
    );
  }
  for (const definition of metadataJsonColumnDefinitions(sql)) {
    if (
      !/\bCHECK\s*\(\s*json_valid\s*\(\s*metadata_json\s*\)\s*\)/iu.test(
        definition,
      )
    ) {
      failures.push(
        `${file}: metadata_json columns must enforce CHECK (json_valid(metadata_json))`,
      );
      break;
    }
  }
  if (
    file !== "0001_initial.sql" &&
    containsTableRewrite(sql) &&
    !/\bPRAGMA\s+defer_foreign_keys\s*=\s*on\b/i.test(sql)
  ) {
    failures.push(
      `${file}: table rewrite migrations must use PRAGMA defer_foreign_keys = on`,
    );
  }
  if (!sql.includes("auth_schema_migrations"))
    failures.push(`${file}: missing auth_schema_migrations update`);
  else if (!recordsMigrationVersion(sql, version)) {
    failures.push(`${file}: auth_schema_migrations must record ${version}`);
  }
  if (file !== "0001_initial.sql" && !sql.includes("auth_meta"))
    failures.push(`${file}: missing auth_meta update`);
  else if (
    file !== "0001_initial.sql" &&
    !updatesAuthMetaVersion(sql, schemaVersion)
  ) {
    failures.push(
      `${file}: auth_meta schema_version must update to ${schemaVersion}`,
    );
  }
}

if (!files.includes("0001_initial.sql"))
  failures.push("missing 0001_initial.sql");
if (!files.includes("0002_indexes.sql"))
  failures.push("missing 0002_indexes.sql");
const versions = files
  .map((file) => file.match(/^(\d{4})_[a-z0-9_]+\.sql$/u)?.[1])
  .filter(Boolean);
for (const [index, version] of versions.entries()) {
  const expected = String(index + 1).padStart(4, "0");
  if (version !== expected) {
    failures.push(
      `migration versions must be contiguous; expected ${expected}, found ${version}`,
    );
    break;
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

function containsTableRewrite(sql) {
  return (
    /\bDROP\s+TABLE\b/i.test(sql) ||
    /\bALTER\s+TABLE\b[^;]+\bRENAME\s+TO\b/i.test(sql)
  );
}

function metadataJsonColumnDefinitions(sql) {
  return sql
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        /^metadata_json\b/iu.test(line) ||
        /\bADD\s+COLUMN\s+metadata_json\b/iu.test(line),
    );
}

function recordsMigrationVersion(sql, version) {
  return new RegExp(
    String.raw`\bINSERT\s+INTO\s+auth_schema_migrations\b[\s\S]*\bVALUES\s*\([^;]*['"]${version}['"]`,
    "iu",
  ).test(sql);
}

function updatesAuthMetaVersion(sql, schemaVersion) {
  return new RegExp(
    String.raw`\bUPDATE\s+auth_meta\b[\s\S]*\bSET\s+value\s*=\s*['"]${schemaVersion}['"]`,
    "iu",
  ).test(sql);
}
