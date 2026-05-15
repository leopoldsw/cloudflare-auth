import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { isJsonObject } from "./evidence-validation.mjs";
import { isBetaPackageTag } from "./release-version-policy.mjs";

const outputDir = process.argv[2];
if (!outputDir) {
  throw new Error(
    "Usage: node scripts/export-deploy-template.mjs <output-directory>",
  );
}

const root = process.cwd();
const target = resolve(root, outputDir);
const templateName =
  process.env.CF_AUTH_DEPLOY_TEMPLATE_NAME?.trim() ||
  "cloudflare-auth-template";
const databaseName =
  process.env.CF_AUTH_DEPLOY_TEMPLATE_DATABASE_NAME?.trim() ||
  "cloudflare-auth-template";
const publicOrigin =
  process.env.CF_AUTH_DEPLOY_TEMPLATE_PUBLIC_ORIGIN?.trim() ||
  "https://example.com";
const packageTag =
  process.env.CF_AUTH_DEPLOY_TEMPLATE_PACKAGE_TAG?.trim() || "beta";
if (!isBetaPackageTag(packageTag)) {
  throw new Error(
    "CF_AUTH_DEPLOY_TEMPLATE_PACKAGE_TAG must be beta or a beta prerelease package version.",
  );
}
const cliPackageSpec = `@cf-auth/cli@${packageTag}`;
const versionMatrix = await readJsonObject("scripts/version-matrix.json");

await assertEmptyOrMissing(target);
await mkdir(target, { recursive: true });
await cp("templates/hono-basic", target, {
  recursive: true,
  filter: (source) => {
    const name = basename(source);
    return (
      name !== "node_modules" &&
      name !== ".wrangler" &&
      name !== ".dev.vars" &&
      name !== ".env" &&
      !name.startsWith(".env.")
    );
  },
});

await writePackageJson(target);
await writeWranglerJson(target);
await writeDevVarsExample(target);
await writeReadme(target);
await writeGitignore(target);

console.log(`deploy template exported to ${target}`);

async function assertEmptyOrMissing(path) {
  try {
    const entries = await readdir(path);
    if (entries.length > 0) {
      throw new Error(`${path} must be empty before exporting a template.`);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") return;
    }
    throw error;
  }
}

async function writePackageJson(dir) {
  const pkg = await readJsonObject("templates/hono-basic/package.json");
  pkg.name = templateName;
  pkg.private = true;
  pkg.packageManager = `pnpm@${versionMatrix.pnpm}`;
  pkg.engines = { node: versionMatrix.node };
  pkg.scripts = {
    dev: "wrangler dev",
    build: "tsc -p tsconfig.json --noEmit",
    test: "vitest run --passWithNoTests",
    "db:migrations:apply": "wrangler d1 migrations apply AUTH_DB --remote",
    deploy: "npm run db:migrations:apply && wrangler deploy",
  };
  pkg.dependencies = {
    "@cf-auth/email-cloudflare": packageTag,
    "@cf-auth/hono": packageTag,
    "@cf-auth/worker": packageTag,
    hono: versionMatrix.hono,
  };
  pkg.devDependencies = {
    "@cf-auth/cli": packageTag,
    typescript: versionMatrix.typescript,
    vitest: versionMatrix.vitest,
    wrangler: versionMatrix.wrangler,
  };
  pkg.cloudflare = {
    bindings: {
      AUTH_DB: {
        description:
          "D1 database used by Cloudflare Auth. Deploy to Cloudflare provisions this from wrangler.jsonc.",
      },
      AUTH_SECRET: {
        description: `Generate with \`npx --package ${cliPackageSpec} cf-auth rotate-secret --print\` and store only the value after AUTH_SECRET=.`,
      },
      AUTH_PUBLIC_ORIGIN: {
        description:
          "Exact https origin for this deployed Worker, for example https://your-worker.your-subdomain.workers.dev. Do not include a path or trailing slash.",
      },
      AUTH_EMAIL: {
        description:
          "Optional Cloudflare Email binding named AUTH_EMAIL. Signup/login still work without it, but verification, magic-link, and reset emails need a production sender.",
      },
    },
  };
  await writeFile(`${dir}/package.json`, JSON.stringify(pkg, null, 2) + "\n");
}

async function readJsonObject(path) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`${path}: must be valid JSON`);
  }
  if (!isJsonObject(parsed)) {
    throw new Error(`${path}: top-level JSON value must be an object`);
  }
  return parsed;
}

async function writeWranglerJson(dir) {
  const wrangler = {
    $schema: "./node_modules/wrangler/config-schema.json",
    name: templateName,
    main: "src/index.ts",
    compatibility_date: versionMatrix.workersCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    observability: {
      enabled: true,
      head_sampling_rate: 1,
    },
    vars: {
      AUTH_ENV: "production",
      AUTH_PUBLIC_ORIGIN: publicOrigin,
    },
    d1_databases: [
      {
        binding: "AUTH_DB",
        database_name: databaseName,
        database_id: databaseName,
        migrations_dir: "migrations",
      },
    ],
    send_email: [{ name: "AUTH_EMAIL", remote: true }],
  };
  await writeFile(
    `${dir}/wrangler.jsonc`,
    JSON.stringify(wrangler, null, 2) + "\n",
  );
}

async function writeDevVarsExample(dir) {
  await writeFile(
    `${dir}/.dev.vars.example`,
    "AUTH_SECRET=k1.REPLACE_WITH_32_BYTE_BASE64URL_SECRET\n",
  );
}

async function writeReadme(dir) {
  await writeFile(
    `${dir}/README.md`,
    `# Cloudflare Auth Template

Self-deployed auth for Cloudflare Workers and D1.

## Deploy To Cloudflare

Use this repository as the target for a Deploy to Cloudflare button:

\`\`\`md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/OWNER/cloudflare-auth-template)
\`\`\`

During setup, provide:

- \`AUTH_PUBLIC_ORIGIN\`: the exact deployed Worker origin, with no path or trailing slash.
- \`AUTH_SECRET\`: a value generated with \`npx --package ${cliPackageSpec} cf-auth rotate-secret --print\`.
- \`AUTH_EMAIL\`: optional Cloudflare Email Service binding for verification, magic-link, and reset email.

The deploy script applies D1 migrations using the \`AUTH_DB\` binding before running \`wrangler deploy\`.
`,
  );
}

async function writeGitignore(dir) {
  await writeFile(
    `${dir}/.gitignore`,
    "node_modules/\n.wrangler/\n.dev.vars\n.env\n.env.*\n*.log\n",
  );
}
