import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { base64urlEncode, normalizeEmail } from "@cf-auth/core";
import cliPackageJson from "../package.json" with { type: "json" };

export const cliPackageName = "@cf-auth/cli";
const generatedPackageVersion = cliPackageJson.version;
const supportedWranglerVersion = cliPackageJson.dependencies.wrangler;

export interface CliIO {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  runCommand?: CommandRunner;
}

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

interface CommandRunOptions {
  cwd: string;
  input?: string;
}

interface CommandRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type CommandRunner = (
  command: string,
  args: string[],
  options: CommandRunOptions,
) => CommandRunResult;

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
        const result = await commandDoctor(
          parsed,
          cwd,
          io.runCommand ?? runCommand,
        );
        if (parsed.flags.report) {
          const reportJson = JSON.stringify(result.report, null, 2) + "\n";
          if (typeof parsed.flags.output === "string") {
            const outputPath = resolve(cwd, parsed.flags.output);
            await writeFile(outputPath, reportJson);
            out(`Wrote doctor report to ${outputPath}`);
          } else {
            out(reportJson.trimEnd());
          }
          return result.ok ? 0 : 1;
        }
        for (const line of result.lines) (result.ok ? out : err)(line);
        return result.ok ? 0 : 1;
      }
      case "deploy":
        out(await commandDeploy(parsed, cwd, io.runCommand ?? runCommand));
        return 0;
      case "generate":
        out(commandGenerate(parsed));
        return 0;
      case "rotate-secret":
        out(
          await commandRotateSecret(parsed, cwd, io.runCommand ?? runCommand),
        );
        return 0;
      case "clean":
        out(await commandClean(parsed, cwd, io.runCommand ?? runCommand));
        return 0;
      case "users":
      case "sessions":
        out(await commandRecovery(parsed, cwd, io.runCommand ?? runCommand));
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
      "Would write package.json, pnpm-workspace.yaml, tsconfig.json, auth.config.ts, wrangler.jsonc, migrations, .gitignore, .dev.vars, .dev.vars.example, and route mount snippets.",
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
    JSON.stringify(
      templatePackageJson(packageNameFromTarget(target)),
      null,
      2,
    ) + "\n",
  );
  await writeIfMissing(
    join(target, "pnpm-workspace.yaml"),
    pnpmWorkspaceTemplate(),
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
  const command = await buildMigrateCommand(parsed, cwd);
  return displayCommand(command.command, command.args);
}

async function buildMigrateCommand(
  parsed: ParsedArgs,
  cwd: string,
): Promise<{ command: string; args: string[] }> {
  const config = await readWrangler(cwd);
  const target = targetMode(parsed);
  const database = selectD1(config, parsed.flags.env as string | undefined);
  const status = parsed.flags.status ? "list" : "apply";
  const remoteFlag = target.remote ? "--remote" : "--local";
  if (target.remote && hasNamedEnvironments(config) && !parsed.flags.env) {
    throw new Error(
      "Remote migrations require --env when Wrangler config uses named environments.",
    );
  }
  return {
    command: "wrangler",
    args: [
      "d1",
      "migrations",
      status,
      database.database_name,
      remoteFlag,
      ...(target.remote && parsed.flags.env
        ? ["--env", String(parsed.flags.env)]
        : []),
    ],
  };
}

