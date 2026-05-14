import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  base64urlEncode,
  normalizeEmail,
  passwordHashProfiles,
  type PasswordHashProfileName,
  parseAuthKeyRing,
  redactLogValue,
  assertValidSessionCookieDomain,
  assertValidSessionCookieName,
  resolveSessionCookie,
} from "@cf-auth/core";
import cliPackageJson from "../package.json" with { type: "json" };
import {
  runWorkersPasswordBenchmark,
  type PasswordBenchmarkResult,
} from "./password-benchmark.js";

export const cliPackageName = "@cf-auth/cli";
const generatedPackageVersion = cliPackageJson.version;
const supportedWranglerVersion = cliPackageJson.dependencies.wrangler;
const wranglerSchemaPath = "./node_modules/wrangler/config-schema.json";
const workersCompatibilityDate = "2026-05-14";
const workersCompatibilityDateFloor = "2024-09-23";
const workersNodeCompatibilityFlag = "nodejs_compat";
const passwordBenchmarkCache = new Map<
  PasswordHashProfileName,
  Promise<PasswordBenchmarkResult<PasswordHashProfileName>>
>();

export interface CliIO {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  runCommand?: CommandRunner;
  benchmarkPasswordProfile?: PasswordBenchmarkRunner;
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

type InitTemplate = "hono-basic" | "worker-basic";

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

type PasswordBenchmarkRunner = (
  profile: PasswordHashProfileName,
) => Promise<PasswordBenchmarkResult<PasswordHashProfileName>>;

export async function runCli(
  args = process.argv.slice(2),
  io: CliIO = {},
): Promise<number> {
  const parsed = parseArgs(args);
  const out = io.stdout ?? console.log;
  const err = io.stderr ?? console.error;
  const cwd = io.cwd ?? process.cwd();
  const passwordBenchmark =
    io.benchmarkPasswordProfile ?? benchmarkPasswordProfile;
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
        out(await commandMigrate(parsed, cwd, io.runCommand ?? runCommand));
        return 0;
      case "doctor": {
        const result = await commandDoctor(
          parsed,
          cwd,
          io.runCommand ?? runCommand,
          passwordBenchmark,
          {},
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
        out(
          await commandDeploy(
            parsed,
            cwd,
            io.runCommand ?? runCommand,
            passwordBenchmark,
          ),
        );
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
  const template = resolveInitTemplate(parsed.flags.template);
  const target = resolve(cwd, parsed.positionals[0] ?? ".");
  const packageName = packageNameFromTarget(target);
  const workerName = workerNameFromTarget(target);
  if (parsed.flags["dry-run"]) {
    out(
      `Would write ${template} package.json, pnpm-workspace.yaml, tsconfig.json, auth.config.ts, wrangler.jsonc, migrations, .gitignore, .dev.vars, .dev.vars.example, and route mount snippets.`,
    );
    out(templateMountSnippet(template));
    return;
  }
  await mkdir(join(target, "src"), { recursive: true });
  await mkdir(join(target, "migrations"), { recursive: true });
  const localSecret = `k_dev.${base64urlEncode(randomBytes(32))}`;
  const packageResult = await writeOrPatchPackageJson(
    join(target, "package.json"),
    packageName,
    template,
  );
  const wranglerConfigPath =
    existingWranglerPath(target) ?? join(target, "wrangler.jsonc");
  const sourceIndexPath = join(target, "src", "index.ts");
  const sourceIndexExists = existsSync(sourceIndexPath);
  await writeIfMissing(
    join(target, "pnpm-workspace.yaml"),
    pnpmWorkspaceTemplate(),
  );
  await writeIfMissing(join(target, "tsconfig.json"), tsconfigTemplate());
  await writeIfMissing(
    join(target, "src", "auth.config.ts"),
    authConfigTemplate(),
  );
  await writeIfMissing(sourceIndexPath, indexTemplate(template));
  await writeIfMissing(wranglerConfigPath, wranglerTemplate(workerName));
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
  const repaired = await repairWranglerConfig(target, workerName);
  if (repaired) out("Repaired Wrangler auth bindings and vars.");
  out(`Initialized Cloudflare Auth in ${target}`);
  if (packageResult === "updated")
    out("Updated package.json with Cloudflare Auth dependencies.");
  if (sourceIndexExists) {
    out(
      "Existing src/index.ts was left unchanged. Add this auth mount once if it is not already present:",
    );
    out(templateMountSnippet(template));
  }
  out(
    "Next: pnpm install && npx --package @cf-auth/cli@latest cf-auth migrate --local && npm run dev",
  );
}

async function commandMigrate(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
): Promise<string> {
  const command = await buildMigrateCommand(parsed, cwd);
  if (parsed.flags["dry-run"])
    return displayCommand(command.command, command.args);
  const lines = [runCheckedCommand(command, cwd, runner)];
  if (!parsed.flags.status) {
    const target = targetMode(parsed);
    const envName = parsed.flags.env as string | undefined;
    const config = await readWrangler(cwd);
    const database = selectD1(config, envName);
    const localMigrationVersions = await readLocalMigrationVersions(cwd);
    if (localMigrationVersions.length > 0) {
      const check = checkD1MigrationState({
        cwd,
        runner,
        databaseName: database.database_name,
        envName,
        remote: target.remote,
        localMigrationVersions,
      });
      if (check.status !== "pass") {
        throw new Error(
          [check.message, check.fix ? `Fix: ${check.fix}` : ""]
            .filter(Boolean)
            .join("\n"),
        );
      }
      lines.push(check.message);
    }
  }
  return lines.join("\n");
}

async function buildMigrateCommand(
  parsed: ParsedArgs,
  cwd: string,
): Promise<{ command: string; args: string[] }> {
  const config = await readWrangler(cwd);
  const target = targetMode(parsed);
  const envName = parsed.flags.env as string | undefined;
  if (target.remote && !envName) {
    if (hasNamedEnvironments(config)) {
      throw new Error(
        "Remote migrations require --env when Wrangler config uses named environments.",
      );
    }
    if (config.vars?.AUTH_ENV !== "production") {
      throw new Error(
        "Remote migrations without --env require top-level vars.AUTH_ENV=production.",
      );
    }
  }
  const database = selectD1(config, envName);
  const status = parsed.flags.status ? "list" : "apply";
  const remoteFlag = target.remote ? "--remote" : "--local";
  return {
    command: "wrangler",
    args: [
      "d1",
      "migrations",
      status,
      database.database_name,
      remoteFlag,
      ...(target.remote && envName ? ["--env", envName] : []),
    ],
  };
}

async function commandDoctor(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
  passwordBenchmark: PasswordBenchmarkRunner,
  options: { allowPendingMigrations?: boolean },
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
      fix: "npx --package @cf-auth/cli@latest cf-auth init --repair",
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
  for (const check of checkWorkersCompatibility(config, selected ?? config)) {
    addCheck(check);
  }
  d1 =
    selected?.d1_databases?.find((item) => item.binding === "AUTH_DB") ?? null;
  if (!d1) {
    addCheck({
      id: "d1_binding",
      status: "fail",
      message: "D1 binding AUTH_DB is missing",
      fix: "npx --package @cf-auth/cli@latest cf-auth init --repair or add d1_databases binding AUTH_DB",
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
      fix: "npx --package @cf-auth/cli@latest cf-auth init --repair",
    });
  } else {
    addCheck({
      id: "migration_files",
      status: "pass",
      message: "Local migration files found",
    });
  }
  const vars = selected?.vars ?? {};
  const remoteTarget =
    vars.AUTH_ENV === "preview" ||
    vars.AUTH_ENV === "production" ||
    Boolean(envName);
  if (!vars.AUTH_ENV) {
    addCheck({
      id: "auth_env",
      status: "fail",
      message: "AUTH_ENV is missing",
      fix: "set vars.AUTH_ENV to development, preview, or production",
    });
  } else if (!isAuthMode(vars.AUTH_ENV)) {
    addCheck({
      id: "auth_env",
      status: "fail",
      message: "AUTH_ENV must be development, preview, or production",
      fix: "set vars.AUTH_ENV to development, preview, or production",
    });
  } else {
    addCheck({
      id: "auth_env",
      status: "pass",
      message: "AUTH_ENV configured",
    });
  }
  if (remoteTarget && !vars.AUTH_PUBLIC_ORIGIN) {
    addCheck({
      id: "public_origin",
      status: "fail",
      message:
        vars.AUTH_ENV === "preview"
          ? "Preview public origin is missing"
          : "Production public origin is missing",
      fix: "set AUTH_PUBLIC_ORIGIN=https://example.com",
    });
  } else if (vars.AUTH_PUBLIC_ORIGIN) {
    addCheck({
      id: "public_origin",
      status: "pass",
      message: "Public origin configured",
    });
  }
  const cookieCheck = checkCookieConfig(vars);
  if (cookieCheck) addCheck(cookieCheck);
  const packageCheck = await checkPackageVersions(cwd, remoteTarget);
  if (packageCheck) addCheck(packageCheck);
  const authSource = await inspectAuthSource(cwd);
  for (const check of checkAuthSource(authSource, vars, remoteTarget)) {
    addCheck(check);
  }
  addCheck(
    await checkPasswordBenchmark(authSource, remoteTarget, passwordBenchmark),
  );
  if (remoteTarget) {
    addCheck(checkCloudflareAccount(cwd, runner, config));
  }
  if (d1 && localMigrationVersions.length > 0) {
    const migrationCheck = checkD1MigrationState({
      cwd,
      runner,
      databaseName: d1.database_name,
      envName,
      remote: remoteTarget,
      localMigrationVersions,
    });
    addCheck(
      options.allowPendingMigrations && isPendingMigrationCheck(migrationCheck)
        ? {
            ...migrationCheck,
            status: "warn",
            fix: "pending migrations will be applied before deploy",
          }
        : migrationCheck,
    );
  }
  if (remoteTarget) {
    const localSecretNames = await readLocalSecretNames(cwd);
    const email = sourceUsesCloudflareEmail(authSource)
      ? selected?.send_email?.find((item) => item.name === "AUTH_EMAIL")
      : "not-required";
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
        message:
          email === "not-required"
            ? "Cloudflare Email binding not required by inspected auth config"
            : "Cloudflare Email binding AUTH_EMAIL configured",
      });
    }
    const secretCheck = checkRemoteSecret(
      envName,
      cwd,
      runner,
      localSecretNames.has("AUTH_SECRET"),
    );
    addCheck(secretCheck);
    if (localSecretNames.has("AUTH_SECRET_PREVIOUS")) {
      addCheck(
        checkRemoteSecretName({
          name: "AUTH_SECRET_PREVIOUS",
          envName,
          cwd,
          runner,
          missingMessage:
            "AUTH_SECRET_PREVIOUS exists in .dev.vars but is missing remotely",
          unavailableMessage:
            "Remote AUTH_SECRET_PREVIOUS could not be verified",
          passMessage: "Remote AUTH_SECRET_PREVIOUS configured",
          fix: `wrangler secret put AUTH_SECRET_PREVIOUS${envName ? ` --env ${envName}` : ""}`,
        }),
      );
    }
    if (authSource.turnstileRequiresSecret) {
      addCheck(
        checkRemoteSecretName({
          name: "TURNSTILE_SECRET_KEY",
          envName,
          cwd,
          runner,
          missingMessage: "TURNSTILE_SECRET_KEY is missing remotely",
          unavailableMessage:
            "Remote TURNSTILE_SECRET_KEY could not be verified",
          passMessage: "Remote TURNSTILE_SECRET_KEY configured",
          fix: `wrangler secret put TURNSTILE_SECRET_KEY${envName ? ` --env ${envName}` : ""}`,
        }),
      );
    }
  }
  if (!envName) {
    for (const check of await checkLocalSecrets(cwd)) addCheck(check);
    if (authSource.turnstileRequiresSecret) {
      addCheck(await checkLocalNamedSecret(cwd, "TURNSTILE_SECRET_KEY"));
    }
  }
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

function checkWorkersCompatibility(
  root: WranglerConfig,
  selected: WranglerConfig,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const rawCompatibilityDate =
    selected.compatibility_date ?? root.compatibility_date;
  const compatibilityDate =
    typeof rawCompatibilityDate === "string" ? rawCompatibilityDate : undefined;
  const rawCompatibilityFlags =
    selected.compatibility_flags ?? root.compatibility_flags;
  const compatibilityFlags = Array.isArray(rawCompatibilityFlags)
    ? rawCompatibilityFlags.filter(
        (flag): flag is string => typeof flag === "string",
      )
    : [];

  if (!compatibilityDate) {
    checks.push({
      id: "workers_compatibility_date",
      status: "fail",
      message: "Workers compatibility_date is missing",
      fix: `set compatibility_date to ${workersCompatibilityDate} or later`,
    });
  } else if (!isCompatibilityDate(compatibilityDate)) {
    checks.push({
      id: "workers_compatibility_date",
      status: "fail",
      message: "Workers compatibility_date must use YYYY-MM-DD format",
      fix: `set compatibility_date to ${workersCompatibilityDate} or later`,
    });
  } else if (compatibilityDate < workersCompatibilityDateFloor) {
    checks.push({
      id: "workers_compatibility_date",
      status: "fail",
      message: `Workers compatibility_date ${compatibilityDate} is below required floor ${workersCompatibilityDateFloor}`,
      fix: `set compatibility_date to ${workersCompatibilityDate} or later`,
    });
  } else {
    checks.push({
      id: "workers_compatibility_date",
      status: "pass",
      message: `Workers compatibility_date ${compatibilityDate} configured`,
    });
  }

  if (!compatibilityFlags.includes(workersNodeCompatibilityFlag)) {
    checks.push({
      id: "workers_node_compat",
      status: "fail",
      message: "Workers nodejs_compat compatibility flag is missing",
      fix: `add ${workersNodeCompatibilityFlag} to compatibility_flags in wrangler.jsonc`,
    });
  } else {
    checks.push({
      id: "workers_node_compat",
      status: "pass",
      message: "Workers nodejs_compat compatibility flag configured",
    });
  }

  return checks;
}

function isCompatibilityDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value);
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

