import { readFile } from "node:fs/promises";

const matrix = JSON.parse(
  await readFile("scripts/version-matrix.json", "utf8"),
);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const required = {
  packageManager: `pnpm@${matrix.pnpm}`,
  typescript: matrix.typescript,
  wrangler: matrix.wrangler,
  hono: matrix.hono,
  tsup: matrix.tsup,
  vitest: matrix.vitest,
  zod: matrix.zod,
  "@changesets/cli": matrix.changesets,
};

const failures = [];
if (pkg.packageManager !== required.packageManager) {
  failures.push(`packageManager must be ${required.packageManager}`);
}

for (const [name, version] of Object.entries(required)) {
  if (name === "packageManager") continue;
  const actual = pkg.devDependencies?.[name] ?? pkg.dependencies?.[name];
  if (actual !== version)
    failures.push(
      `${name} must be pinned to ${version}; found ${actual ?? "missing"}`,
    );
}

if (pkg.engines?.node !== matrix.node)
  failures.push(`node engine must be ${matrix.node}`);
if (pkg.engines?.pnpm !== ">=11 <12")
  failures.push("pnpm engine must be >=11 <12");

await requireMatch(
  "docs/toolchain.md",
  new RegExp(
    `\\|\\s*Workers compatibility date\\s*\\|\\s*\`${escapeRegex(
      matrix.workersCompatibilityDate,
    )}\``,
  ),
  `Workers compatibility date ${matrix.workersCompatibilityDate}`,
);
await requireMatch(
  "docs/toolchain.md",
  new RegExp(
    `\\|\\s*Workers compatibility date floor\\s*\\|\\s*\`${escapeRegex(
      matrix.workersCompatibilityDateFloor,
    )}\``,
  ),
  `Workers compatibility date floor ${matrix.workersCompatibilityDateFloor}`,
);
await requireText(
  "vitest.workers.config.ts",
  `compatibilityDate: "${matrix.workersCompatibilityDate}"`,
);
await requireText(
  "packages/cli/src/password-benchmark.ts",
  `const benchmarkCompatibilityDate = "${matrix.workersCompatibilityDate}"`,
);
await requireText(
  "packages/cli/src/index.ts",
  `"compatibility_date": "${matrix.workersCompatibilityDate}"`,
);
await requireText(
  "packages/cli/src/index.ts",
  `const workersCompatibilityDate = "${matrix.workersCompatibilityDate}"`,
);
await requireText(
  "packages/cli/src/index.ts",
  `const workersCompatibilityDateFloor = "${matrix.workersCompatibilityDateFloor}"`,
);
await requireText(
  "packages/cli/src/index.ts",
  `"$schema": "./node_modules/wrangler/config-schema.json"`,
);
await requireText(
  "packages/cli/src/index.ts",
  `const workersNodeCompatibilityFlag = "nodejs_compat"`,
);
await requireText("packages/cli/src/index.ts", `"observability": {`);
await requireText(
  "scripts/export-deploy-template.mjs",
  `compatibility_date: "${matrix.workersCompatibilityDate}"`,
);
await requireText("scripts/export-deploy-template.mjs", "observability: {");
await requireText(
  "scripts/export-deploy-template.mjs",
  '$schema: "./node_modules/wrangler/config-schema.json"',
);
await requireText(
  "scripts/smoke-production-cloudflare.mjs",
  `compatibility_date: "${matrix.workersCompatibilityDate}"`,
);
await requireText(
  "scripts/smoke-production-cloudflare.mjs",
  "observability: {",
);
await requireText(
  "scripts/smoke-production-cloudflare.mjs",
  '$schema: "./node_modules/wrangler/config-schema.json"',
);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

async function requireText(path, needle) {
  const text = await readFile(path, "utf8");
  if (!text.includes(needle)) {
    failures.push(`${path}: missing ${needle}`);
  }
}

async function requireMatch(path, pattern, label) {
  const text = await readFile(path, "utf8");
  if (!pattern.test(text)) {
    failures.push(`${path}: missing ${label}`);
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
