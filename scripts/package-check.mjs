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
await verifyCiControls();
await verifyReleaseControls();

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
    if (!text.includes(fallback)) {
      failures.push(
        `${file}: public package commands must use scoped fallback`,
      );
    }
  }

  const docs = await listMarkdownFiles("docs");
  const publicCommandFiles = ["README.md", ...docs].filter(
    (file) => file !== "docs/decisions/package-naming.md",
  );
  for (const file of publicCommandFiles) {
    const text = await readFile(file, "utf8");
    if (/\bnpx\s+cf-auth(?:@[\w.-]+)?\b/.test(text)) {
      failures.push(
        `${file}: npx cf-auth commands are blocked until package ownership is confirmed`,
      );
    }
    if (/\bnpm\s+create\s+cloudflare-auth(?:@[\w.-]+)?\b/.test(text)) {
      failures.push(
        `${file}: npm create cloudflare-auth commands are blocked until package ownership is confirmed`,
      );
    }
  }
}

async function verifyReleaseControls() {
  const releaseWorkflow = await readFile(
    ".github/workflows/release.yml",
    "utf8",
  );
  for (const needle of [
    "id-token: write",
    "package_names_confirmed",
    "pnpm format:check",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm test:workers",
    "pnpm build",
    "pnpm package:check",
    "pnpm version-matrix:check",
    "pnpm audit --audit-level high",
    "continue-on-error: true",
    "pnpm verify:alpha-evidence",
    "pnpm verify:beta-evidence",
    "pnpm verify:deploy-button-evidence",
    "pnpm verify:deploy-template",
    "pnpm verify:docs-coverage",
    "pnpm verify:migrations",
    "pnpm verify:examples",
    "pnpm verify:package-ownership",
    "CF_AUTH_REQUIRE_PACKAGE_OWNERSHIP",
    "pnpm check:package-names",
    "pnpm verify:security-docs",
    "pnpm verify:security-tracker",
    "pnpm release:gates",
    "pnpm smoke:tarballs",
    "CF_AUTH_TARBALL_INSTALL",
    "pnpm benchmark:password",
    "pnpm changeset publish --provenance",
  ]) {
    if (!releaseWorkflow.includes(needle)) {
      failures.push(`.github/workflows/release.yml: missing ${needle}`);
    }
  }

  const changesets = JSON.parse(
    await readFile(".changeset/config.json", "utf8"),
  );
  if (changesets.changelog !== "@changesets/cli/changelog") {
    failures.push(
      ".changeset/config.json: changelog must use @changesets/cli/changelog",
    );
  }
  if (changesets.access !== "public") {
    failures.push(".changeset/config.json: access must be public");
  }
  const expectedPackageNames = [...expectedPackages.values()]
    .map(({ name }) => name)
    .sort();
  const fixedGroups = Array.isArray(changesets.fixed) ? changesets.fixed : [];
  const hasExpectedFixedGroup = fixedGroups.some(
    (group) =>
      Array.isArray(group) &&
      group.length === expectedPackageNames.length &&
      [...group]
        .sort()
        .every((name, index) => name === expectedPackageNames[index]),
  );
  if (!hasExpectedFixedGroup) {
    failures.push(
      ".changeset/config.json: fixed group must include every publishable package",
    );
  }
  if (Array.isArray(changesets.linked) && changesets.linked.length > 0) {
    failures.push(
      ".changeset/config.json: linked groups must be empty when all packages are fixed together",
    );
  }

  for (const [file, needles] of [
    [
      "docs/decisions/package-naming.md",
      ["npm publisher 2FA", "npm provenance"],
    ],
    [
      "docs/release-checklist.md",
      [
        "npm publisher 2FA",
        "package ownership verified",
        "verify:package-ownership",
        "check:package-names",
        "not as the sole security gate",
        "secret scanning",
        "Changesets version/changelog",
        "Changesets fixed package group",
      ],
    ],
  ]) {
    const text = await readFile(file, "utf8");
    for (const needle of needles) {
      if (!text.includes(needle)) {
        failures.push(`${file}: missing ${needle}`);
      }
    }
  }
}

async function verifyCiControls() {
  const ciWorkflow = await readFile(".github/workflows/ci.yml", "utf8");
  for (const needle of [
    "pnpm install --frozen-lockfile",
    "pnpm format:check",
    "pnpm lint",
    "pnpm typecheck",
    "pnpm test",
    "pnpm build",
    "pnpm package:check",
    "pnpm version-matrix:check",
  ]) {
    if (!ciWorkflow.includes(needle)) {
      failures.push(`.github/workflows/ci.yml: missing ${needle}`);
    }
  }

  const examplesWorkflow = await readFile(
    ".github/workflows/examples.yml",
    "utf8",
  );
  if (!examplesWorkflow.includes("pnpm verify:examples")) {
    failures.push(
      ".github/workflows/examples.yml: missing pnpm verify:examples",
    );
  }
}

async function listMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files.sort();
}