async function commandDoctor(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
): Promise<{ ok: boolean; lines: string[]; report: DoctorReport }> {
  const checks: DoctorCheck[] = [];
  let ok = true;
  let config: WranglerConfig | null = null;
  let d1: {
    binding: string;
    database_name: string;
    database_id?: string;
  } | null = null;
  const envName = parsed.flags.env as string | undefined;
  const addCheck = (check: DoctorCheck) => {
    checks.push(check);
    if (check.status === "fail") ok = false;
  };
  addCheck(checkWranglerVersion(cwd, runner));
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
  d1 =
    selected?.d1_databases?.find((item) => item.binding === "AUTH_DB") ?? null;
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
  const localMigrationVersions = await readLocalMigrationVersions(cwd);
  if (localMigrationVersions.length === 0) {
    addCheck({
      id: "migration_files",
      status: "fail",
      message: "Local migration files are missing",
      fix: "npx cf-auth@latest init --repair",
    });
  } else {
    addCheck({
      id: "migration_files",
      status: "pass",
      message: "Local migration files found",
    });
  }
  const vars = selected?.vars ?? {};
  const remoteTarget = vars.AUTH_ENV === "production" || Boolean(envName);
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
  if (remoteTarget) {
    addCheck(checkCloudflareAccount(cwd, runner, config));
  }
  if (d1 && localMigrationVersions.length > 0) {
    addCheck(
      checkD1MigrationState({
        cwd,
        runner,
        databaseName: d1.database_name,
        envName,
        remote: remoteTarget,
        localMigrationVersions,
      }),
    );
  }
  if (remoteTarget) {
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
    const secretCheck = checkRemoteSecret(envName, cwd, runner);
    addCheck(secretCheck);
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

function checkWranglerVersion(cwd: string, runner: CommandRunner): DoctorCheck {
  const result = runner("wrangler", ["--version"], { cwd });
  if (result.status !== 0) {
    return {
      id: "wrangler_version",
      status: "fail",
      message: "Wrangler is unavailable",
      fix: `install wrangler ${supportedWranglerVersion} or run inside a project with Wrangler installed`,
    };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const version = output.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (!version) {
    return {
      id: "wrangler_version",
      status: "warn",
      message: "Wrangler version could not be parsed",
      fix: "run wrangler --version and compare it with the supported version matrix",
    };
  }
  if (version !== supportedWranglerVersion) {
    return {
      id: "wrangler_version",
      status: "warn",
      message: `Wrangler ${version} detected; supported version is ${supportedWranglerVersion}`,
      fix: `install wrangler ${supportedWranglerVersion}`,
    };
  }
  return {
    id: "wrangler_version",
    status: "pass",
    message: `Wrangler ${version} available`,
  };
}

function checkCloudflareAccount(
  cwd: string,
  runner: CommandRunner,
  config: WranglerConfig,
): DoctorCheck {
  const result = runner("wrangler", ["whoami", "--json"], { cwd });
  if (result.status !== 0) {
    return {
      id: "cloudflare_account",
      status: "fail",
      message: "Cloudflare login could not be verified",
      fix: "run wrangler login and confirm the selected account with wrangler whoami",
    };
  }
  const account = parseWhoamiResult(result.stdout);
  if (!account.ok) return account.check;
  const configuredAccount = config.account_id?.trim();
  if (configuredAccount) {
    const found = account.accounts.some(
      (item) => item.id === configuredAccount,
    );
    if (!found) {
      return {
        id: "cloudflare_account",
        status: "fail",
        message:
          "Wrangler account_id is not available to the authenticated user",
        fix: "set account_id to an authenticated Cloudflare account or run wrangler login with the correct user",
      };
    }
    return {
      id: "cloudflare_account",
      status: "pass",
      message: "Cloudflare account selection verified",
    };
  }
  if (account.accounts.length > 1) {
    return {
      id: "cloudflare_account",
      status: "warn",
      message: "Multiple Cloudflare accounts available; selection is implicit",
      fix: "set account_id in wrangler.jsonc for reproducible production deploys",
    };
  }
  return {
    id: "cloudflare_account",
    status: "pass",
    message: "Cloudflare login verified",
  };
}

function parseWhoamiResult(
  stdout: string,
):
  | { ok: true; accounts: Array<{ id: string }> }
  | { ok: false; check: DoctorCheck } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      check: {
        id: "cloudflare_account",
        status: "warn",
        message: "Cloudflare account response could not be parsed",
        fix: "run wrangler whoami --json and rerun doctor",
      },
    };
  }
  if (!isRecord(parsed) || parsed.loggedIn !== true) {
    return {
      ok: false,
      check: {
        id: "cloudflare_account",
        status: "fail",
        message: "Cloudflare login could not be verified",
        fix: "run wrangler login and confirm the selected account with wrangler whoami",
      },
    };
  }
  const accounts = Array.isArray(parsed.accounts)
    ? parsed.accounts.flatMap((item) => {
        if (!isRecord(item) || typeof item.id !== "string") return [];
        return [{ id: item.id }];
      })
    : [];
  if (accounts.length === 0) {
    return {
      ok: false,
      check: {
        id: "cloudflare_account",
        status: "fail",
        message: "No Cloudflare account is available to Wrangler",
        fix: "run wrangler login with a user or token that can access the target account",
      },
    };
  }
  return { ok: true, accounts };
}

