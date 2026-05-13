import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { base64urlEncode } from "@cf-auth/core";
import cliPackageJson from "../package.json" with { type: "json" };

export const cliPackageName = "@cf-auth/cli";
const generatedPackageVersion = cliPackageJson.version;

export interface CliIO {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

type DoctorCheckStatus = "pass" | "fail" | "warn";

interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  fix?: string;
}

interface DoctorReport {
  $schema: string;
  schemaVersion: 1;
  ok: boolean;
  generatedAt: string;
  environment: string;
  summary: {
    pass: number;
    fail: number;
    warn: number;
  };
  checks: DoctorCheck[];
  redaction: {
    rawSecrets: "omitted";
    rawTokens: "omitted";
    rawCookies: "omitted";
    rawEmails: "omitted";
    rawIps: "omitted";
    rawUserAgents: "omitted";
  };
}

export async function runCli(
  args = process.argv.slice(2),
  io: CliIO = {},
): Promise<number> {
  const parsed = parseArgs(args);
  const out = io.stdout ?? console.log;
  const err = io.stderr ?? console.error;
  const cwd = io.cwd ?? process.cwd();
  try {
    switch (parsed.command) {
      case "help":
      case "--help":
      case "-h":
        out(
          "cf-auth <init|migrate|doctor|deploy|generate|clean|rotate-secret|users|sessions>",
        );
        return 0;
      case "init":
        await commandInit(parsed, cwd, out);
        return 0;
      case "migrate":
        out(await commandMigrate(parsed, cwd));
        return 0;
      case "doctor": {
        const result = await commandDoctor(parsed, cwd);
        if (parsed.flags.report) {
          out(JSON.stringify(result.report, null, 2));
          return result.ok ? 0 : 1;
        }
        for (const line of result.lines) (result.ok ? out : err)(line);
        return result.ok ? 0 : 1;
      }
      case "deploy":
        out(await commandDeploy(parsed, cwd));
        return 0;
      case "generate":
        out(commandGenerate(parsed));
        return 0;
      case "rotate-secret":
        out(commandRotateSecret(parsed));
        return 0;
      case "clean":
        out(commandClean(parsed));
        return 0;
      case "users":
      case "sessions":
        out(commandRecovery(parsed));
        return 0;
      default:
        err(`Unknown command: ${parsed.command}`);
        return 1;
    }
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function commandInit(
  parsed: ParsedArgs,
  cwd: string,
  out: (line: string) => void,
): Promise<void> {
  const target = resolve(cwd, parsed.positionals[0] ?? ".");
  if (parsed.flags["dry-run"]) {
    out(
      "Would write auth.config.ts, wrangler.jsonc, migrations, .dev.vars.example, and route mount snippets.",
    );
    out(
      "Hono mount: app.route(authConfig.basePath, createAuthRoutes(authConfig));",
    );
    return;
  }
  await mkdir(join(target, "src"), { recursive: true });
  await mkdir(join(target, "migrations"), { recursive: true });
  const localSecret = `k_dev.${base64urlEncode(randomBytes(32))}`;
  await writeIfMissing(
    join(target, "package.json"),
    JSON.stringify(templatePackageJson(), null, 2) + "\n",
  );
  await writeIfMissing(join(target, "tsconfig.json"), tsconfigTemplate());
  await writeIfMissing(
    join(target, "src", "auth.config.ts"),
    authConfigTemplate(),
  );
  await writeIfMissing(join(target, "src", "index.ts"), honoIndexTemplate());
  await writeIfMissing(join(target, "wrangler.jsonc"), wranglerTemplate());
  await writeIfMissing(join(target, ".gitignore"), gitignoreTemplate());
  await writeIfMissing(join(target, ".dev.vars"), devVarsTemplate(localSecret));
  await writeIfMissing(join(target, ".dev.vars.example"), devVarsTemplate());
  await writeIfMissing(
    join(target, "migrations", "0001_initial.sql"),
    initialMigrationSql(),
  );
  await writeIfMissing(
    join(target, "migrations", "0002_indexes.sql"),
    indexesMigrationSql(),
  );
  out(`Initialized Cloudflare Auth in ${target}`);
  out("Next: pnpm install && npx cf-auth migrate --local && npm run dev");
}

async function commandMigrate(
  parsed: ParsedArgs,
  cwd: string,
): Promise<string> {
  const config = await readWrangler(cwd);
  const target = targetMode(parsed);
  const database = selectD1(config, parsed.flags.env as string | undefined);
  const envFlag =
    target.remote && parsed.flags.env ? ` --env ${parsed.flags.env}` : "";
  const status = parsed.flags.status ? "list" : "apply";
  const remoteFlag = target.remote ? "--remote" : "--local";
  if (target.remote && hasNamedEnvironments(config) && !parsed.flags.env) {
    throw new Error(
      "Remote migrations require --env when Wrangler config uses named environments.",
    );
  }
  return `wrangler d1 migrations ${status} ${database.database_name} ${remoteFlag}${envFlag}`;
}

async function commandDoctor(
  parsed: ParsedArgs,
  cwd: string,
): Promise<{ ok: boolean; lines: string[]; report: DoctorReport }> {
  const checks: DoctorCheck[] = [];
  let ok = true;
  let config: WranglerConfig | null = null;
  const envName = parsed.flags.env as string | undefined;
  const addCheck = (check: DoctorCheck) => {
    checks.push(check);
    if (check.status === "fail") ok = false;
  };
  try {
    config = await readWrangler(cwd);
    addCheck({
      id: "wrangler_config",
      status: "pass",
      message: "Wrangler config found",
    });
  } catch {
    addCheck({
      id: "wrangler_config",
      status: "fail",
      message: "Wrangler config missing",
      fix: "npx cf-auth@latest init --repair",
    });
    return {
      ok: false,
      lines: renderDoctorLines(checks),
      report: buildDoctorReport(checks, envName),
    };
  }
  const selected = envName ? config.env?.[envName] : config;
  if (envName && !selected) {
    addCheck({
      id: "wrangler_environment",
      status: "fail",
      message: `Wrangler environment ${envName} missing`,
      fix: `add env.${envName} to wrangler.jsonc`,
    });
    return {
      ok: false,
      lines: renderDoctorLines(checks),
      report: buildDoctorReport(checks, envName),
    };
  }
  const d1 = selected?.d1_databases?.find((item) => item.binding === "AUTH_DB");
  if (!d1) {
    addCheck({
      id: "d1_binding",
      status: "fail",
      message: "D1 binding AUTH_DB is missing",
      fix: "npx cf-auth@latest init --repair or add d1_databases binding AUTH_DB",
    });
  } else if (d1.database_id?.startsWith("REPLACE_")) {
    addCheck({
      id: "d1_database_id",
      status: "fail",
      message: "D1 database_id is still a placeholder",
      fix: "set the real D1 database_id for AUTH_DB",
    });
  } else {
    addCheck({
      id: "d1_binding",
      status: "pass",
      message: "D1 binding AUTH_DB configured",
    });
  }
  const vars = selected?.vars ?? {};
  if (!vars.AUTH_ENV) {
    addCheck({
      id: "auth_env",
      status: "fail",
      message: "AUTH_ENV is missing",
      fix: "set vars.AUTH_ENV to development, preview, or production",
    });
  } else {
    addCheck({
      id: "auth_env",
      status: "pass",
      message: "AUTH_ENV configured",
    });
  }
  if ((vars.AUTH_ENV === "production" || envName) && !vars.AUTH_PUBLIC_ORIGIN) {
    addCheck({
      id: "public_origin",
      status: "fail",
      message: "Production public origin is missing",
      fix: "set AUTH_PUBLIC_ORIGIN=https://example.com",
    });
  } else if (vars.AUTH_PUBLIC_ORIGIN) {
    addCheck({
      id: "public_origin",
      status: "pass",
      message: "Public origin configured",
    });
  }
  if (vars.AUTH_ENV === "production" || envName) {
    const email = selected?.send_email?.find(
      (item) => item.name === "AUTH_EMAIL",
    );
    if (!email) {
      addCheck({
        id: "email_binding",
        status: "fail",
        message: "Cloudflare Email binding AUTH_EMAIL is missing",
        fix: "add a send_email binding named AUTH_EMAIL or configure a custom production email adapter",
      });
    } else {
      addCheck({
        id: "email_binding",
        status: "pass",
        message: "Cloudflare Email binding AUTH_EMAIL configured",
      });
    }
  }
  if (!existsSync(join(cwd, ".dev.vars")) && !envName) {
    addCheck({
      id: "local_secret",
      status: "fail",
      message: "Local AUTH_SECRET is missing",
      fix: "npx cf-auth@latest rotate-secret --print > .dev.vars",
    });
  }
  if (ok)
    addCheck({
      id: "auth_route",
      status: "pass",
      message: "Auth route mounted at /auth",
    });
  return {
    ok,
    lines: renderDoctorLines(checks),
    report: buildDoctorReport(checks, envName),
  };
}

function renderDoctorLines(checks: DoctorCheck[]): string[] {
  const lines: string[] = [];
  for (const check of checks) {
    const icon =
      check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
    lines.push(`${icon} ${check.message}`);
    if (check.fix) lines.push(`  Fix: ${check.fix}`);
  }
  return lines;
}

function buildDoctorReport(
  checks: DoctorCheck[],
  envName: string | undefined,
): DoctorReport {
  const summary = {
    pass: checks.filter((check) => check.status === "pass").length,
    fail: checks.filter((check) => check.status === "fail").length,
    warn: checks.filter((check) => check.status === "warn").length,
  };
  return {
    $schema: "https://cf-auth.dev/schemas/doctor-report.v1.json",
    schemaVersion: 1,
    ok: summary.fail === 0,
    generatedAt: new Date().toISOString(),
    environment: envName ?? "default",
    summary,
    checks,
    redaction: {
      rawSecrets: "omitted",
      rawTokens: "omitted",
      rawCookies: "omitted",
      rawEmails: "omitted",
      rawIps: "omitted",
      rawUserAgents: "omitted",
    },
  };
}

async function commandDeploy(parsed: ParsedArgs, cwd: string): Promise<string> {
  const envName = parsed.flags.env as string | undefined;
  if (!parsed.flags["dry-run"]) {
    throw new Error(
      "Only deploy --dry-run is implemented in this local CLI build.",
    );
  }
  const config = await readWrangler(cwd);
  if (hasNamedEnvironments(config) && !envName) {
    throw new Error(
      "Deploy requires --env when Wrangler config uses named environments.",
    );
  }
  const doctor = await commandDoctor(parsed, cwd);
  if (!doctor.ok) {
    throw new Error(`doctor failed before deploy:\n${doctor.lines.join("\n")}`);
  }
  const migrationStatus = await commandMigrate(
    {
      command: "migrate",
      positionals: [],
      flags: {
        status: true,
        remote: true,
        ...(envName ? { env: envName } : {}),
      },
    },
    cwd,
  );
  const envFlag = envName ? ` --env ${envName}` : "";
  return [
    `doctor --env ${envName ?? "default"}: ok`,
    migrationStatus,
    `wrangler deploy${envFlag}`,
  ].join("\n");
}

function commandGenerate(parsed: ParsedArgs): string {
  const what = parsed.positionals[0] ?? "hono";
  if (what === "types")
    return "export interface Env { AUTH_DB: D1Database; AUTH_SECRET: string; }";
  if (what === "react-client")
    return 'import { createAuthClient } from "@cf-auth/client";\nexport const auth = createAuthClient({ basePath: "/auth" });';
  if (what === "worker-snippet")
    return "const authHandler = createAuthHandler(authConfig);\nconst authResponse = await authHandler.fetch(request, env, ctx);";
  return "app.route(authConfig.basePath, createAuthRoutes(authConfig));";
}

function commandRotateSecret(parsed: ParsedArgs): string {
  const kid = typeof parsed.flags.kid === "string" ? parsed.flags.kid : "k1";
  const secret = `${kid}.${base64urlEncode(randomBytes(32))}`;
  if (parsed.flags.apply) return "wrangler secret put AUTH_SECRET";
  return `AUTH_SECRET=${secret}`;
}

function commandClean(parsed: ParsedArgs): string {
  const target = targetMode(parsed);
  const envFlag = parsed.flags.env ? ` --env ${parsed.flags.env}` : "";
  const remoteFlag = target.remote ? "--remote" : "--local";
  return `wrangler d1 execute AUTH_DB ${remoteFlag}${envFlag} --command <redacted cleanup SQL>`;
}

function commandRecovery(parsed: ParsedArgs): string {
  if (!parsed.flags["dry-run"])
    return "Recovery helpers require --dry-run in this local build.";
  return "Dry run only. Would update users/sessions without printing tokens, hashes, cookies, raw IPs, or raw user agents.";
}

function parseArgs(args: string[]): ParsedArgs {
  const [command = "help", ...rest] = args;
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else if (arg) {
      positionals.push(arg);
    }
  }
  return { command, flags, positionals };
}

function targetMode(parsed: ParsedArgs): { local: boolean; remote: boolean } {
  const local = Boolean(parsed.flags.local);
  const remote = Boolean(parsed.flags.remote);
  if (local === remote)
    throw new Error("Specify exactly one of --local or --remote.");
  return { local, remote };
}

interface WranglerConfig {
  vars?: Record<string, string>;
  send_email?: Array<{ name: string }>;
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    database_id?: string;
  }>;
  env?: Record<string, WranglerConfig>;
}