function isPendingMigrationCheck(check: DoctorCheck): boolean {
  return (
    check.id === "d1_migrations" &&
    check.status === "fail" &&
    /\bhas not been applied\b/u.test(check.message)
  );
}

function migrationStateSql(): string {
  return "SELECT version FROM auth_schema_migrations ORDER BY version; SELECT value FROM auth_meta WHERE key = 'schema_version';";
}

function migrationFix(remote: boolean, envName: string | undefined): string {
  return remote
    ? `npx --package @cf-auth/cli@latest cf-auth migrate --remote${envName ? ` --env ${envName}` : ""}`
    : "npx --package @cf-auth/cli@latest cf-auth migrate --local";
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
  passwordBenchmark: PasswordBenchmarkRunner,
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
  const doctor = await commandDoctor(parsed, cwd, runner, passwordBenchmark, {
    allowPendingMigrations: Boolean(parsed.flags.migrate),
  });
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
    const database = selectD1(config, envName);
    const localMigrationVersions = await readLocalMigrationVersions(cwd);
    const migrationCheck = checkD1MigrationState({
      cwd,
      runner,
      databaseName: database.database_name,
      envName,
      remote: true,
      localMigrationVersions,
    });
    if (migrationCheck.status !== "pass") {
      throw new Error(
        [
          migrationCheck.message,
          migrationCheck.fix ? `Fix: ${migrationCheck.fix}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    }
    lines.push(migrationCheck.message);
  }
  lines.push(runCheckedCommand(deployCommand, cwd, runner));
  lines.push(`deployed with wrangler${envFlag}`);
  lines.push(deploymentSummary());
  return lines.join("\n");
}

function deploymentSummary(): string {
  return [
    "Auth endpoints:",
    "- /auth/signup",
    "- /auth/login",
    "- /auth/logout",
    "- /auth/user",
    "- /auth/magic-link/request",
    "- /auth/password/reset/request",
    "- /auth/email/verify/request",
    "Cloudflare Email/DNS: verify sender and domain readiness in docs/cloudflare-email.md.",
  ].join("\n");
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
    const detail = redactCliOutput((result.stderr || result.stdout).trim());
    throw new Error(
      detail
        ? `Command failed: ${display}\n${detail}`
        : `Command failed: ${display}`,
    );
  }
  const output = redactCliOutput(
    [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"),
  );
  return output ? `${display}\n${output}` : display;
}

function checkRemoteSecret(
  envName: string | undefined,
  cwd: string,
  runner: CommandRunner,
  localOnly: boolean,
): DoctorCheck {
  const envFlag = envName ? ` --env ${envName}` : "";
  return checkRemoteSecretName({
    name: "AUTH_SECRET",
    envName,
    cwd,
    runner,
    missingMessage: localOnly
      ? "AUTH_SECRET exists in .dev.vars but is missing remotely"
      : "AUTH_SECRET is missing remotely",
    unavailableMessage: "Remote AUTH_SECRET could not be verified",
    passMessage: "Remote AUTH_SECRET configured",
    fix: `npx --package @cf-auth/cli@latest cf-auth rotate-secret --apply${envFlag}`,
    unavailableFix: `run wrangler login, then npx --package @cf-auth/cli@latest cf-auth rotate-secret --apply${envFlag}`,
  });
}

function checkRemoteSecretName(input: {
  name: string;
  envName: string | undefined;
  cwd: string;
  runner: CommandRunner;
  unavailableMessage: string;
  missingMessage: string;
  passMessage: string;
  fix: string;
  unavailableFix?: string;
}): DoctorCheck {
  const args = [
    "secret",
    "list",
    "--format",
    "json",
    ...(input.envName ? ["--env", input.envName] : []),
  ];
  const result = input.runner("wrangler", args, { cwd: input.cwd });
  if (result.status !== 0) {
    return {
      id: remoteSecretCheckId(input.name),
      status: "fail",
      message: input.unavailableMessage,
      fix: input.unavailableFix ?? input.fix,
    };
  }
  const names = parseSecretNames(result.stdout);
  if (!names.has(input.name)) {
    return {
      id: remoteSecretCheckId(input.name),
      status: "fail",
      message: input.missingMessage,
      fix: input.fix,
    };
  }
  return {
    id: remoteSecretCheckId(input.name),
    status: "pass",
    message: input.passMessage,
  };
}

function remoteSecretCheckId(name: string): string {
  if (name === "AUTH_SECRET") return "remote_secret";
  if (name === "AUTH_SECRET_PREVIOUS") return "remote_previous_secret";
  if (name === "TURNSTILE_SECRET_KEY") return "turnstile_secret";
  return "remote_secret";
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

function checkCookieConfig(vars: Record<string, string>): DoctorCheck | null {
  const mode = vars.AUTH_ENV;
  if (!isAuthMode(mode)) return null;
  const origin = vars.AUTH_PUBLIC_ORIGIN;
  if (!origin) {
    return mode === "development"
      ? {
          id: "cookie_config",
          status: "warn",
          message: "Development public origin is missing",
          fix: "set AUTH_PUBLIC_ORIGIN=http://localhost:8787",
        }
      : null;
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return {
      id: "cookie_config",
      status: "fail",
      message: "AUTH_PUBLIC_ORIGIN is not a valid URL",
      fix: "set AUTH_PUBLIC_ORIGIN to an exact origin such as https://example.com",
    };
  }
  if (mode !== "development" && url.protocol !== "https:") {
    return {
      id: "cookie_config",
      status: "fail",
      message: "Preview and production public origins must use HTTPS",
      fix: "set AUTH_PUBLIC_ORIGIN to an https:// origin",
    };
  }
  if (!isExactPublicOriginForDoctor(origin, mode)) {
    return {
      id: "cookie_config",
      status: "fail",
      message: "AUTH_PUBLIC_ORIGIN must be an exact origin",
      fix: "set AUTH_PUBLIC_ORIGIN to an exact origin such as https://example.com",
    };
  }
  try {
    resolveSessionCookie({
      mode,
      requestOrigin: origin,
      cookieName: "auto",
    });
  } catch {
    return {
      id: "cookie_config",
      status: "fail",
      message: "Session cookie configuration is invalid",
      fix: "check cookie prefix, Secure, Domain, and public origin settings",
    };
  }
  return {
    id: "cookie_config",
    status: "pass",
    message: "Session cookie configuration is valid",
  };
}

function isExactPublicOriginForDoctor(
  value: string,
  mode: "development" | "preview" | "production",
): boolean {
  if (value.includes("*")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (value !== url.origin) return false;
  if (url.protocol === "https:") return true;
  return (
    mode === "development" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname)
  );
}

async function checkPackageVersions(
  cwd: string,
  remoteTarget: boolean,
): Promise<DoctorCheck | null> {
  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
  } catch {
    return null;
  }
  const dependencyVersions = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
  const cfAuthEntries = Object.entries(dependencyVersions).filter(([name]) =>
    isCfAuthPackageName(name),
  );
  if (cfAuthEntries.length === 0) return null;
  const workspaceEntries = cfAuthEntries.filter(([, version]) =>
    version.startsWith("workspace:"),
  );
  if (remoteTarget && workspaceEntries.length > 0) {
    return {
      id: "package_versions",
      status: "warn",
      message:
        "Cloudflare Auth dependencies use workspace protocol in a deploy target",
      fix: "pin published @cf-auth package versions before preview or production deploy",
    };
  }
  const publishedVersions = new Set(
    cfAuthEntries
      .map(([, version]) => version)
      .filter((version) => !version.startsWith("workspace:")),
  );
  if (publishedVersions.size > 1) {
    return {
      id: "package_versions",
      status: "warn",
      message: "Cloudflare Auth package versions are inconsistent",
      fix: "pin all @cf-auth packages to the same release version",
    };
  }
  return {
    id: "package_versions",
    status: "pass",
    message: "Cloudflare Auth package versions are consistent",
  };
}

function isCfAuthPackageName(name: string): boolean {
  return (
    name === "cf-auth" ||
    name === "create-cloudflare-auth" ||
    name.startsWith("@cf-auth/")
  );
}

function isAuthMode(
  value: string | undefined,
): value is "development" | "preview" | "production" {
  return (
    value === "development" || value === "preview" || value === "production"
  );
}

async function checkLocalSecrets(cwd: string): Promise<DoctorCheck[]> {
  let text: string;
  try {
    text = await readFile(join(cwd, ".dev.vars"), "utf8");
  } catch {
    return [
      {
        id: "local_secret",
        status: "fail",
        message: "Local AUTH_SECRET is missing",
        fix: "npx --package @cf-auth/cli@latest cf-auth rotate-secret --print > .dev.vars",
      },
    ];
  }
  const values = parseEnvFile(text);
  const current = values.AUTH_SECRET;
  if (!current) {
    return [
      {
        id: "local_secret",
        status: "fail",
        message: "Local AUTH_SECRET is missing",
        fix: "npx --package @cf-auth/cli@latest cf-auth rotate-secret --print >> .dev.vars",
      },
    ];
  }
  try {
    parseAuthKeyRing(current, values.AUTH_SECRET_PREVIOUS);
  } catch {
    return [
      {
        id: "local_secret",
        status: "fail",
        message: "Local AUTH_SECRET or AUTH_SECRET_PREVIOUS is invalid",
        fix: "regenerate secrets with npx --package @cf-auth/cli@latest cf-auth rotate-secret --print",
      },
    ];
  }
  return [
    {
      id: "local_secret",
      status: "pass",
      message: values.AUTH_SECRET_PREVIOUS
        ? "Local AUTH_SECRET key ring is valid"
        : "Local AUTH_SECRET format is valid",
    },
  ];
}

async function readLocalSecretNames(cwd: string): Promise<Set<string>> {
  try {
    const text = await readFile(join(cwd, ".dev.vars"), "utf8");
    const values = parseEnvFile(text);
    return new Set(
      ["AUTH_SECRET", "AUTH_SECRET_PREVIOUS"].filter((name) =>
        Boolean(values[name]),
      ),
    );
  } catch {
    return new Set();
  }
}

async function checkLocalNamedSecret(
  cwd: string,
  name: string,
): Promise<DoctorCheck> {
  let text: string;
  try {
    text = await readFile(join(cwd, ".dev.vars"), "utf8");
  } catch {
    return {
      id: "turnstile_secret",
      status: "fail",
      message: `${name} is missing locally`,
      fix: `add ${name}=... to .dev.vars`,
    };
  }
  const values = parseEnvFile(text);
  if (!values[name]) {
    return {
      id: "turnstile_secret",
      status: "fail",
      message: `${name} is missing locally`,
      fix: `add ${name}=... to .dev.vars`,
    };
  }
  return {
    id: "turnstile_secret",
    status: "pass",
    message: `${name} configured locally`,
  };
}

interface SourceFile {
  path: string;
  text: string;
}

interface AuthSourceInspection {
  sourceFileCount: number;
  configFound: boolean;
  routeMountCount: number;
  hasDoubleAuthPrefix: boolean;
  usesTerminalEmail: boolean;
  usesDevOutbox: boolean;
  usesCloudflareEmail: boolean;
  turnstileRequiresSecret: boolean;
  passwordHashProfile: PasswordHashProfileName;
  passwordHashConcurrency: number;
  passwordHashQueueTimeoutMs: number;
  sessionCookieName: string | null;
  sessionSameSite: string | null;
  sessionDomain: string | null;
  dynamicSessionProperties: string[];
  requestMaxBodyBytes: number | null;
  dynamicRequestMaxBodyBytes: boolean;
  requireOriginOnUnsafeMethods: boolean;
  requestOrigins: Array<{ property: string; value: string }>;
  dynamicRequestOriginProperties: string[];
  redirectOrigins: Array<{ property: string; value: string }>;
  dynamicRedirectProperties: string[];
}

async function inspectAuthSource(cwd: string): Promise<AuthSourceInspection> {
  const sourceFiles = await readSourceFiles(join(cwd, "src"));
  const rootConfigFiles = await readRootAuthConfigFiles(cwd);
  const configFile =
    [...sourceFiles, ...rootConfigFiles].find((file) =>
      /^auth\.config\.[cm]?[jt]sx?$/u.test(basename(file.path)),
    ) ?? null;
  const configText = configFile?.text ?? "";
  const routeSource = sourceFiles.map((file) => file.text).join("\n");
  const turnstileText = extractObjectPropertyText(configText, "turnstile");
  const passwordHashingText = extractObjectPropertyText(
    configText,
    "passwordHashing",
  );
  const sessionText = extractObjectPropertyText(configText, "session");
  const requestText = extractObjectPropertyText(configText, "request");
  const parsedPasswordProfile = parsePasswordProfile(
    passwordHashingText
      ? extractStringProperty(passwordHashingText, "profile")
      : null,
  );
  const sessionCookieName = sessionText
    ? extractStringPropertyInspection(sessionText, "cookieName")
    : { value: null, dynamic: false };
  const sessionSameSite = sessionText
    ? extractStringPropertyInspection(sessionText, "sameSite")
    : { value: null, dynamic: false };
  const sessionDomain = sessionText
    ? extractStringPropertyInspection(sessionText, "domain")
    : { value: null, dynamic: false };
  const requestMaxBodyBytes = requestText
    ? extractIntegerPropertyInspection(requestText, "maxBodyBytes")
    : { value: null, dynamic: false };
  const byEnvironmentEmailText = extractCallArgumentText(
    configText,
    "byEnvironment",
  );
  const remoteEmailText = byEnvironmentEmailText
    ? [
        extractPropertyExpression(byEnvironmentEmailText, "preview"),
        extractPropertyExpression(byEnvironmentEmailText, "production"),
      ]
        .filter(Boolean)
        .join("\n")
    : configText;
  return {
    sourceFileCount: sourceFiles.length,
    configFound: Boolean(configFile),
    routeMountCount:
      countMatches(routeSource, /\bcreateAuthRoutes\s*\(/gu) +
      countMatches(routeSource, /\bcreateAuthHandler\s*\(/gu),
    hasDoubleAuthPrefix:
      routeSource.includes('"/auth/auth') ||
      routeSource.includes("'/auth/auth") ||
      routeSource.includes("`/auth/auth"),
    usesTerminalEmail: /\bterminalEmail\s*\(/u.test(remoteEmailText),
    usesDevOutbox: /\boutbox\s*:\s*true\b/u.test(remoteEmailText),
    usesCloudflareEmail: /\bcloudflareEmail\s*\(/u.test(remoteEmailText),
    turnstileRequiresSecret: Boolean(
      turnstileText &&
      /\bmode\s*:\s*["']required["']/u.test(turnstileText) &&
      !/\bverify\s*:/u.test(turnstileText),
    ),
    passwordHashProfile: parsedPasswordProfile ?? "workers-balanced",
    passwordHashConcurrency:
      (passwordHashingText
        ? extractNumberProperty(
            passwordHashingText,
            "maxConcurrentHashesPerIsolate",
          )
        : null) ?? 1,
    passwordHashQueueTimeoutMs:
      (passwordHashingText
        ? extractNumberProperty(passwordHashingText, "queueTimeoutMs")
        : null) ?? 2_000,
    sessionCookieName: sessionCookieName.value,
    sessionSameSite: sessionSameSite.value,
    sessionDomain: sessionDomain.value,
    dynamicSessionProperties: [
      ...(sessionCookieName.dynamic ? ["session.cookieName"] : []),
      ...(sessionSameSite.dynamic ? ["session.sameSite"] : []),
      ...(sessionDomain.dynamic ? ["session.domain"] : []),
    ],
    requestMaxBodyBytes: requestMaxBodyBytes.value,
    dynamicRequestMaxBodyBytes: requestMaxBodyBytes.dynamic,
    requireOriginOnUnsafeMethods:
      (requestText
        ? extractBooleanProperty(requestText, "requireOriginOnUnsafeMethods")
        : null) ?? true,
    requestOrigins: [
      ...extractStringArrayProperty(
        configText,
        "allowedRequestOrigins",
      ).values.map((value) => ({
        property: "allowedRequestOrigins",
        value,
      })),
      ...extractStringArrayProperty(
        configText,
        "allowedPreviewRequestOrigins",
      ).values.map((value) => ({
        property: "allowedPreviewRequestOrigins",
        value,
      })),
    ],
    dynamicRequestOriginProperties: [
      ...extractStringArrayProperty(
        configText,
        "allowedRequestOrigins",
      ).dynamic.map(() => "allowedRequestOrigins"),
      ...extractStringArrayProperty(
        configText,
        "allowedPreviewRequestOrigins",
      ).dynamic.map(() => "allowedPreviewRequestOrigins"),
    ],
    redirectOrigins: [
      ...extractStringArrayProperty(configText, "allowedOrigins").values.map(
        (value) => ({ property: "allowedOrigins", value }),
      ),
      ...extractStringArrayProperty(
        configText,
        "allowedPreviewOrigins",
      ).values.map((value) => ({
        property: "allowedPreviewOrigins",
        value,
      })),
    ],
    dynamicRedirectProperties: [
      ...extractStringArrayProperty(configText, "allowedOrigins").dynamic.map(
        () => "allowedOrigins",
      ),
      ...extractStringArrayProperty(
        configText,
        "allowedPreviewOrigins",
      ).dynamic.map(() => "allowedPreviewOrigins"),
    ],
  };
}

function sourceUsesCloudflareEmail(source: AuthSourceInspection): boolean {
  return !source.configFound || source.usesCloudflareEmail;
}

function checkAuthSource(
  source: AuthSourceInspection,
  vars: Record<string, string>,
  remoteTarget: boolean,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  if (source.sourceFileCount === 0) {
    checks.push({
      id: "auth_route",
      status: "warn",
      message: "Auth source files could not be inspected",
      fix: "keep auth route source under src or verify route mounting manually",
    });
  } else if (source.routeMountCount === 0) {
    checks.push({
      id: "auth_route",
      status: "fail",
      message: "Auth route mount was not found",
      fix: "mount createAuthRoutes(authConfig) once at authConfig.basePath or use createAuthHandler(authConfig)",
    });
  } else if (source.routeMountCount > 1) {
    checks.push({
      id: "auth_route",
      status: "fail",
      message: "Auth route appears to be mounted more than once",
      fix: "mount auth routes exactly once to avoid duplicate handlers",
    });
  } else if (source.hasDoubleAuthPrefix) {
    checks.push({
      id: "auth_route",
      status: "fail",
      message: "Auth route appears to include /auth/auth",
      fix: "mount at authConfig.basePath and keep auth route definitions relative",
    });
  } else {
    checks.push({
      id: "auth_route",
      status: "pass",
      message: "Auth route mounted once",
    });
  }

  if (!source.configFound) {
    checks.push({
      id: "auth_config",
      status: "warn",
      message: "auth.config source could not be inspected",
      fix: "keep auth configuration in auth.config.ts or verify production settings manually",
    });
    return checks;
  }

  if (remoteTarget) {
    if (source.usesTerminalEmail || source.usesDevOutbox) {
      checks.push({
        id: "email_adapter",
        status: "fail",
        message: "Terminal email/dev outbox is configured for a remote target",
        fix: "switch auth.config.ts to cloudflareEmail(...) or a custom production email adapter before deploy",
      });
    } else {
      checks.push({
        id: "email_adapter",
        status: "pass",
        message: "Production email adapter source does not use terminal email",
      });
    }
  }

  const sessionCookieCheck = checkSessionCookieSource(source, vars);
  if (sessionCookieCheck) checks.push(sessionCookieCheck);
  const requestConfigCheck = checkRequestConfigSource(source);
  if (requestConfigCheck) checks.push(requestConfigCheck);
  const redirectCheck = checkRedirectOrigins(source, vars.AUTH_ENV);
  if (redirectCheck) checks.push(redirectCheck);
  const requestOriginCheck = checkRequestOrigins(source, vars.AUTH_ENV);
  if (requestOriginCheck) checks.push(requestOriginCheck);
  if (remoteTarget && !source.requireOriginOnUnsafeMethods) {
    checks.push({
      id: "origin_policy",
      status: "warn",
      message:
        "Unsafe auth-route methods do not require Origin in a remote target",
      fix: "set request.requireOriginOnUnsafeMethods to true for browser cookie auth",
    });
  }
  return checks;
}

function checkSessionCookieSource(
  source: AuthSourceInspection,
  vars: Record<string, string>,
): DoctorCheck | null {
  const hasStaticSessionConfig =
    source.sessionCookieName !== null ||
    source.sessionSameSite !== null ||
    source.sessionDomain !== null;
  try {
    if (
      source.sessionCookieName !== null &&
      source.sessionCookieName !== "auto"
    ) {
      assertValidSessionCookieName(source.sessionCookieName);
    }
    if (
      source.sessionSameSite !== null &&
      source.sessionSameSite !== "lax" &&
      source.sessionSameSite !== "strict"
    ) {
      throw new Error("invalid SameSite");
    }
    if (source.sessionDomain !== null) {
      assertValidSessionCookieDomain(source.sessionDomain);
    }
    if (
      source.sessionCookieName?.startsWith("__Host-") &&
      source.sessionDomain
    ) {
      throw new Error("invalid __Host- Domain combination");
    }
  } catch {
    return {
      id: "session_cookie_source",
      status: "fail",
      message: "Session cookie source config is invalid",
      fix: "use cookieName auto or a valid token name, SameSite lax/strict, and a leading-dot parent Domain such as .example.com",
    };
  }
  if (source.dynamicSessionProperties.length > 0) {
    return {
      id: "session_cookie_source",
      status: "warn",
      message: "Session cookie source config contains dynamic values",
      fix: `verify ${source.dynamicSessionProperties.join(", ")} before deploy`,
    };
  }
  const mode = vars.AUTH_ENV;
  const origin = vars.AUTH_PUBLIC_ORIGIN;
  if (!isAuthMode(mode) || !origin) {
    return hasStaticSessionConfig
      ? {
          id: "session_cookie_source",
          status: "warn",
          message:
            "Session cookie source config could not be checked against AUTH_PUBLIC_ORIGIN",
          fix: "set AUTH_ENV and AUTH_PUBLIC_ORIGIN, then rerun doctor",
        }
      : null;
  }
  if (!hasStaticSessionConfig) return null;
  try {
    resolveSessionCookie({
      mode,
      requestOrigin: origin,
      cookieName: source.sessionCookieName ?? "auto",
      ...(source.sessionSameSite
        ? { sameSite: source.sessionSameSite as "lax" | "strict" }
        : {}),
      ...(source.sessionDomain ? { domain: source.sessionDomain } : {}),
    });
  } catch {
    return {
      id: "session_cookie_source",
      status: "fail",
      message: "Session cookie source config is invalid for this environment",
      fix: "check cookie prefix rules, HTTPS public origin, and Domain settings for the selected Wrangler environment",
    };
  }
  return {
    id: "session_cookie_source",
    status: "pass",
    message: "Session cookie source config is valid",
  };
}

function checkRequestConfigSource(
  source: AuthSourceInspection,
): DoctorCheck | null {
  if (source.requestMaxBodyBytes !== null) {
    if (
      !Number.isSafeInteger(source.requestMaxBodyBytes) ||
      source.requestMaxBodyBytes < 1
    ) {
      return {
        id: "request_body_limit",
        status: "fail",
        message: "Request maxBodyBytes source config is invalid",
        fix: "set request.maxBodyBytes to a positive integer byte limit",
      };
    }
    if (source.requestMaxBodyBytes > 64 * 1024) {
      return {
        id: "request_body_limit",
        status: "warn",
        message: "Request maxBodyBytes exceeds 64 KiB",
        fix: "keep auth request bodies small unless a documented integration requires a larger limit",
      };
    }
    return null;
  }
  if (source.dynamicRequestMaxBodyBytes) {
    return {
      id: "request_body_limit",
      status: "warn",
      message: "Request maxBodyBytes source config contains a dynamic value",
      fix: "verify the evaluated request body limit is positive and no larger than 64 KiB before deploy",
    };
  }
  return null;
}

async function checkPasswordBenchmark(
  source: AuthSourceInspection,
  remoteTarget: boolean,
  passwordBenchmark: PasswordBenchmarkRunner,
): Promise<DoctorCheck> {
  let result: PasswordBenchmarkResult<PasswordHashProfileName>;
  try {
    result = await passwordBenchmark(source.passwordHashProfile);
  } catch {
    return {
      id: "password_benchmark",
      status: "warn",
      message: "Password hashing benchmark could not run",
      fix: "run pnpm benchmark:password and inspect the failure before production deploy",
    };
  }
  const queueBatches = Math.ceil(
    2 / Math.max(source.passwordHashConcurrency, 1),
  );
  const queueEstimateMs = queueBatches * result.p95Ms;
  const queueTimeoutMs = Math.max(source.passwordHashQueueTimeoutMs, 1);
  const estimate = remoteTarget ? " local-estimate" : "";
  const measured = `${result.profile} p95=${result.p95Ms}ms throughput=${result.throughputHashesPerSecond}/s`;
  if (remoteTarget && source.passwordHashProfile === "development-fast") {
    return {
      id: "password_benchmark",
      status: "warn",
      message: `Password hashing benchmark${estimate} ${measured}, but development-fast is configured for a remote target`,
      fix: "use workers-balanced for preview/production unless a documented target Worker benchmark justifies different params",
    };
  }
  if (result.p95Ms > 750) {
    return {
      id: "password_benchmark",
      status: "warn",
      message: `Password hashing benchmark${estimate} ${measured} exceeds 750ms`,
      fix: "reduce passwordHashing profile or document a target Worker benchmark before production deploy",
    };
  }
  if (queueEstimateMs > queueTimeoutMs) {
    return {
      id: "password_benchmark",
      status: "warn",
      message: `Password hashing queue estimate is ${queueEstimateMs}ms for a two-request burst; timeout=${queueTimeoutMs}ms`,
      fix: "increase maxConcurrentHashesPerIsolate only if Worker CPU and memory benchmarks support it, or reduce hash cost",
    };
  }
  return {
    id: "password_benchmark",
    status: "pass",
    message: `Password hashing benchmark${estimate} ${measured}`,
  };
}

async function benchmarkPasswordProfile(
  profile: PasswordHashProfileName,
): Promise<PasswordBenchmarkResult<PasswordHashProfileName>> {
  let cached = passwordBenchmarkCache.get(profile);
  if (!cached) {
    cached = runWorkersPasswordBenchmark({
      profile,
      params: passwordHashProfiles[profile],
    });
    passwordBenchmarkCache.set(profile, cached);
  }
  return cached;
}

function checkRedirectOrigins(
  source: AuthSourceInspection,
  mode: string | undefined,
): DoctorCheck | null {
  const invalid = source.redirectOrigins.find(
    (origin) => !isValidRedirectOrigin(origin.value, mode),
  );
  if (invalid) {
    return {
      id: "redirect_origins",
      status: "fail",
      message: `Redirect ${invalid.property} contains an invalid exact origin`,
      fix: "use exact origins like https://example.com without paths, queries, fragments, wildcards, or trailing slashes",
    };
  }
  if (source.dynamicRedirectProperties.length > 0) {
    return {
      id: "redirect_origins",
      status: "warn",
      message: "Redirect origin allowlist contains dynamic values",
      fix: "verify dynamic redirect origins are exact trusted origins",
    };
  }
  return {
    id: "redirect_origins",
    status: "pass",
    message: "Redirect origin allowlists are valid",
  };
}

function checkRequestOrigins(
  source: AuthSourceInspection,
  mode: string | undefined,
): DoctorCheck | null {
  const invalid = source.requestOrigins.find(
    (origin) => !isValidRedirectOrigin(origin.value, mode),
  );
  if (invalid) {
    return {
      id: "request_origins",
      status: "fail",
      message: `Request ${invalid.property} contains an invalid exact origin`,
      fix: "use exact origins like https://app.example.com without paths, queries, fragments, wildcards, or trailing slashes",
    };
  }
  if (source.dynamicRequestOriginProperties.length > 0) {
    return {
      id: "request_origins",
      status: "warn",
      message: "Request origin allowlist contains dynamic values",
      fix: "verify dynamic request origins are exact trusted browser origins",
    };
  }
  return {
    id: "request_origins",
    status: "pass",
    message: "Request origin allowlists are valid",
  };
}

function isValidRedirectOrigin(
  value: string,
  mode: string | undefined,
): boolean {
  if (value.includes("*")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (value !== url.origin) return false;
  if (url.protocol === "https:") return true;
  return (
    mode === "development" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname)
  );
}

async function readRootAuthConfigFiles(cwd: string): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  for (const name of [
    "auth.config.ts",
    "auth.config.tsx",
    "auth.config.js",
    "auth.config.mjs",
    "auth.config.cjs",
  ]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    files.push({ path, text: await readFile(path, "utf8") });
  }
  return files;
}

async function readSourceFiles(root: string): Promise<SourceFile[]> {
  if (!existsSync(root)) return [];
  const files: SourceFile[] = [];
  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        !["node_modules", "dist", ".wrangler"].includes(entry.name)
      ) {
        await visit(join(directory, entry.name));
      } else if (
        entry.isFile() &&
        /\.[cm]?[jt]sx?$/u.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        const path = join(directory, entry.name);
        files.push({ path, text: await readFile(path, "utf8") });
      }
    }
  }
  await visit(root);
  return files;
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function extractObjectPropertyText(
  text: string,
  property: string,
): string | null {
  const pattern = new RegExp(`\\b${property}\\s*:`, "gu");
  for (const match of text.matchAll(pattern)) {
    let index = (match.index ?? 0) + match[0].length;
    while (/\s/u.test(text[index] ?? "")) index += 1;
    if (text[index] !== "{") continue;
    const end = findMatchingDelimiter(text, index, "{", "}");
    if (end !== null) return text.slice(index + 1, end);
  }
  return null;
}

function extractCallArgumentText(text: string, callee: string): string | null {
  const pattern = new RegExp(`\\b${callee}\\s*\\(`, "gu");
  for (const match of text.matchAll(pattern)) {
    const openIndex = (match.index ?? 0) + match[0].length - 1;
    const closeIndex = findMatchingDelimiter(text, openIndex, "(", ")");
    if (closeIndex !== null) return text.slice(openIndex + 1, closeIndex);
  }
  return null;
}

function extractPropertyExpression(
  text: string,
  property: string,
): string | null {
  const pattern = new RegExp(`\\b${property}\\s*:`, "gu");
  for (const match of text.matchAll(pattern)) {
    let index = (match.index ?? 0) + match[0].length;
    const start = index;
    let depth = 0;
    let quote: string | null = null;
    for (; index < text.length; index += 1) {
      const char = text[index];
      const next = text[index + 1];
      if (quote) {
        if (char === "\\") {
          index += 1;
        } else if (char === quote) {
          quote = null;
        }
        continue;
      }
      if (char === "/" && next === "/") {
        while (index < text.length && text[index] !== "\n") index += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        index += 2;
        while (
          index < text.length - 1 &&
          !(text[index] === "*" && text[index + 1] === "/")
        ) {
          index += 1;
        }
        index += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(" || char === "{" || char === "[") depth += 1;
      if (char === ")" || char === "}" || char === "]") depth -= 1;
      if (depth < 0 || (depth === 0 && char === ",")) {
        return text.slice(start, index).trim();
      }
    }
    return text.slice(start).trim();
  }
  return null;
}

function extractStringProperty(text: string, property: string): string | null {
  const pattern = new RegExp(`\\b${property}\\s*:\\s*["']([^"']+)["']`, "u");
  return pattern.exec(text)?.[1] ?? null;
}

function extractNumberProperty(text: string, property: string): number | null {
  const pattern = new RegExp(`\\b${property}\\s*:\\s*(\\d+)`, "u");
  const value = pattern.exec(text)?.[1];
  if (!value) return null;
  return Number.parseInt(value, 10);
}

function extractBooleanProperty(
  text: string,
  property: string,
): boolean | null {
  const pattern = new RegExp(`\\b${property}\\s*:\\s*(true|false)`, "u");
  const value = pattern.exec(text)?.[1];
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function extractStringPropertyInspection(
  text: string,
  property: string,
): { value: string | null; dynamic: boolean } {
  const expression = extractPropertyExpression(text, property);
  if (expression === null) return { value: null, dynamic: false };
  const literals = extractStringLiterals(expression);
  const staticRemainder = stripCommentsAndStrings(expression).trim();
  if (literals.length === 1 && staticRemainder === "") {
    return { value: literals[0] ?? null, dynamic: false };
  }
  return { value: null, dynamic: true };
}

function extractIntegerPropertyInspection(
  text: string,
  property: string,
): { value: number | null; dynamic: boolean } {
  const expression = extractPropertyExpression(text, property);
  if (expression === null) return { value: null, dynamic: false };
  const value = parseStaticIntegerExpression(expression);
  if (value !== null) return { value, dynamic: false };
  return { value: null, dynamic: true };
}

function parseStaticIntegerExpression(expression: string): number | null {
  const cleaned = stripCommentsAndStrings(expression).trim();
  if (!/^-?\d[\d_]*(?:\s*\*\s*-?\d[\d_]*)*$/u.test(cleaned)) return null;
  const value = cleaned
    .split("*")
    .map((part) => Number.parseInt(part.trim().replaceAll("_", ""), 10))
    .reduce((product, factor) => product * factor, 1);
  return Number.isSafeInteger(value) ? value : null;
}

function parsePasswordProfile(
  value: string | null,
): PasswordHashProfileName | null {
  if (
    value === "development-fast" ||
    value === "workers-balanced" ||
    value === "high-cost"
  ) {
    return value;
  }
  return null;
}

function extractStringArrayProperty(
  text: string,
  property: string,
): { values: string[]; dynamic: string[] } {
  const values: string[] = [];
  const dynamic: string[] = [];
  const pattern = new RegExp(`\\b${property}\\s*:`, "gu");
  for (const match of text.matchAll(pattern)) {
    let index = (match.index ?? 0) + match[0].length;
    while (/\s/u.test(text[index] ?? "")) index += 1;
    if (text[index] !== "[") {
      dynamic.push(property);
      continue;
    }
    const end = findMatchingDelimiter(text, index, "[", "]");
    if (end === null) {
      dynamic.push(property);
      continue;
    }
    const content = text.slice(index + 1, end);
    values.push(...extractStringLiterals(content));
    if (stripCommentsAndStrings(content).replace(/[\s,]/gu, "") !== "") {
      dynamic.push(property);
    }
  }
  return { values, dynamic };
}

function extractStringLiterals(text: string): string[] {
  const values: string[] = [];
  const pattern = /(["'])(?:\\.|(?!\1)[^\\])*\1/gu;
  for (const match of text.matchAll(pattern)) {
    const raw = match[0];
    values.push(raw.slice(1, -1).replace(/\\(["'\\/])/gu, "$1"));
  }
  return values;
}

function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/(["'])(?:\\.|(?!\1)[^\\])*\1/gu, "")
    .replace(/\/\/.*$/gmu, "")
    .replace(/\/\*[\s\S]*?\*\//gu, "");
}

function findMatchingDelimiter(
  text: string,
  start: number,
  open: string,
  close: string,
): number | null {
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quote) {
      if (char === "\\") {
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (
        index < text.length - 1 &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return null;
}

function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) continue;
    values[key] = stripEnvQuotes(value.trim());
  }
  return values;
}

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function displayCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function commandGenerate(parsed: ParsedArgs): string {
  const what = parsed.positionals[0] ?? "hono";
  if (what === "hono")
    return "app.route(authConfig.basePath, createAuthRoutes(authConfig));";
  if (what === "types")
    return [
      "export interface Env {",
      "  AUTH_DB: D1Database;",
      "  AUTH_EMAIL?: {",
      "    send(message: {",
      "      to: string | string[];",
      "      from: string | { email: string; name: string };",
      "      subject: string;",
      "      text?: string;",
      "      html?: string;",
      "      headers?: Record<string, string>;",
      "    }): Promise<unknown>;",
      "  };",
      "  AUTH_RATE_LIMITER?: {",
      "    limit(input: { key: string }): Promise<{ success: boolean }>;",
      "  };",
      "  AUTH_SECRET: string;",
      "  AUTH_SECRET_PREVIOUS?: string;",
      '  AUTH_ENV: "development" | "preview" | "production";',
      "  AUTH_PUBLIC_ORIGIN?: string;",
      "  TURNSTILE_SECRET_KEY?: string;",
      "}",
    ].join("\n");
  if (what === "react-client")
    return 'import { createAuthClient } from "@cf-auth/client";\nexport const auth = createAuthClient({ basePath: "/auth" });';
  if (what === "worker-snippet")
    return [
      "const authHandler = createAuthHandler(authConfig);",
      "const authResponse = await authHandler.fetch(request, env, ctx);",
      "if (authResponse) return authResponse;",
    ].join("\n");
  throw new Error(
    `Unsupported generator: ${what}. Supported generators: hono, worker-snippet, react-client, types.`,
  );
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
  const redacted = redactCliOutput(output);
  return redacted
    ? `wrangler d1 execute <redacted recovery SQL>\n${redacted}`
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

function redactCliOutput(value: string): string {
  return redactLogValue(value);
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
  $schema?: string;
  name?: string;
  account_id?: string;
  compatibility_date?: string;
  compatibility_flags?: string[];
  observability?: {
    enabled?: boolean;
    head_sampling_rate?: number;
  };
  vars?: Record<string, string>;
  send_email?: Array<{ name: string }>;
  d1_databases?: Array<{
    binding: string;
    database_name: string;
    database_id?: string;
    migrations_dir?: string;
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
  const path = wranglerPath(cwd);
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

function wranglerPath(cwd: string): string {
  return existingWranglerPath(cwd) ?? join(cwd, "wrangler.json");
}

function existingWranglerPath(cwd: string): string | null {
  const jsoncPath = join(cwd, "wrangler.jsonc");
  if (existsSync(jsoncPath)) return jsoncPath;
  const jsonPath = join(cwd, "wrangler.json");
  if (existsSync(jsonPath)) return jsonPath;
  return null;
}

function stripJsonComments(text: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      } else if (char === "\n") {
        output += char;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    output += char;
  }

  return output.replace(/,\s*([}\]])/g, "$1");
}

async function repairWranglerConfig(
  cwd: string,
  appName: string,
): Promise<boolean> {
  const path = wranglerPath(cwd);
  const text = await readFile(path, "utf8");
  const config = JSON.parse(stripJsonComments(text)) as WranglerConfig;
  let changed = false;

  changed = ensureWranglerSchema(config) || changed;
  changed = ensureWorkersCompatibility(config) || changed;
  changed =
    ensureVars(config, {
      AUTH_ENV: "development",
      AUTH_PUBLIC_ORIGIN: "http://localhost:8787",
    }) || changed;
  changed =
    ensureD1Binding(config, `${appName}-auth-dev`, "local-development", true) ||
    changed;
  changed = ensureObservability(config) || changed;

  config.env ??= {};
  if (!config.env.production) {
    config.env.production = {
      name: appName,
    };
    changed = true;
  }
  const production = config.env.production;
  if (production.compatibility_date || production.compatibility_flags) {
    changed = ensureWorkersCompatibility(production) || changed;
  }
  changed =
    ensureVars(production, {
      AUTH_ENV: "production",
      AUTH_PUBLIC_ORIGIN: "https://example.com",
    }) || changed;
  changed =
    ensureD1Binding(
      production,
      `${appName}-auth`,
      "REPLACE_WITH_DATABASE_ID",
      false,
    ) || changed;
  if (
    !production.send_email?.some((binding) => binding.name === "AUTH_EMAIL")
  ) {
    production.send_email = [
      ...(production.send_email ?? []),
      { name: "AUTH_EMAIL" },
    ];
    changed = true;
  }

  if (changed) await writeFile(path, JSON.stringify(config, null, 2) + "\n");
  return changed;
}

function ensureWranglerSchema(config: WranglerConfig): boolean {
  if (config.$schema) return false;
  config.$schema = wranglerSchemaPath;
  return true;
}

function ensureWorkersCompatibility(config: WranglerConfig): boolean {
  let changed = false;
  if (
    !config.compatibility_date ||
    !isCompatibilityDate(config.compatibility_date) ||
    config.compatibility_date < workersCompatibilityDateFloor
  ) {
    config.compatibility_date = workersCompatibilityDate;
    changed = true;
  }
  config.compatibility_flags ??= [];
  if (!config.compatibility_flags.includes(workersNodeCompatibilityFlag)) {
    config.compatibility_flags.push(workersNodeCompatibilityFlag);
    changed = true;
  }
  return changed;
}

function ensureObservability(config: WranglerConfig): boolean {
  if (config.observability) return false;
  config.observability = {
    enabled: true,
    head_sampling_rate: 1,
  };
  return true;
}

function ensureVars(
  config: WranglerConfig,
  values: Record<string, string>,
): boolean {
  let changed = false;
  config.vars ??= {};
  for (const [key, value] of Object.entries(values)) {
    if (!config.vars[key]) {
      config.vars[key] = value;
      changed = true;
    }
  }
  return changed;
}

function ensureD1Binding(
  config: WranglerConfig,
  databaseName: string,
  databaseId: string,
  replacePlaceholder: boolean,
): boolean {
  let changed = false;
  config.d1_databases ??= [];
  let binding = config.d1_databases.find((item) => item.binding === "AUTH_DB");
  if (!binding) {
    binding = {
      binding: "AUTH_DB",
      database_name: databaseName,
      database_id: databaseId,
      migrations_dir: "migrations",
    };
    config.d1_databases.push(binding);
    return true;
  }
  if (!binding.database_name) {
    binding.database_name = databaseName;
    changed = true;
  }
  if (
    !binding.database_id ||
    (replacePlaceholder && binding.database_id.startsWith("REPLACE_"))
  ) {
    binding.database_id = databaseId;
    changed = true;
  }
  if (!binding.migrations_dir) {
    binding.migrations_dir = "migrations";
    changed = true;
  }
  return changed;
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

function workerNameFromTarget(target: string): string {
  return (
    basename(target)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "cf-auth-app"
  );
}

function resolveInitTemplate(
  value: string | boolean | undefined,
): InitTemplate {
  if (value === undefined) return "hono-basic";
  if (value === true)
    throw new Error(
      "Missing value for --template. Use hono-basic or worker-basic.",
    );
  if (value === "hono-basic" || value === "worker-basic") return value;
  throw new Error(
    `Unsupported template: ${value}. Supported templates: hono-basic, worker-basic.`,
  );
}

function templatePackageJson(name: string, template: InitTemplate) {
  const dependencies =
    template === "hono-basic"
      ? {
          "@cf-auth/email-cloudflare": generatedPackageVersion,
          "@cf-auth/hono": generatedPackageVersion,
          "@cf-auth/worker": generatedPackageVersion,
          hono: "4.12.18",
        }
      : {
          "@cf-auth/email-cloudflare": generatedPackageVersion,
          "@cf-auth/worker": generatedPackageVersion,
        };
  return {
    name,
    type: "module",
    packageManager: "pnpm@11.1.1",
    scripts: {
      dev: "wrangler dev",
      build: "tsc -p tsconfig.json --noEmit",
      test: "vitest run --passWithNoTests",
    },
    dependencies,
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

type PackageJsonPatchResult = "created" | "updated" | "unchanged";

async function writeOrPatchPackageJson(
  path: string,
  name: string,
  template: InitTemplate,
): Promise<PackageJsonPatchResult> {
  if (!existsSync(path)) {
    await writeFile(
      path,
      JSON.stringify(templatePackageJson(name, template), null, 2) + "\n",
    );
    return "created";
  }
  const pkg = JSON.parse(await readFile(path, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } & Record<string, unknown>;
  let changed = false;
  const dependencies = { ...(pkg.dependencies ?? {}) };
  const devDependencies = { ...(pkg.devDependencies ?? {}) };
  for (const [dependency, version] of Object.entries(
    templatePackageJson(name, template).dependencies,
  )) {
    if (!dependencies[dependency]) {
      dependencies[dependency] = version;
      changed = true;
    }
  }
  if (!devDependencies.wrangler) {
    devDependencies.wrangler = templatePackageJson(
      name,
      template,
    ).devDependencies.wrangler;
    changed = true;
  }
  if (!changed) return "unchanged";
  pkg.dependencies = dependencies;
  pkg.devDependencies = devDependencies;
  await writeFile(path, JSON.stringify(pkg, null, 2) + "\n");
  return "updated";
}

function pnpmWorkspaceTemplate(): string {
  return `allowBuilds:
  esbuild: true
  sharp: true
  workerd: true
`;
}

function authConfigTemplate(): string {
  return `import { byEnvironment, defineAuthConfig, terminalEmail } from "@cf-auth/worker";
import { cloudflareEmail } from "@cf-auth/email-cloudflare";

export default defineAuthConfig({
  appName: "My App",
  basePath: "/auth",
  passwordHashing: {
    profile: "workers-balanced",
    maxConcurrentHashesPerIsolate: 1,
    queueTimeoutMs: 2000
  },
  email: byEnvironment({
    development: terminalEmail({ outbox: true }),
    preview: cloudflareEmail({
      binding: "AUTH_EMAIL",
      from: { email: "auth@example.com", name: "My App" }
    }),
    production: cloudflareEmail({
      binding: "AUTH_EMAIL",
      from: { email: "auth@example.com", name: "My App" }
    })
  })
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

function workerIndexTemplate(): string {
  return `import { createAuthHandler } from "@cf-auth/worker";
import authConfig from "./auth.config.js";

const authHandler = createAuthHandler(authConfig);

export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response> {
    const authResponse = await authHandler.fetch(request, env, ctx);
    if (authResponse) return authResponse;
    return new Response("Cloudflare Auth");
  }
};
`;
}

function indexTemplate(template: InitTemplate): string {
  return template === "hono-basic"
    ? honoIndexTemplate()
    : workerIndexTemplate();
}

function templateMountSnippet(template: InitTemplate): string {
  return template === "hono-basic"
    ? "Hono mount: app.route(authConfig.basePath, createAuthRoutes(authConfig));"
    : `Worker mount:
const authHandler = createAuthHandler(authConfig);
const authResponse = await authHandler.fetch(request, env, ctx);
if (authResponse) return authResponse;`;
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

function wranglerTemplate(appName: string): string {
  return `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "${appName}-dev",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-14",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  },
  "vars": {
    "AUTH_ENV": "development",
    "AUTH_PUBLIC_ORIGIN": "http://localhost:8787"
  },
  "d1_databases": [
    {
      "binding": "AUTH_DB",
      "database_name": "${appName}-auth-dev",
      "database_id": "local-development",
      "migrations_dir": "migrations"
    }
  ],
  "env": {
    "production": {
      "name": "${appName}",
      "vars": {
        "AUTH_ENV": "production",
        "AUTH_PUBLIC_ORIGIN": "https://example.com"
      },
      "d1_databases": [
        {
          "binding": "AUTH_DB",
          "database_name": "${appName}-auth",
          "database_id": "REPLACE_WITH_DATABASE_ID",
          "migrations_dir": "migrations"
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