function checkD1MigrationState(options: {
  cwd: string;
  runner: CommandRunner;
  databaseName: string;
  envName: string | undefined;
  remote: boolean;
  localMigrationVersions: string[];
}): DoctorCheck {
  const modeFlag = options.remote ? "--remote" : "--local";
  const result = options.runner(
    "wrangler",
    [
      "d1",
      "execute",
      options.databaseName,
      modeFlag,
      ...(options.remote && options.envName ? ["--env", options.envName] : []),
      "--json",
      "--command",
      migrationStateSql(),
    ],
    { cwd: options.cwd },
  );
  const target = options.remote ? "remote" : "local";
  if (result.status !== 0) {
    return {
      id: "d1_migrations",
      status: "fail",
      message: `D1 ${target} migration state could not be read`,
      fix: migrationFix(options.remote, options.envName),
    };
  }
  const remoteState = parseD1MigrationState(result.stdout);
  if (!remoteState.ok) return remoteState.check;
  const applied = new Set(remoteState.versions);
  const missing = options.localMigrationVersions.filter(
    (version) => !applied.has(version),
  );
  if (missing.length > 0) {
    return {
      id: "d1_migrations",
      status: "fail",
      message: `D1 migration ${missing[0]} has not been applied ${target}ly`,
      fix: migrationFix(options.remote, options.envName),
    };
  }
  const latest = options.localMigrationVersions.at(-1);
  const expectedSchemaVersion = latest
    ? String(Number.parseInt(latest, 10))
    : undefined;
  if (
    expectedSchemaVersion &&
    remoteState.schemaVersion !== expectedSchemaVersion
  ) {
    return {
      id: "d1_migrations",
      status: "fail",
      message: `D1 auth_meta schema_version is ${remoteState.schemaVersion ?? "missing"}; expected ${expectedSchemaVersion}`,
      fix: migrationFix(options.remote, options.envName),
    };
  }
  return {
    id: "d1_migrations",
    status: "pass",
    message: `D1 migrations are applied ${target}ly`,
  };
}

function migrationStateSql(): string {
  return "SELECT version FROM auth_schema_migrations ORDER BY version; SELECT value FROM auth_meta WHERE key = 'schema_version';";
}

function migrationFix(remote: boolean, envName: string | undefined): string {
  return remote
    ? `npx cf-auth@latest migrate --remote${envName ? ` --env ${envName}` : ""}`
    : "npx cf-auth@latest migrate --local";
}

function parseD1MigrationState(
  stdout: string,
):
  | { ok: true; versions: string[]; schemaVersion: string | undefined }
  | { ok: false; check: DoctorCheck } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return {
      ok: false,
      check: {
        id: "d1_migrations",
        status: "fail",
        message: "D1 migration state response could not be parsed",
        fix: "rerun doctor after confirming wrangler d1 execute --json works",
      },
    };
  }
  const state = collectD1MigrationState(parsed);
  return { ok: true, ...state };
}

function collectD1MigrationState(value: unknown): {
  versions: string[];
  schemaVersion: string | undefined;
} {
  const versions = new Set<string>();
  let schemaVersion: string | undefined;
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!isRecord(item)) return;
    if (typeof item.version === "string") versions.add(item.version);
    if (typeof item.value === "string") schemaVersion = item.value;
    for (const key of ["result", "results"]) visit(item[key]);
  };
  visit(value);
  return { versions: [...versions].sort(), schemaVersion };
}

async function commandDeploy(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
): Promise<string> {
  const envName = parsed.flags.env as string | undefined;
  const config = await readWrangler(cwd);
  if (hasNamedEnvironments(config) && !envName) {
    throw new Error(
      "Deploy requires --env when Wrangler config uses named environments.",
    );
  }
  const selected = envName ? config.env?.[envName] : config;
  if (!envName && selected?.vars?.AUTH_ENV !== "production") {
    throw new Error(
      "Deploy without --env requires top-level vars.AUTH_ENV=production.",
    );
  }
  const doctor = await commandDoctor(parsed, cwd, runner);
  if (!doctor.ok) {
    throw new Error(`doctor failed before deploy:\n${doctor.lines.join("\n")}`);
  }
  const migrationStatus = await buildMigrateCommand(
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
  const deployCommand = {
    command: "wrangler",
    args: ["deploy", ...(envName ? ["--env", envName] : [])],
  };
  const planned = [
    `doctor --env ${envName ?? "default"}: ok`,
    displayCommand(migrationStatus.command, migrationStatus.args),
    displayCommand(deployCommand.command, deployCommand.args),
  ];
  if (parsed.flags["dry-run"]) return planned.join("\n");

  const lines = [planned[0]];
  lines.push(runCheckedCommand(migrationStatus, cwd, runner));
  if (parsed.flags.migrate) {
    const migrateApply = await buildMigrateCommand(
      {
        command: "migrate",
        positionals: [],
        flags: {
          remote: true,
          ...(envName ? { env: envName } : {}),
        },
      },
      cwd,
    );
    lines.push(runCheckedCommand(migrateApply, cwd, runner));
  }
  lines.push(runCheckedCommand(deployCommand, cwd, runner));
  lines.push(`deployed with wrangler${envFlag}`);
  return lines.join("\n");
}

function runCommand(
  command: string,
  args: string[],
  options: CommandRunOptions,
): CommandRunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runCheckedCommand(
  command: { command: string; args: string[] },
  cwd: string,
  runner: CommandRunner,
  input?: string,
): string {
  const result = runner(
    command.command,
    command.args,
    input === undefined ? { cwd } : { cwd, input },
  );
  const display = displayCommand(command.command, command.args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      detail
        ? `Command failed: ${display}\n${detail}`
        : `Command failed: ${display}`,
    );
  }
  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  return output ? `${display}\n${output}` : display;
}