async function readWrangler(cwd: string): Promise<WranglerConfig> {
  const path = existsSync(join(cwd, "wrangler.jsonc"))
    ? join(cwd, "wrangler.jsonc")
    : join(cwd, "wrangler.json");
  const text = await readFile(path, "utf8");
  return JSON.parse(stripJsonComments(text)) as WranglerConfig;
}

function selectD1(config: WranglerConfig, envName?: string) {
  const selected = envName ? config.env?.[envName] : config;
  const database = selected?.d1_databases?.find(
    (item) => item.binding === "AUTH_DB",
  );
  if (!database) throw new Error("D1 binding AUTH_DB is missing.");
  return database;
}

function hasNamedEnvironments(config: WranglerConfig): boolean {
  return Boolean(config.env && Object.keys(config.env).length > 0);
}

function stripJsonComments(text: string): string {
  return text.replace(/^\s*\/\/.*$/gmu, "");
}

async function writeIfMissing(path: string, contents: string): Promise<void> {
  if (existsSync(path)) return;
  await writeFile(path, contents);
}

function templatePackageJson() {
  return {
    type: "module",
    scripts: {
      dev: "wrangler dev",
      build: "tsc -p tsconfig.json --noEmit",
      test: "vitest run --passWithNoTests",
    },
    dependencies: {
      "@cf-auth/hono": generatedPackageVersion,
      "@cf-auth/worker": generatedPackageVersion,
      hono: "4.12.18",
    },
    devDependencies: {
      typescript: "6.0.3",
      wrangler: "4.90.1",
      vitest: "4.1.6",
    },
    engines: { node: ">=22.12.0" },
  };
}

