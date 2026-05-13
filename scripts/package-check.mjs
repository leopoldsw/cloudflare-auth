import { spawnSync } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const rootLicense = await readFile("LICENSE", "utf8");
const expectedPackages = new Map([
  ["cf-auth-shim", { name: "cf-auth", bin: "cf-auth" }],
  ["cli", { name: "@cf-auth/cli", bin: "cf-auth" }],
  ["client", { name: "@cf-auth/client" }],
  ["core", { name: "@cf-auth/core" }],
  [
    "create-cloudflare-auth",
    { name: "create-cloudflare-auth", bin: "create-cloudflare-auth" },
  ],
  ["email-cloudflare", { name: "@cf-auth/email-cloudflare" }],
  ["hono", { name: "@cf-auth/hono" }],
  ["testing", { name: "@cf-auth/testing" }],
  ["worker", { name: "@cf-auth/worker" }],
]);
const packageDirs = (await readdir("packages", { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("packages", entry.name))
  .sort();

const failures = [];
for (const expectedDir of expectedPackages.keys()) {
  if (!packageDirs.includes(join("packages", expectedDir))) {
    failures.push(
      `packages/${expectedDir}: expected package directory missing`,
    );
  }
}

for (const dir of packageDirs) {
  const expected = expectedPackages.get(basename(dir));
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  if (!pkg.name) failures.push(`${dir}: missing name`);
  if (!expected) {
    failures.push(`${dir}: unexpected package directory`);
  } else if (pkg.name !== expected.name) {
    failures.push(`${dir}: package name must be ${expected.name}`);
  }
  if (!pkg.license) failures.push(`${pkg.name}: missing license`);
  try {
    const packageLicense = await readFile(join(dir, "LICENSE"), "utf8");
    if (packageLicense !== rootLicense) {
      failures.push(`${pkg.name}: LICENSE must match root LICENSE`);
    }
  } catch {
    failures.push(`${pkg.name}: LICENSE file missing`);
  }
  if (!pkg.exports?.["."])
    failures.push(`${pkg.name}: missing root export map`);
  if (!pkg.types) failures.push(`${pkg.name}: missing types field`);
  if (!pkg.files?.includes("dist"))
    failures.push(`${pkg.name}: package files must include dist`);
  if (pkg.private)
    failures.push(`${pkg.name}: publishable packages must not be private`);
  if (pkg.engines?.node !== ">=22.12.0")
    failures.push(`${pkg.name}: node engine mismatch`);
  if (expected?.bin && !pkg.bin?.[expected.bin]) {
    failures.push(`${pkg.name}: missing ${expected.bin} bin`);
  }
  for (const file of pkg.files ?? []) {
    try {
      await access(join(dir, file));
    } catch {
      failures.push(`${pkg.name}: files entry ${file} does not exist`);
    }
  }
  if (pkg.bin) {
    for (const [name, target] of Object.entries(pkg.bin)) {
      if (!String(target).startsWith("./dist/"))
        failures.push(`${pkg.name}: bin ${name} must point into dist`);
      if (pkg.exports?.["."]?.import === target) {
        failures.push(
          `${pkg.name}: bin ${name} must use a dedicated bin entrypoint, not the root export`,
        );
      }
      try {
        const bin = await readFile(join(dir, String(target)), "utf8");
        if (!bin.startsWith("#!/usr/bin/env node")) {
          failures.push(`${pkg.name}: bin ${name} is missing node shebang`);
        }
      } catch {
        failures.push(`${pkg.name}: bin ${name} target ${target} missing`);
      }
    }
  }
  const pack = packDryRun(dir, pkg.name);
  if (pack) {
    const packedPaths = new Set(pack.files.map((file) => file.path));
    for (const required of [
      "package.json",
      "README.md",
      "LICENSE",
      packagePath(pkg.types),
      packagePath(pkg.main),
      packagePath(pkg.module),
      packagePath(pkg.exports?.["."]?.types),
      packagePath(pkg.exports?.["."]?.import),
      packagePath(pkg.exports?.["."]?.require),
      ...Object.values(pkg.bin ?? {}).map((target) => packagePath(target)),
    ].filter(Boolean)) {
      if (!packedPaths.has(required)) {
        failures.push(`${pkg.name}: packed artifact missing ${required}`);
      }
    }
  }
}

await verifyPackageNamingDocs();

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

function packDryRun(dir, name) {
  const result = spawnSync(
    "pnpm",
    ["--dir", dir, "pack", "--dry-run", "--json"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    failures.push(`${name}: pnpm pack --dry-run failed`);
    if (result.stderr.trim()) failures.push(result.stderr.trim());
    return null;
  }
  try {
    const pack = JSON.parse(result.stdout);
    if (pack.name !== name) {
      failures.push(`${name}: packed artifact name was ${pack.name}`);
    }
    return pack;
  } catch {
    failures.push(`${name}: pnpm pack --dry-run did not emit JSON`);
    return null;
  }
}

function packagePath(value) {
  if (!value) return "";
  return String(value).replace(/^\.\//, "");
}

async function verifyPackageNamingDocs() {
  const naming = await readFile("docs/decisions/package-naming.md", "utf8");
  for (const { name } of expectedPackages.values()) {
    if (!naming.includes(`\`${name}\``)) {
      failures.push(`docs/decisions/package-naming.md: missing ${name}`);
    }
  }

  const fallback = "npx --package @cf-auth/cli@latest cf-auth init";
  for (const file of ["README.md", "docs/quickstart.md"]) {
    const text = await readFile(file, "utf8");
    if (
      (text.includes("npm create cloudflare-auth@latest") ||
        text.includes("npx cf-auth@latest")) &&
      !text.includes(fallback)
    ) {
      failures.push(`${file}: public package commands must document fallback`);
    }
  }
}