function checkRemoteSecret(
  envName: string | undefined,
  cwd: string,
  runner: CommandRunner,
): DoctorCheck {
  const args = [
    "secret",
    "list",
    "--format",
    "json",
    ...(envName ? ["--env", envName] : []),
  ];
  const result = runner("wrangler", args, { cwd });
  if (result.status !== 0) {
    return {
      id: "remote_secret",
      status: "fail",
      message: "Remote AUTH_SECRET could not be verified",
      fix: "run wrangler login, then npx cf-auth@latest rotate-secret --apply --env production",
    };
  }
  const names = parseSecretNames(result.stdout);
  if (!names.has("AUTH_SECRET")) {
    return {
      id: "remote_secret",
      status: "fail",
      message: "AUTH_SECRET is missing remotely",
      fix: "npx cf-auth@latest rotate-secret --apply --env production",
    };
  }
  return {
    id: "remote_secret",
    status: "pass",
    message: "Remote AUTH_SECRET configured",
  };
}

function parseSecretNames(text: string): Set<string> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed
        .map((item) => {
          if (typeof item === "string") return item;
          if (
            typeof item === "object" &&
            item !== null &&
            "name" in item &&
            typeof item.name === "string"
          ) {
            return item.name;
          }
          return "";
        })
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

function displayCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
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

async function commandRotateSecret(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
): Promise<string> {
  const kid = typeof parsed.flags.kid === "string" ? parsed.flags.kid : "k1";
  const secret = `${kid}.${base64urlEncode(randomBytes(32))}`;
  if (parsed.flags.apply) {
    const envName = parsed.flags.env as string | undefined;
    const config = await readWrangler(cwd);
    if (hasNamedEnvironments(config) && !envName) {
      throw new Error(
        "rotate-secret --apply requires --env when Wrangler config uses named environments.",
      );
    }
    const lines: string[] = [];
    const previous = await resolvePreviousSecret(parsed);
    if (previous) {
      const previousCommand = {
        command: "wrangler",
        args: [
          "secret",
          "put",
          "AUTH_SECRET_PREVIOUS",
          ...(envName ? ["--env", envName] : []),
        ],
      };
      lines.push(runCheckedCommand(previousCommand, cwd, runner, previous));
      lines.push("Remote AUTH_SECRET_PREVIOUS updated.");
    } else {
      lines.push(
        "Warning: previous secret was not provided; existing sessions and email tokens will be invalidated.",
      );
    }
    const command = {
      command: "wrangler",
      args: [
        "secret",
        "put",
        "AUTH_SECRET",
        ...(envName ? ["--env", envName] : []),
      ],
    };
    lines.push(runCheckedCommand(command, cwd, runner, secret));
    lines.push("Remote AUTH_SECRET updated.");
    return lines.join("\n");
  }
  return `AUTH_SECRET=${secret}`;
}

async function resolvePreviousSecret(
  parsed: ParsedArgs,
): Promise<string | null> {
  if (parsed.flags["previous-from-stdin"]) {
    const value = (await readStdin()).trim();
    if (!value) throw new Error("previous secret from stdin was empty");
    return value;
  }
  if (typeof parsed.flags["previous-from-env"] === "string") {
    const envName = parsed.flags["previous-from-env"];
    const value = process.env[envName]?.trim();
    if (!value) throw new Error(`environment variable ${envName} is empty`);
    return value;
  }
  return null;
}

async function readStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) {
    value += String(chunk);
  }
  return value;
}