function authConfigTemplate(): string {
  return `import { defineAuthConfig, terminalEmail } from "@cf-auth/worker";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  passwordHashing: {
    profile: "development-fast",
    maxConcurrentHashesPerIsolate: 1
  },
  email: terminalEmail({ outbox: true })
});
`;
}

function honoIndexTemplate(): string {
  return `import { Hono } from "hono";
import { createAuthRoutes } from "@cf-auth/hono";
import authConfig from "./auth.config.js";

const app = new Hono();
app.route(authConfig.basePath, createAuthRoutes(authConfig));
export default app;
`;
}

function tsconfigTemplate(): string {
  return `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
`;
}

function wranglerTemplate(): string {
  return `{
  "name": "my-app-dev",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-13",
  "compatibility_flags": ["nodejs_compat"],
  "vars": {
    "AUTH_ENV": "development",
    "AUTH_PUBLIC_ORIGIN": "http://localhost:8787"
  },
  "d1_databases": [
    {
      "binding": "AUTH_DB",
      "database_name": "my-app-auth-dev",
      "database_id": "REPLACE_WITH_DATABASE_ID"
    }
  ],
  "env": {
    "production": {
      "name": "my-app",
      "vars": {
        "AUTH_ENV": "production",
        "AUTH_PUBLIC_ORIGIN": "https://example.com"
      },
      "d1_databases": [
        {
          "binding": "AUTH_DB",
          "database_name": "my-app-auth",
          "database_id": "REPLACE_WITH_DATABASE_ID"
        }
      ],
      "send_email": [
        {
          "name": "AUTH_EMAIL"
        }
      ]
    }
  }
}
`;
}

