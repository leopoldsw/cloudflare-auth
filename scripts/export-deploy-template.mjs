import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

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

await assertEmptyOrMissing(target);
await mkdir(target, { recursive: true });
await cp("templates/hono-basic", target, {
  recursive: true,
  filter: (source) => {
    const name = basename(source);
    return name !== "node_modules" && name !== ".wrangler";
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
  const pkg = JSON.parse(
    await readFile("templates/hono-basic/package.json", "utf8"),
  );
  pkg.name = templateName;
  pkg.private = true;
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
    hono: "4.12.18",
  };
  pkg.devDependencies = {
    "@cf-auth/cli": packageTag,
    typescript: "6.0.3",
    vitest: "4.1.6",
    wrangler: "4.90.1",
  };
  pkg.cloudflare = {
    bindings: {
      AUTH_DB: {
        description:
          "D1 database used by Cloudflare Auth. Deploy to Cloudflare provisions this from wrangler.jsonc.",
      },
      AUTH_SECRET: {
        description:
          "Generate with `npx --package @cf-auth/cli@latest cf-auth rotate-secret --print` and store only the value after AUTH_SECRET=.",
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

async function writeWranglerJson(dir) {
  const wrangler = {
    name: templateName,
    main: "src/index.ts",
    compatibility_date: "2026-05-14",
    compatibility_flags: ["nodejs_compat"],
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
- \`AUTH_SECRET\`: a value generated with \`npx --package @cf-auth/cli@latest cf-auth rotate-secret --print\`.

The deploy script applies D1 migrations using the \`AUTH_DB\` binding before running \`wrangler deploy\`.
`,
  );
}

async function writeGitignore(dir) {
  await writeFile(
    `${dir}/.gitignore`,
    "node_modules/\n.wrangler/\n.dev.vars\n.env\n*.log\n",
  );
}