async function commandClean(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
): Promise<string> {
  const context = await d1CommandContext(parsed, cwd, "Remote cleanup");
  const command = buildD1ExecuteCommand(context, cleanupSql(Date.now()));
  const display = displayD1ExecuteCommand(context, "<redacted cleanup SQL>");
  if (parsed.flags["dry-run"]) {
    return [
      "Dry run only. Would execute cleanup with default retention windows.",
      display,
    ].join("\n");
  }
  const result = runCheckedCommand(command, cwd, runner);
  return `${result}\ncleanup completed`;
}

function cleanupSql(now: number): string {
  const day = 24 * 60 * 60 * 1000;
  const sessionCutoff = now - 7 * day;
  const tokenCutoff = now - 7 * day;
  const rateLimitCutoff = now - day;
  const eventCutoff = now - 90 * day;
  return [
    `DELETE FROM sessions WHERE expires_at < ${sessionCutoff} OR (revoked_at IS NOT NULL AND revoked_at < ${sessionCutoff})`,
    `DELETE FROM verification_tokens WHERE expires_at < ${tokenCutoff} OR (used_at IS NOT NULL AND used_at < ${tokenCutoff}) OR (revoked_at IS NOT NULL AND revoked_at < ${tokenCutoff})`,
    `DELETE FROM rate_limits WHERE reset_at < ${rateLimitCutoff}`,
    `DELETE FROM auth_events WHERE created_at < ${eventCutoff}`,
  ].join("; ");
}

async function commandRecovery(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
): Promise<string> {
  const context = await d1CommandContext(parsed, cwd, "Remote recovery");
  if (parsed.command === "users") {
    return commandUsers(parsed, cwd, runner, context);
  }
  return commandSessions(parsed, cwd, runner, context);
}

function commandUsers(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
  context: D1CommandContext,
): string {
  const action = parsed.positionals[0];
  const identifier = parsed.positionals[1];
  if (action !== "disable" && action !== "enable") {
    throw new Error("users command requires disable or enable.");
  }
  if (!identifier) {
    throw new Error("users command requires a user id or email.");
  }
  const now = Date.now();
  const target = userWhereClause(identifier);
  const sql =
    action === "disable"
      ? [
          `UPDATE users SET disabled_at = ${now}, updated_at = ${now} WHERE ${target}`,
          `UPDATE sessions SET revoked_at = ${now} WHERE user_id IN (SELECT id FROM users WHERE ${target}) AND revoked_at IS NULL`,
        ].join("; ")
      : `UPDATE users SET disabled_at = NULL, updated_at = ${now} WHERE ${target}`;
  if (parsed.flags["dry-run"]) {
    return `Dry run only. Would ${action} the matched user without printing identifiers, tokens, hashes, cookies, raw IPs, or raw user agents.`;
  }
  const result = runRedactedRecoveryCommand(
    buildD1ExecuteCommand(context, sql),
    cwd,
    runner,
  );
  return `${result}\nuser ${action} completed`;
}

function commandSessions(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
  context: D1CommandContext,
): string {
  const action = parsed.positionals[0];
  if (action !== "revoke" && action !== "list") {
    throw new Error("sessions command requires revoke or list.");
  }
  if (typeof parsed.flags.user !== "string") {
    throw new Error("sessions command requires --user <user-id-or-email>.");
  }
  const target = userWhereClause(parsed.flags.user);
  if (action === "revoke") {
    const now = Date.now();
    const sql = `UPDATE sessions SET revoked_at = ${now} WHERE user_id IN (SELECT id FROM users WHERE ${target}) AND revoked_at IS NULL`;
    if (parsed.flags["dry-run"]) {
      return "Dry run only. Would revoke matched user sessions without printing tokens, hashes, cookies, raw IPs, or raw user agents.";
    }
    const result = runRedactedRecoveryCommand(
      buildD1ExecuteCommand(context, sql),
      cwd,
      runner,
    );
    return `${result}\nsessions revoke completed`;
  }
  const limit = parseLimit(parsed.flags.limit);
  const sql = `SELECT id, created_at, expires_at, revoked_at, last_seen_at FROM sessions WHERE user_id IN (SELECT id FROM users WHERE ${target}) ORDER BY created_at DESC LIMIT ${limit}`;
  const result = runner(
    "wrangler",
    buildD1ExecuteCommand(context, sql, true).args,
    { cwd },
  );
  if (result.status !== 0) {
    throw new Error(
      "Command failed: wrangler d1 execute <redacted recovery SQL>",
    );
  }
  return renderSessionList(parseD1Rows(result.stdout));
}