function gitignoreTemplate(): string {
  return `.dev.vars
.wrangler
node_modules
dist
`;
}

function devVarsTemplate(
  secret = "k_dev.REPLACE_WITH_GENERATED_BASE64URL_SECRET",
): string {
  return `AUTH_ENV=development
AUTH_PUBLIC_ORIGIN=http://localhost:8787
AUTH_SECRET=${secret}
`;
}

function initialMigrationSql(): string {
  return `CREATE TABLE auth_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE auth_schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

INSERT INTO auth_meta (key, value, updated_at)
VALUES ('schema_version', '1', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

INSERT INTO auth_schema_migrations (version, name, applied_at)
VALUES ('0001', 'initial', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  normalized_email TEXT NOT NULL UNIQUE,
  username TEXT,
  normalized_username TEXT UNIQUE,
  password_hash TEXT,
  email_verified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  disabled_at INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER,
  user_agent_hash TEXT,
  ip_hash TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  normalized_email TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('magic_link', 'email_verification', 'password_reset')),
  redirect_to TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  consume_id TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  CHECK (redirect_to IS NULL OR length(redirect_to) <= 2048),
  CHECK (normalized_email IS NULL OR length(normalized_email) <= 320),
  CHECK ((used_at IS NULL AND consume_id IS NULL) OR (used_at IS NOT NULL AND consume_id IS NOT NULL)),
  CHECK (used_at IS NULL OR revoked_at IS NULL),
  CHECK ((revoked_at IS NULL AND revoked_reason IS NULL) OR (revoked_at IS NOT NULL AND revoked_reason IS NOT NULL)),
  CHECK (
    (type IN ('email_verification', 'password_reset') AND user_id IS NOT NULL AND normalized_email IS NULL)
    OR (
      type = 'magic_link'
      AND (
        (user_id IS NOT NULL AND normalized_email IS NULL)
        OR (user_id IS NULL AND normalized_email IS NOT NULL)
      )
    )
  ),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE auth_events (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  event_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent_hash TEXT,
  request_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE rate_limits (
  action TEXT NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (action, key)
);
`;
}