function runRedactedRecoveryCommand(
  command: { command: string; args: string[] },
  cwd: string,
  runner: CommandRunner,
): string {
  const result = runner(command.command, command.args, { cwd });
  if (result.status !== 0) {
    throw new Error(
      "Command failed: wrangler d1 execute <redacted recovery SQL>",
    );
  }
  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  return output
    ? `wrangler d1 execute <redacted recovery SQL>\n${output}`
    : "wrangler d1 execute <redacted recovery SQL>";
}

interface D1CommandContext {
  databaseName: string;
  remote: boolean;
  envName?: string;
}

async function d1CommandContext(
  parsed: ParsedArgs,
  cwd: string,
  remoteErrorPrefix: string,
): Promise<D1CommandContext> {
  const target = targetMode(parsed);
  const envName = parsed.flags.env as string | undefined;
  const config = await readWrangler(cwd);
  if (target.remote && hasNamedEnvironments(config) && !envName) {
    throw new Error(
      `${remoteErrorPrefix} requires --env when Wrangler config uses named environments.`,
    );
  }
  const database = selectD1(config, envName);
  return {
    databaseName: database.database_name,
    remote: target.remote,
    ...(envName ? { envName } : {}),
  };
}

function buildD1ExecuteCommand(
  context: D1CommandContext,
  sql: string,
  json = false,
): { command: string; args: string[] } {
  return {
    command: "wrangler",
    args: [
      "d1",
      "execute",
      context.databaseName,
      context.remote ? "--remote" : "--local",
      ...(context.remote && context.envName ? ["--env", context.envName] : []),
      "--yes",
      ...(json ? ["--json"] : []),
      "--command",
      sql,
    ],
  };
}

function displayD1ExecuteCommand(
  context: D1CommandContext,
  sqlDisplay: string,
): string {
  return `wrangler d1 execute ${context.databaseName} ${context.remote ? "--remote" : "--local"}${context.remote && context.envName ? ` --env ${context.envName}` : ""} --command ${sqlDisplay}`;
}

function userWhereClause(identifier: string): string {
  if (identifier.includes("@")) {
    return `normalized_email = ${sqlStringLiteral(normalizeEmail(identifier))}`;
  }
  return `id = ${sqlStringLiteral(identifier)}`;
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function parseLimit(value: string | boolean | undefined): number {
  if (value === undefined || value === false) return 20;
  if (value === true) {
    throw new Error("sessions list --limit requires a value.");
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("sessions list --limit must be an integer from 1 to 100.");
  }
  return parsed;
}

function parseD1Rows(stdout: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("D1 JSON response could not be parsed.");
  }
  const rows: Array<Record<string, unknown>> = [];
  const visit = (item: unknown) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!isRecord(item)) return;
    if ("id" in item) rows.push(item);
    for (const key of ["result", "results"]) visit(item[key]);
  };
  visit(parsed);
  return rows;
}

function renderSessionList(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "No sessions found.";
  return rows
    .map((row) =>
      [
        `id=${String(row.id ?? "")}`,
        `created_at=${String(row.created_at ?? "")}`,
        `expires_at=${String(row.expires_at ?? "")}`,
        `revoked_at=${String(row.revoked_at ?? "null")}`,
        `last_seen_at=${String(row.last_seen_at ?? "null")}`,
      ].join(" "),
    )
    .join("\n");
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
  account_id?: string;
  vars?: Record<string, string>;
  send_email?: Array<{ name: string }>;
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    database_id?: string;
  }>;
  env?: Record<string, WranglerConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readLocalMigrationVersions(cwd: string): Promise<string[]> {
  try {
    const files = await readdir(join(cwd, "migrations"));
    return files
      .flatMap((file) => {
        const match = file.match(/^(\d+)_.*\.sql$/);
        return match?.[1] ? [match[1]] : [];
      })
      .sort();
  } catch {
    return [];
  }
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

function packageNameFromTarget(target: string): string {
  return (
    basename(target)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "cf-auth-app"
  );
}

function templatePackageJson(name: string) {
  return {
    name,
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
    pnpm: {
      onlyBuiltDependencies: ["esbuild", "sharp", "workerd"],
    },
  };
}

function pnpmWorkspaceTemplate(): string {
  return `allowBuilds:
  esbuild: true
  sharp: true
  workerd: true
`;
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
      "database_id": "local-development"
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