function indexesMigrationSql(): string {
  return `CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
CREATE INDEX sessions_active_lookup_idx ON sessions(token_hash, expires_at, revoked_at);

CREATE INDEX verification_tokens_email_type_idx
  ON verification_tokens(normalized_email, type);

CREATE INDEX verification_tokens_user_type_idx
  ON verification_tokens(user_id, type);

CREATE INDEX verification_tokens_expires_at_idx
  ON verification_tokens(expires_at);

CREATE INDEX verification_tokens_active_user_type_idx
  ON verification_tokens(user_id, type, used_at, revoked_at, expires_at);

CREATE INDEX verification_tokens_active_email_type_idx
  ON verification_tokens(normalized_email, type, used_at, revoked_at, expires_at);

CREATE INDEX auth_events_user_id_idx ON auth_events(user_id);
CREATE INDEX auth_events_created_at_idx ON auth_events(created_at);
CREATE INDEX auth_events_type_created_at_idx ON auth_events(event_type, created_at);

CREATE INDEX rate_limits_reset_at_idx ON rate_limits(reset_at);

INSERT INTO auth_schema_migrations (version, name, applied_at)
VALUES ('0002', 'indexes', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

UPDATE auth_meta
SET value = '2', updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE key = 'schema_version';
`;
}
