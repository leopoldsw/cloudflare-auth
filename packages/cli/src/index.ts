import { spawnSync } from "node:child_process";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { constants as fsConstants, existsSync, type Stats } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
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
const workersCompatibilityDate = "2026-07-11";
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
  fetchImpl?: typeof globalThis.fetch;
  sleepMs?: (ms: number) => Promise<void>;
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

type SetupStepStatus = "pass" | "fail" | "warn" | "skipped";

interface SetupStep {
  id: string;
  status: SetupStepStatus;
  message: string;
  fix?: string;
}

interface SetupReport {
  $schema: string;
  schemaVersion: 1;
  ok: boolean;
  generatedAt: string;
  environment: string;
  summary: {
    pass: number;
    fail: number;
    warn: number;
    skipped: number;
  };
  steps: SetupStep[];
  nextAction?: string;
  doctor?: DoctorReport;
  redaction: DoctorReport["redaction"];
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
  const runner = parsed.flags.verbose
    ? verboseRunner(io.runCommand ?? runCommand, err)
    : (io.runCommand ?? runCommand);
  try {
    switch (parsed.command) {
      case "help":
      case "--help":
      case "-h":
        out(
          "cf-auth <init|setup|provision|migrate|doctor|deploy|generate|clean|rotate-secret|users|sessions>",
        );
        return 0;
      case "init":
        await commandInit(parsed, cwd, out);
        return 0;
      case "setup": {
        const result = await commandSetup(parsed, cwd, out, err, runner, {
          passwordBenchmark,
          fetchImpl: io.fetchImpl ?? globalThis.fetch,
          sleepMs:
            io.sleepMs ??
            ((ms: number) =>
              new Promise((resolveSleep) => setTimeout(resolveSleep, ms))),
        });
        if (parsed.flags.report) {
          const reportJson = JSON.stringify(result.report, null, 2) + "\n";
          if (typeof parsed.flags.output === "string") {
            const outputPath = resolve(cwd, parsed.flags.output);
            await safeAtomicWriteFile(outputPath, reportJson, { mode: 0o600 });
            out(`Wrote setup report to ${outputPath}`);
          } else {
            out(reportJson.trimEnd());
          }
        }
        return result.ok ? 0 : 1;
      }
      case "provision":
        out(await commandProvision(parsed, cwd, runner));
        return 0;
      case "migrate":
        out(await commandMigrate(parsed, cwd, runner));
        return 0;
      case "doctor": {
        const result = await commandDoctor(
          parsed,
          cwd,
          runner,
          passwordBenchmark,
          {},
        );
        if (parsed.flags.report) {
          const reportJson = JSON.stringify(result.report, null, 2) + "\n";
          if (typeof parsed.flags.output === "string") {
            const outputPath = resolve(cwd, parsed.flags.output);
            await safeAtomicWriteFile(outputPath, reportJson, { mode: 0o600 });
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
        out(await commandDeploy(parsed, cwd, runner, passwordBenchmark));
        return 0;
      case "generate":
        out(commandGenerate(parsed));
        return 0;
      case "rotate-secret":
        out(await commandRotateSecret(parsed, cwd, runner));
        return 0;
      case "clean":
        out(await commandClean(parsed, cwd, runner));
        return 0;
      case "users":
      case "sessions":
        out(await commandRecovery(parsed, cwd, runner));
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
      `Would write ${template} package.json, pnpm-workspace.yaml, tsconfig.json, auth.config.ts, wrangler.jsonc, migrations, AGENTS.md, .gitignore, .dev.vars, .dev.vars.example, and route mount snippets.`,
    );
    out(templateMountSnippet(template));
    return;
  }
  await ensureSafeDirectory(target);
  await ensureSafeDirectory(join(target, "src"));
  await ensureSafeDirectory(join(target, "migrations"));
  const localSecret = `k_dev.${base64urlEncode(randomBytes(32))}`;
  const packageResult = await writeOrPatchPackageJson(
    join(target, "package.json"),
    packageName,
    template,
  );
  const wranglerConfigPath =
    (await existingWranglerPathForWrite(target)) ??
    join(target, "wrangler.jsonc");
  const wranglerConfigExists =
    (await safeFileInfo(wranglerConfigPath, true)) !== null;
  const sourceIndexPath = join(target, "src", "index.ts");
  const sourceIndexExists =
    (await safeFileInfo(sourceIndexPath, true)) !== null;
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
  await ensureGitignoreEntries(join(target, ".gitignore"));
  await writeIfMissing(
    join(target, ".dev.vars"),
    devVarsTemplate(localSecret),
    {
      mode: 0o600,
      enforceMode: true,
    },
  );
  await writeIfMissing(join(target, ".dev.vars.example"), devVarsTemplate());
  await writeIfMissing(join(target, "AGENTS.md"), agentsRunbookTemplate());
  await writeIfMissing(
    join(target, "migrations", "0001_initial.sql"),
    initialMigrationSql(),
  );
  await writeIfMissing(
    join(target, "migrations", "0002_indexes.sql"),
    indexesMigrationSql(),
  );
  const repaired = await repairWranglerConfig(target, workerName, {
    backupExisting: wranglerConfigExists,
  });
  if (repaired.changed) {
    out("Repaired Wrangler auth bindings and vars.");
    if (repaired.backupPath) {
      out(
        repaired.backupCreated
          ? `Backup written to ${repaired.backupPath}`
          : `Existing backup preserved at ${repaired.backupPath}`,
      );
    }
  }
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

const d1LocationChoices = new Set([
  "weur",
  "eeur",
  "apac",
  "oc",
  "wnam",
  "enam",
]);
const d1JurisdictionChoices = new Set(["eu", "fedramp"]);

async function commandProvision(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
): Promise<string> {
  const envName = requiredStringFlag(
    parsed.flags.env,
    "provision requires --env",
  );
  const location = optionalChoiceFlag(
    parsed.flags.location,
    "--location",
    d1LocationChoices,
  );
  const jurisdiction = optionalChoiceFlag(
    parsed.flags.jurisdiction,
    "--jurisdiction",
    d1JurisdictionChoices,
  );
  if (location && jurisdiction) {
    throw new Error(
      "provision accepts either --location or --jurisdiction, not both.",
    );
  }

  const config = await readWrangler(cwd);
  assertRemoteAuthEnvironment(config, envName, "Provisioning");
  const database = selectD1ForProvisioning(config, envName);
  const listCommand = {
    command: "wrangler",
    args: ["d1", "list", "--json", "--env", envName],
  };
  const createCommand = {
    command: "wrangler",
    args: [
      "d1",
      "create",
      database.database_name,
      ...(location ? ["--location", location] : []),
      ...(jurisdiction ? ["--jurisdiction", jurisdiction] : []),
      "--env",
      envName,
    ],
  };
  if (parsed.flags["dry-run"]) {
    return [
      "Dry run only. Would resolve one accessible Cloudflare account and provision AUTH_DB.",
      displayCommand(listCommand.command, listCommand.args),
      `If ${database.database_name} is absent: ${displayCommand(createCommand.command, createCommand.args)}`,
      `Would back up ${basename(wranglerPath(cwd))} and patch AUTH_DB database_id without following symbolic links.`,
    ].join("\n");
  }

  const configPath = wranglerPath(cwd);
  await safeFileInfo(configPath);
  await safeFileInfo(`${configPath}.cf-auth-backup`, true);
  const accountId = resolveProvisionAccount(config, envName, cwd, runner);
  let databases = runD1List(listCommand, cwd, runner);
  let matches = databases.filter(
    (item) => item.name === database.database_name,
  );
  if (matches.length > 1) {
    throw new Error(
      `Cloudflare returned multiple D1 databases named ${database.database_name}; refusing to choose implicitly.`,
    );
  }
  let created = false;
  if (matches.length === 0) {
    if (isUsableD1DatabaseId(database.database_id)) {
      throw new Error(
        `Configured AUTH_DB database_id is not present as ${database.database_name} in the selected Cloudflare account.`,
      );
    }
    runCheckedCommand(createCommand, cwd, runner);
    created = true;
    databases = runD1List(listCommand, cwd, runner);
    matches = databases.filter((item) => item.name === database.database_name);
  }
  const provisioned = matches[0];
  if (!provisioned || matches.length !== 1) {
    throw new Error(
      `D1 database ${database.database_name} could not be resolved after provisioning.`,
    );
  }
  if (
    isUsableD1DatabaseId(database.database_id) &&
    database.database_id !== provisioned.uuid
  ) {
    throw new Error(
      `Configured AUTH_DB database_id does not match ${database.database_name} in the selected Cloudflare account.`,
    );
  }

  let changed = database.database_id !== provisioned.uuid;
  database.database_id = provisioned.uuid;
  if (!configuredAccountId(config, envName)) {
    config.account_id = accountId;
    changed = true;
  }
  let backupPath: string | undefined;
  let backupCreated = false;
  if (changed) {
    const backup = await writeConfigBackup(configPath);
    backupPath = backup.path;
    backupCreated = backup.created;
    await safeAtomicWriteFile(
      configPath,
      JSON.stringify(config, null, 2) + "\n",
    );
  }
  return [
    created
      ? `Created D1 database ${database.database_name}.`
      : `Found D1 database ${database.database_name}.`,
    changed
      ? `Patched AUTH_DB database_id in ${basename(wranglerPath(cwd))}.`
      : "AUTH_DB is already provisioned.",
    ...(backupPath
      ? [
          backupCreated
            ? `Backup written to ${backupPath}`
            : `Existing backup preserved at ${backupPath}`,
        ]
      : []),
  ].join("\n");
}

function requiredStringFlag(
  value: string | boolean | undefined,
  message: string,
): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${message}.`);
  return value.trim();
}

function optionalChoiceFlag(
  value: string | boolean | undefined,
  name: string,
  choices: Set<string>,
): string | undefined {
  if (value === undefined || value === false) return undefined;
  if (typeof value !== "string" || !choices.has(value)) {
    throw new Error(`${name} must be one of: ${[...choices].join(", ")}.`);
  }
  return value;
}

function optionalStringFlag(
  value: string | boolean | undefined,
  name: string,
): string | undefined {
  if (value === undefined || value === false) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} requires a value.`);
  }
  return value.trim();
}

function runD1List(
  command: { command: string; args: string[] },
  cwd: string,
  runner: CommandRunner,
): Array<{ name: string; uuid: string }> {
  const result = runner(command.command, command.args, { cwd });
  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${displayCommand(command.command, command.args)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler D1 list response could not be parsed.");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Wrangler D1 list response had unexpected shape.");
  }
  return parsed.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      typeof item.uuid !== "string" ||
      !item.name.trim() ||
      !item.uuid.trim()
    ) {
      throw new Error("Wrangler D1 list response had unexpected shape.");
    }
    return { name: item.name, uuid: item.uuid };
  });
}

async function commandMigrate(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
): Promise<string> {
  const command = await buildMigrateCommand(parsed, cwd);
  if (parsed.flags["dry-run"])
    return displayCommand(command.command, command.args);
  const target = targetMode(parsed);
  if (target.remote) {
    const config = await readWrangler(cwd);
    assertRemoteAccountAccess(
      config,
      parsed.flags.env as string | undefined,
      cwd,
      runner,
      "Remote migrations",
    );
  }
  const lines = [runCheckedCommand(command, cwd, runner)];
  if (!parsed.flags.status) {
    const envName = parsed.flags.env as string | undefined;
    const config = await readWrangler(cwd);
    const database = selectD1(config, envName, { remote: target.remote });
    const localMigrationVersions = await readLocalMigrationVersions(
      cwd,
      database,
    );
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
  if (target.remote) {
    assertRemoteAuthEnvironment(config, envName, "Remote migrations");
  }
  const database = selectD1(config, envName, {
    remote: target.remote && !parsed.flags["dry-run"],
  });
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
    migrations_dir?: string;
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
  } catch (error) {
    addCheck({
      id: "wrangler_config",
      status: "fail",
      ...wranglerConfigReadFailure(error),
    });
    return {
      ok: false,
      lines: renderDoctorLines(checks),
      report: buildDoctorReport(checks, envName),
    };
  }
  const selectedResult = selectWranglerEnvironment(config, envName);
  if (!selectedResult.ok) {
    addCheck({
      id: "wrangler_environment",
      status: "fail",
      message: selectedResult.message,
      fix: selectedResult.fix,
    });
    return {
      ok: false,
      lines: renderDoctorLines(checks),
      report: buildDoctorReport(checks, envName),
    };
  }
  const selected = selectedResult.config;
  for (const check of checkWorkersCompatibility(config, selected ?? config)) {
    addCheck(check);
  }
  if (selected.vars !== undefined && !isRecord(selected.vars)) {
    addCheck({
      id: "wrangler_vars",
      status: "fail",
      message: "Wrangler vars must be an object",
      fix: "set vars to an object with AUTH_ENV and AUTH_PUBLIC_ORIGIN",
    });
  }
  const vars = stringRecord(selected.vars);
  const remoteTarget =
    vars.AUTH_ENV === "preview" ||
    vars.AUTH_ENV === "production" ||
    Boolean(envName);
  if (
    selected.d1_databases !== undefined &&
    !Array.isArray(selected.d1_databases)
  ) {
    addCheck({
      id: "d1_binding",
      status: "fail",
      message: "Wrangler d1_databases must be an array",
      fix: "set d1_databases to an array containing the AUTH_DB binding",
    });
  }
  const authD1Bindings = Array.isArray(selected.d1_databases)
    ? selected.d1_databases.filter(
        (item) => isRecord(item) && item.binding === "AUTH_DB",
      )
    : [];
  if (authD1Bindings.length > 1) {
    addCheck({
      id: "d1_binding",
      status: "fail",
      message: "Wrangler config must contain exactly one AUTH_DB D1 binding",
      fix: "remove duplicate AUTH_DB entries from the selected Wrangler environment",
    });
  } else if (authD1Bindings.length === 1) {
    const candidate = authD1Bindings[0];
    if (isAuthD1Binding(candidate)) d1 = candidate;
    else {
      addCheck({
        id: "d1_binding",
        status: "fail",
        message: "D1 binding AUTH_DB has invalid fields",
        fix: "set string database_name, database_id, and migrations_dir values for AUTH_DB",
      });
    }
  }
  if (authD1Bindings.length === 0) {
    addCheck({
      id: "d1_binding",
      status: "fail",
      message: "D1 binding AUTH_DB is missing",
      fix: "npx --package @cf-auth/cli@latest cf-auth init --repair or add d1_databases binding AUTH_DB",
    });
  } else if (d1 && !d1.database_name?.trim()) {
    addCheck({
      id: "d1_database_name",
      status: "fail",
      message: "D1 database_name is missing for AUTH_DB",
      fix: "set database_name for the AUTH_DB D1 binding",
    });
  } else if (
    d1 &&
    d1.migrations_dir !== undefined &&
    !d1.migrations_dir.trim()
  ) {
    addCheck({
      id: "d1_migrations_dir",
      status: "fail",
      message: "D1 binding AUTH_DB migrations_dir is empty",
      fix: "remove migrations_dir to use migrations or set a non-empty relative path",
    });
  } else if (d1 && remoteTarget && !d1.database_id?.trim()) {
    addCheck({
      id: "d1_database_id",
      status: "fail",
      message: "D1 database_id is missing for remote target",
      fix: "set the real D1 database_id for AUTH_DB in the selected Wrangler environment",
    });
  } else if (d1 && isPlaceholderD1DatabaseId(d1.database_id)) {
    addCheck({
      id: "d1_database_id",
      status: "fail",
      message: "D1 database_id is still a placeholder",
      fix: "set the real D1 database_id for AUTH_DB",
    });
  } else if (d1) {
    addCheck({
      id: "d1_binding",
      status: "pass",
      message: "D1 binding AUTH_DB configured",
    });
  }
  const localMigrationVersions = d1
    ? await readLocalMigrationVersions(cwd, d1)
    : [];
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
  } else if (remoteTarget && vars.AUTH_ENV === "development") {
    addCheck({
      id: "auth_env",
      status: "fail",
      message: "Remote targets must not use AUTH_ENV=development",
      fix: "set the selected Wrangler environment vars.AUTH_ENV to preview or production",
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
  const authSource = await inspectAuthSource(cwd, vars.AUTH_ENV);
  for (const check of checkAuthSource(authSource, vars, remoteTarget)) {
    addCheck(check);
  }
  addCheck(
    await checkPasswordBenchmark(authSource, remoteTarget, passwordBenchmark),
  );
  let remoteAccountVerified = !remoteTarget;
  if (remoteTarget) {
    const accountCheck = checkCloudflareAccount(
      cwd,
      runner,
      selected ?? config,
      config,
    );
    addCheck(accountCheck);
    remoteAccountVerified = accountCheck.status === "pass";
  }
  if (remoteAccountVerified && d1 && localMigrationVersions.length > 0) {
    const migrationCheck = checkD1MigrationState({
      cwd,
      runner,
      databaseName: d1.database_name,
      envName,
      remote: remoteTarget,
      localMigrationVersions,
      allowUninitialized: Boolean(options.allowPendingMigrations),
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
      ? findSendEmailBinding(selected, "AUTH_EMAIL")
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
    if (remoteAccountVerified) {
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
  const reportChecks = checks.map((check) => ({
    ...check,
    message: redactCliOutput(check.message),
    ...(check.fix ? { fix: redactCliOutput(check.fix) } : {}),
  }));
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
    environment: redactCliOutput(envName ?? "default"),
    summary,
    checks: reportChecks,
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

function isPlaceholderD1DatabaseId(value: string | undefined): boolean {
  const normalized = value?.trim().toUpperCase();
  return Boolean(normalized && normalized.startsWith("REPLACE_"));
}

function isUsableD1DatabaseId(value: string | undefined): value is string {
  return Boolean(value?.trim()) && !isPlaceholderD1DatabaseId(value);
}

function checkCloudflareAccount(
  cwd: string,
  runner: CommandRunner,
  selected: WranglerConfig,
  root: WranglerConfig,
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
  const configuredAccount =
    selected.account_id?.trim() ||
    root.account_id?.trim() ||
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
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
  return {
    id: "cloudflare_account",
    status: "fail",
    message:
      "Cloudflare account selection is implicit because account_id is missing",
    fix: "run cf-auth provision --env production or set account_id in wrangler.jsonc",
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
  const accountIds = new Set<string>();
  if (Array.isArray(parsed.accounts)) {
    for (const item of parsed.accounts) {
      if (!isRecord(item) || typeof item.id !== "string") continue;
      const id = item.id.trim();
      if (id) accountIds.add(id);
    }
  }
  const accounts = [...accountIds].map((id) => ({ id }));
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

function configuredAccountId(
  config: WranglerConfig,
  envName: string | undefined,
): string | undefined {
  const selected = envName ? config.env?.[envName] : config;
  return (
    selected?.account_id?.trim() ||
    config.account_id?.trim() ||
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ||
    undefined
  );
}

function readAccessibleAccounts(
  cwd: string,
  runner: CommandRunner,
  label: string,
): Array<{ id: string }> {
  const result = runner("wrangler", ["whoami", "--json"], { cwd });
  if (result.status !== 0) {
    throw new Error(`${label} could not verify the Cloudflare account.`);
  }
  const account = parseWhoamiResult(result.stdout);
  if (!account.ok) {
    throw new Error(`${label} could not verify the Cloudflare account.`);
  }
  return account.accounts;
}

function assertRemoteAccountAccess(
  config: WranglerConfig,
  envName: string | undefined,
  cwd: string,
  runner: CommandRunner,
  label: string,
): string {
  const configured = configuredAccountId(config, envName);
  if (!configured) {
    throw new Error(
      `${label} requires an explicit account_id. Run cf-auth provision --env ${envName ?? "production"} or set account_id in Wrangler config.`,
    );
  }
  const accounts = readAccessibleAccounts(cwd, runner, label);
  if (!accounts.some((item) => item.id === configured)) {
    throw new Error(
      `${label} account_id is not available to the authenticated Wrangler user.`,
    );
  }
  return configured;
}

function resolveProvisionAccount(
  config: WranglerConfig,
  envName: string,
  cwd: string,
  runner: CommandRunner,
): string {
  const accounts = readAccessibleAccounts(cwd, runner, "Provisioning");
  const configured = configuredAccountId(config, envName);
  if (configured) {
    if (!accounts.some((item) => item.id === configured)) {
      throw new Error(
        "Provisioning account_id is not available to the authenticated Wrangler user.",
      );
    }
    return configured;
  }
  if (accounts.length !== 1) {
    throw new Error(
      "Provisioning requires account_id when Wrangler can access multiple Cloudflare accounts.",
    );
  }
  return accounts[0]!.id;
}

function checkD1MigrationState(options: {
  cwd: string;
  runner: CommandRunner;
  databaseName: string;
  envName: string | undefined;
  remote: boolean;
  localMigrationVersions: string[];
  allowUninitialized?: boolean;
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
    const detail = `${result.stderr}\n${result.stdout}`;
    if (
      options.allowUninitialized &&
      /no such table:\s*(?:auth_schema_migrations|auth_meta)/iu.test(detail)
    ) {
      return {
        id: "d1_migrations",
        status: "fail",
        message: `D1 migration ${options.localMigrationVersions[0] ?? "0001"} has not been applied ${target}ly; the auth schema is uninitialized`,
        fix: migrationFix(options.remote, options.envName),
      };
    }
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
  if (!state.ok) {
    return {
      ok: false,
      check: {
        id: "d1_migrations",
        status: "fail",
        message: "D1 migration state response had unexpected shape",
        fix: "rerun doctor after confirming wrangler d1 execute --json works",
      },
    };
  }
  return {
    ok: true,
    versions: state.versions,
    schemaVersion: state.schemaVersion,
  };
}

function collectD1MigrationState(value: unknown):
  | {
      ok: true;
      versions: string[];
      schemaVersion: string | undefined;
    }
  | { ok: false } {
  const versions = new Set<string>();
  let schemaVersion: string | undefined;
  let foundResults = false;
  let malformed = false;
  const visit = (item: unknown, rowContext = false) => {
    if (malformed) return;
    if (Array.isArray(item)) {
      for (const child of item) visit(child, rowContext);
      return;
    }
    if (!isRecord(item)) {
      if (rowContext) malformed = true;
      return;
    }
    const resultKeys = ["result", "results"].filter((key) => key in item);
    if (resultKeys.length > 0) {
      for (const key of resultKeys) {
        const rows = item[key];
        if (!Array.isArray(rows)) {
          malformed = true;
          return;
        }
        foundResults = true;
        visit(rows, true);
      }
      return;
    }
    if (!rowContext) return;
    const hasVersion = "version" in item;
    const hasValue = "value" in item;
    if (!hasVersion && !hasValue) {
      malformed = true;
      return;
    }
    if (hasVersion) {
      if (typeof item.version !== "string") {
        malformed = true;
        return;
      }
      versions.add(item.version);
    }
    if (hasValue) {
      if (typeof item.value !== "string") {
        malformed = true;
        return;
      }
      schemaVersion = item.value;
    }
  };
  visit(value);
  if (malformed || !foundResults) return { ok: false };
  return { ok: true, versions: [...versions].sort(), schemaVersion };
}

async function commandDeploy(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
  passwordBenchmark: PasswordBenchmarkRunner,
  options: {
    doctor?: { ok: boolean; lines: string[]; report: DoctorReport };
  } = {},
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
  const doctor =
    options.doctor ??
    (await commandDoctor(parsed, cwd, runner, passwordBenchmark, {
      allowPendingMigrations: Boolean(parsed.flags.migrate),
    }));
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
  if (parsed.flags["dry-run"]) {
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
      const database = selectD1(config, envName, { remote: true });
      const migrationVerify = buildD1ExecuteCommand(
        {
          databaseName: database.database_name,
          remote: true,
          ...(envName ? { envName } : {}),
        },
        migrationStateSql(),
        true,
      );
      planned.splice(
        2,
        0,
        displayCommand(migrateApply.command, migrateApply.args),
        displayCommand(migrationVerify.command, migrationVerify.args),
      );
    }
    return planned.join("\n");
  }

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
    const database = selectD1(config, envName, { remote: true });
    const localMigrationVersions = await readLocalMigrationVersions(
      cwd,
      database,
    );
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

const setupCliCommand = "npx --package @cf-auth/cli@latest cf-auth";

interface SetupIO {
  passwordBenchmark: PasswordBenchmarkRunner;
  fetchImpl: typeof globalThis.fetch;
  sleepMs: (ms: number) => Promise<void>;
}

async function commandSetup(
  parsed: ParsedArgs,
  cwd: string,
  out: (line: string) => void,
  err: (line: string) => void,
  runner: CommandRunner,
  io: SetupIO,
): Promise<{ ok: boolean; report: SetupReport }> {
  const envName = requiredStringFlag(parsed.flags.env, "setup requires --env");
  const originFlag = optionalStringFlag(parsed.flags.origin, "--origin");
  optionalStringFlag(parsed.flags.output, "--output");
  const location = optionalChoiceFlag(
    parsed.flags.location,
    "--location",
    d1LocationChoices,
  );
  const jurisdiction = optionalChoiceFlag(
    parsed.flags.jurisdiction,
    "--jurisdiction",
    d1JurisdictionChoices,
  );
  if (location && jurisdiction) {
    throw new Error(
      "setup accepts either --location or --jurisdiction, not both.",
    );
  }
  if (originFlag) validateSetupOrigin(originFlag);
  const rerunCommand = `${setupCliCommand} setup --env ${envName}`;

  if (parsed.flags["dry-run"]) {
    return setupDryRun(parsed, cwd, runner, envName, originFlag, out);
  }

  const steps: SetupStep[] = [];
  const reportMode = Boolean(parsed.flags.report);
  let doctorResult:
    { ok: boolean; lines: string[]; report: DoctorReport } | undefined;
  let resolvedOrigin: string | undefined;
  let deployOutput: string | undefined;

  const record = (step: SetupStep): void => {
    if (step.status === "fail" && !step.fix) {
      step.fix = `rerun ${rerunCommand}`;
    }
    steps.push(step);
    if (reportMode) return;
    const icon =
      step.status === "pass"
        ? "✓"
        : step.status === "warn"
          ? "!"
          : step.status === "skipped"
            ? "-"
            : "✗";
    out(`${icon} ${step.id}: ${redactCliOutput(step.message)}`);
    if (step.fix && step.status === "fail") {
      out(`  Fix: ${redactCliOutput(step.fix)}`);
    }
  };
  const failed = (): boolean => steps.some((step) => step.status === "fail");
  const runStep = async (
    id: string,
    action: () => Promise<SetupStep> | SetupStep,
    fallbackFix: string | ((message: string) => string),
  ): Promise<void> => {
    if (failed()) {
      record({
        id,
        status: "skipped",
        message: "skipped after an earlier failure",
      });
      return;
    }
    try {
      record(await action());
    } catch (error) {
      const message = redactCliOutput(
        error instanceof Error ? error.message : String(error),
      );
      record({
        id,
        status: "fail",
        message,
        fix:
          typeof fallbackFix === "function"
            ? fallbackFix(message)
            : fallbackFix,
      });
    }
  };

  await runStep(
    "preflight",
    async () => {
      const wranglerCheck = checkWranglerVersion(cwd, runner);
      if (wranglerCheck.status === "fail") {
        return {
          id: "preflight",
          status: "fail",
          message: wranglerCheck.message,
          fix:
            wranglerCheck.fix ?? `install wrangler ${supportedWranglerVersion}`,
        };
      }
      let config: WranglerConfig;
      try {
        config = await readWrangler(cwd);
      } catch (error) {
        const failure = wranglerConfigReadFailure(error);
        return {
          id: "preflight",
          status: "fail",
          message: failure.message,
          fix: failure.fix,
        };
      }
      const selected = selectWranglerEnvironment(config, envName);
      if (!selected.ok) {
        return {
          id: "preflight",
          status: "fail",
          message: selected.message,
          fix: selected.fix,
        };
      }
      try {
        assertRemoteAuthEnvironment(config, envName, "Setup");
      } catch (error) {
        return {
          id: "preflight",
          status: "fail",
          message: error instanceof Error ? error.message : String(error),
          fix: `set env.${envName} vars.AUTH_ENV to preview or production in ${basename(wranglerPath(cwd))}`,
        };
      }
      const whoami = runner("wrangler", ["whoami", "--json"], { cwd });
      if (whoami.status !== 0) {
        return {
          id: "preflight",
          status: "fail",
          message: "Cloudflare login could not be verified",
          fix: "run wrangler login or export CLOUDFLARE_API_TOKEN with the scopes in docs/cloudflare-permissions.md",
        };
      }
      const account = parseWhoamiResult(whoami.stdout);
      if (!account.ok) {
        return {
          id: "preflight",
          status: "fail",
          message: account.check.message,
          fix:
            account.check.fix ?? "run wrangler whoami --json and rerun setup",
        };
      }
      const configured = configuredAccountId(config, envName);
      if (
        configured &&
        !account.accounts.some((item) => item.id === configured)
      ) {
        return {
          id: "preflight",
          status: "fail",
          message:
            "Configured account_id is not available to the authenticated Wrangler user",
          fix: "set CLOUDFLARE_ACCOUNT_ID or account_id to a Cloudflare account the token can access",
        };
      }
      if (!configured && account.accounts.length !== 1) {
        return {
          id: "preflight",
          status: "fail",
          message:
            "Setup requires account_id when Wrangler can access multiple Cloudflare accounts",
          fix: `set CLOUDFLARE_ACCOUNT_ID or account_id in ${basename(wranglerPath(cwd))}, then rerun ${rerunCommand}`,
        };
      }
      const versionNote =
        wranglerCheck.status === "warn" ? `; ${wranglerCheck.message}` : "";
      return {
        id: "preflight",
        status: wranglerCheck.status === "warn" ? "warn" : "pass",
        message: `Wrangler available and Cloudflare account access verified${versionNote}`,
      };
    },
    (message) =>
      `resolve the reported preflight issue (${message}), then rerun ${rerunCommand}`,
  );

  await runStep(
    "origin",
    async () => {
      if (originFlag) {
        const patched = await patchAuthPublicOrigin(cwd, envName, originFlag);
        resolvedOrigin = originFlag;
        const backupNote = patched.backupPath
          ? patched.backupCreated
            ? `; backup written to ${patched.backupPath}`
            : `; existing backup preserved at ${patched.backupPath}`
          : "";
        return {
          id: "origin",
          status: "pass",
          message: patched.changed
            ? `Set vars.AUTH_PUBLIC_ORIGIN for env.${envName} in ${basename(wranglerPath(cwd))}${backupNote}`
            : `vars.AUTH_PUBLIC_ORIGIN already set for env.${envName}`,
        };
      }
      const config = await readWrangler(cwd);
      const selected = selectWranglerEnvironment(config, envName);
      const origin = selected.ok
        ? stringRecord(selected.config.vars).AUTH_PUBLIC_ORIGIN
        : undefined;
      if (
        !origin ||
        isPlaceholderPublicOrigin(origin) ||
        !isExactHttpsOrigin(origin)
      ) {
        return {
          id: "origin",
          status: "fail",
          message: `vars.AUTH_PUBLIC_ORIGIN for env.${envName} is missing, a placeholder, or not an exact https origin`,
          fix: `rerun ${rerunCommand} --origin <https-origin> (a workers.dev origin looks like https://<worker-name>.<subdomain>.workers.dev; see docs/manual-steps.md)`,
        };
      }
      resolvedOrigin = origin;
      return {
        id: "origin",
        status: "pass",
        message: `AUTH_PUBLIC_ORIGIN configured (${origin})`,
      };
    },
    (message) =>
      `resolve the public-origin issue (${message}), then rerun ${rerunCommand}`,
  );

  await runStep(
    "provision",
    async () => {
      const message = await commandProvision(parsed, cwd, runner);
      return { id: "provision", status: "pass", message };
    },
    (message) =>
      /multiple Cloudflare accounts/u.test(message)
        ? `set CLOUDFLARE_ACCOUNT_ID or account_id in ${basename(wranglerPath(cwd))}, then rerun ${rerunCommand}`
        : `resolve the reported provisioning issue, then rerun ${rerunCommand}`,
  );

  await runStep(
    "migrate",
    async () => {
      await commandMigrate(
        {
          command: "migrate",
          positionals: [],
          flags: { remote: true, env: envName },
        },
        cwd,
        runner,
      );
      return {
        id: "migrate",
        status: "pass",
        message: "Remote D1 migrations applied and verified",
      };
    },
    `${setupCliCommand} migrate --remote --env ${envName}`,
  );

  await runStep(
    "secret",
    () => {
      const probe = probeRemoteSecretName("AUTH_SECRET", envName, cwd, runner);
      if (probe === "present") {
        return {
          id: "secret",
          status: "pass",
          message:
            "Remote AUTH_SECRET already configured; left unchanged (setup never rotates an existing secret)",
        };
      }
      if (probe === "unavailable") {
        return {
          id: "secret",
          status: "fail",
          message: "Remote AUTH_SECRET could not be verified",
          fix: `run wrangler login or use an API token with Workers Scripts:Edit, then rerun ${rerunCommand}`,
        };
      }
      const kid =
        typeof parsed.flags.kid === "string" ? parsed.flags.kid : "k1";
      const secret = generateAuthSecret(kid);
      runSecretBulk(envName, cwd, runner, { AUTH_SECRET: secret });
      return {
        id: "secret",
        status: "pass",
        message:
          probe === "worker-missing"
            ? "Created remote AUTH_SECRET; Wrangler created a draft Worker to hold it before the first deploy"
            : "Created remote AUTH_SECRET",
      };
    },
    `resolve the secret failure, then rerun ${rerunCommand}`,
  );

  await runStep(
    "doctor",
    async () => {
      const doctor = await commandDoctor(
        parsed,
        cwd,
        runner,
        io.passwordBenchmark,
        {},
      );
      doctorResult = doctor;
      if (doctor.ok) {
        return {
          id: "doctor",
          status: "pass",
          message: `doctor checks passed for --env ${envName}`,
        };
      }
      const firstFail = doctor.report.checks.find(
        (check) => check.status === "fail",
      );
      return {
        id: "doctor",
        status: "fail",
        message: firstFail
          ? `doctor: ${firstFail.message}`
          : "doctor checks failed",
        fix: firstFail?.fix ?? `${setupCliCommand} doctor --env ${envName}`,
      };
    },
    `${setupCliCommand} doctor --env ${envName}`,
  );

  await runStep(
    "deploy",
    async () => {
      if (!doctorResult) {
        throw new Error("doctor step did not run before deploy");
      }
      try {
        deployOutput = await commandDeploy(
          { command: "deploy", positionals: [], flags: { env: envName } },
          cwd,
          runner,
          io.passwordBenchmark,
          { doctor: doctorResult },
        );
        return {
          id: "deploy",
          status: "pass",
          message: `Deployed with wrangler --env ${envName}`,
        };
      } catch (error) {
        const message = redactCliOutput(
          error instanceof Error ? error.message : String(error),
        );
        if (/register a workers\.dev subdomain/iu.test(message)) {
          const accountId = await setupAccountIdForFix(cwd, envName);
          return {
            id: "deploy",
            status: "fail",
            message,
            fix: `register a workers.dev subdomain at https://dash.cloudflare.com/${accountId}/workers/onboarding (a one-time manual step; see docs/manual-steps.md), then rerun ${rerunCommand}`,
          };
        }
        return {
          id: "deploy",
          status: "fail",
          message,
          fix: `resolve the wrangler deploy failure, then rerun ${rerunCommand}`,
        };
      }
    },
    `resolve the wrangler deploy failure, then rerun ${rerunCommand}`,
  );

  if (
    !failed() &&
    deployOutput &&
    resolvedOrigin &&
    resolvedOrigin.endsWith(".workers.dev")
  ) {
    const deployedUrl = deployOutput.match(
      /https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev/iu,
    )?.[0];
    const deployedOrigin = deployedUrl
      ? parseOriginOrUndefined(deployedUrl)
      : undefined;
    if (deployedOrigin && deployedOrigin !== resolvedOrigin) {
      record({
        id: "origin_verification",
        status: "warn",
        message: `Deployed workers.dev origin ${deployedOrigin} does not match AUTH_PUBLIC_ORIGIN ${resolvedOrigin}`,
        fix: `if the workers.dev URL is the intended public origin, rerun ${rerunCommand} --origin ${deployedOrigin}`,
      });
    }
  }

  await runStep(
    "verify",
    async () => {
      if (parsed.flags["skip-verify"]) {
        return {
          id: "verify",
          status: "skipped",
          message: "skipped by --skip-verify",
        };
      }
      if (!resolvedOrigin) {
        throw new Error("verify requires a resolved AUTH_PUBLIC_ORIGIN");
      }
      const cleanupNote = await verifyDeployedAuth(
        resolvedOrigin,
        cwd,
        envName,
        runner,
        io,
      );
      return {
        id: "verify",
        status: "pass",
        message: `signup, login, and logout verified at ${resolvedOrigin}; ${cleanupNote}`,
      };
    },
    () =>
      `confirm ${resolvedOrigin ?? "AUTH_PUBLIC_ORIGIN"} serves this Worker (route, custom domain, DNS), inspect wrangler tail --env ${envName}, then rerun ${rerunCommand}`,
  );

  const report = buildSetupReport(steps, envName, doctorResult?.report);
  if (!reportMode) {
    if (report.ok) {
      out(`Setup complete for environment ${envName}.`);
      out(deploymentSummary());
    } else if (report.nextAction) {
      err(`Next action: ${report.nextAction}`);
    }
  }
  return { ok: report.ok, report };
}

async function setupDryRun(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
  envName: string,
  originFlag: string | undefined,
  out: (line: string) => void,
): Promise<{ ok: boolean; report: SetupReport }> {
  const config = await readWrangler(cwd);
  const database = selectD1ForProvisioning(config, envName);
  const provisionPlan = await commandProvision(parsed, cwd, runner);
  const migrateApply = await buildMigrateCommand(
    {
      command: "migrate",
      positionals: [],
      flags: { remote: true, "dry-run": true, env: envName },
    },
    cwd,
  );
  const migrationVerify = buildD1ExecuteCommand(
    { databaseName: database.database_name, remote: true, envName },
    migrationStateSql(),
    true,
  );
  const migrationStatus = await buildMigrateCommand(
    {
      command: "migrate",
      positionals: [],
      flags: { status: true, remote: true, "dry-run": true, env: envName },
    },
    cwd,
  );
  const planned: SetupStep[] = [
    {
      id: "preflight",
      status: "skipped",
      message: `Would check wrangler availability, ${basename(wranglerPath(cwd))}, env.${envName}, and Cloudflare account access.`,
    },
    {
      id: "origin",
      status: "skipped",
      message: originFlag
        ? `Would set vars.AUTH_PUBLIC_ORIGIN=${originFlag} for env.${envName} with a ${basename(wranglerPath(cwd))} backup.`
        : `Would require vars.AUTH_PUBLIC_ORIGIN for env.${envName} to be an exact https origin.`,
    },
    { id: "provision", status: "skipped", message: provisionPlan },
    {
      id: "migrate",
      status: "skipped",
      message: [
        displayCommand(migrateApply.command, migrateApply.args),
        displayCommandForVerbose(migrationVerify.command, migrationVerify.args),
      ].join("\n"),
    },
    {
      id: "secret",
      status: "skipped",
      message: `If AUTH_SECRET is missing remotely: wrangler secret bulk --env ${envName} (secret JSON via stdin; values are not printed).`,
    },
    {
      id: "doctor",
      status: "skipped",
      message: `cf-auth doctor --env ${envName}`,
    },
    {
      id: "deploy",
      status: "skipped",
      message: [
        displayCommand(migrationStatus.command, migrationStatus.args),
        displayCommand("wrangler", ["deploy", "--env", envName]),
      ].join("\n"),
    },
    {
      id: "verify",
      status: "skipped",
      message: parsed.flags["skip-verify"]
        ? "Would skip deployed endpoint verification (--skip-verify)."
        : "Would verify deployed /auth signup, login, and logout at the configured AUTH_PUBLIC_ORIGIN and disable the throwaway verification user.",
    },
  ];
  if (!parsed.flags.report) {
    out(
      `Dry run only. Would run setup for environment ${envName} without changing Cloudflare state.`,
    );
    for (const step of planned) out(step.message);
  }
  return { ok: true, report: buildSetupReport(planned, envName) };
}

function buildSetupReport(
  steps: SetupStep[],
  envName: string,
  doctor?: DoctorReport,
): SetupReport {
  const reportSteps = steps.map((step) => ({
    ...step,
    message: redactCliOutput(step.message),
    ...(step.fix ? { fix: redactCliOutput(step.fix) } : {}),
  }));
  const summary = {
    pass: reportSteps.filter((step) => step.status === "pass").length,
    fail: reportSteps.filter((step) => step.status === "fail").length,
    warn: reportSteps.filter((step) => step.status === "warn").length,
    skipped: reportSteps.filter((step) => step.status === "skipped").length,
  };
  const firstFail = reportSteps.find((step) => step.status === "fail");
  return {
    $schema: "https://cf-auth.dev/schemas/setup-report.v1.json",
    schemaVersion: 1,
    ok: summary.fail === 0,
    generatedAt: new Date().toISOString(),
    environment: redactCliOutput(envName),
    summary,
    steps: reportSteps,
    ...(firstFail?.fix ? { nextAction: firstFail.fix } : {}),
    ...(doctor ? { doctor } : {}),
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

async function setupAccountIdForFix(
  cwd: string,
  envName: string,
): Promise<string> {
  try {
    const config = await readWrangler(cwd);
    return configuredAccountId(config, envName) ?? "<account-id>";
  } catch {
    return "<account-id>";
  }
}

function parseOriginOrUndefined(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

async function verifyDeployedAuth(
  origin: string,
  cwd: string,
  envName: string,
  runner: CommandRunner,
  io: SetupIO,
): Promise<string> {
  const email = `setup-verify-${Date.now()}-${randomBytes(4).toString("hex")}@example.com`;
  const password = base64urlEncode(randomBytes(18));
  await waitForDeployedAuth(origin, io);
  const signup = await setupJsonPost(io, `${origin}/auth/signup`, {
    email,
    password,
  });
  if (signup.status !== 200) {
    throw new Error(
      `deployed signup failed with HTTP ${signup.status}; confirm ${origin} serves this Worker`,
    );
  }
  assertSetupSessionCookie(signup.headers.get("Set-Cookie") ?? "", "signup");
  const login = await setupJsonPost(io, `${origin}/auth/login`, {
    identifier: email,
    password,
  });
  if (login.status !== 200) {
    throw new Error(`deployed login failed with HTTP ${login.status}`);
  }
  const loginCookie = login.headers.get("Set-Cookie") ?? "";
  assertSetupSessionCookie(loginCookie, "login");
  const cookie = loginCookie.split(";")[0] ?? "";
  const user = await io.fetchImpl(`${origin}/auth/user`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(10_000),
  });
  if (user.status !== 200) {
    throw new Error(`deployed user endpoint failed with HTTP ${user.status}`);
  }
  const body: unknown = await user.json();
  const userEmail =
    isRecord(body) && isRecord(body.user) ? body.user.email : undefined;
  if (userEmail !== email) {
    throw new Error(
      "deployed user endpoint did not return the verification user",
    );
  }
  const logout = await io.fetchImpl(`${origin}/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin },
    signal: AbortSignal.timeout(10_000),
  });
  if (logout.status !== 200) {
    throw new Error(`deployed logout failed with HTTP ${logout.status}`);
  }
  assertSetupSessionCookie(logout.headers.get("Set-Cookie") ?? "", "logout", {
    cleared: true,
  });
  const after = await io.fetchImpl(`${origin}/auth/user`, {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(10_000),
  });
  if (after.status !== 200) {
    throw new Error(
      `deployed user endpoint after logout failed with HTTP ${after.status}`,
    );
  }
  const afterBody: unknown = await after.json();
  if (!isRecord(afterBody) || afterBody.user !== null) {
    throw new Error(
      "deployed user endpoint still returned a user after logout",
    );
  }
  return disableVerificationUser(email, cwd, envName, runner);
}

async function waitForDeployedAuth(origin: string, io: SetupIO): Promise<void> {
  let lastFailure = "no response";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) await io.sleepMs(5000);
    try {
      const response = await io.fetchImpl(`${origin}/auth/user`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 200) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(
    `deployed /auth/user did not become ready at ${origin} (${lastFailure})`,
  );
}

function setupJsonPost(
  io: SetupIO,
  url: string,
  body: Record<string, string>,
): ReturnType<typeof globalThis.fetch> {
  return io.fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: new URL(url).origin,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

function assertSetupSessionCookie(
  setCookie: string,
  context: string,
  options: { cleared?: boolean } = {},
): void {
  if (!setCookie.includes("__Host-cfauth-session=")) {
    throw new Error(
      `${context} did not set a host-only Cloudflare Auth session cookie`,
    );
  }
  if (!/;\s*Secure(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${context} session cookie missing Secure`);
  }
  if (!/;\s*HttpOnly(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${context} session cookie missing HttpOnly`);
  }
  if (!/;\s*Path=\/(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${context} session cookie missing Path=/`);
  }
  if (/;\s*Domain=/iu.test(setCookie)) {
    throw new Error(`${context} session cookie must not set Domain`);
  }
  if (options.cleared && !/;\s*Max-Age=0(?:;|$)/iu.test(setCookie)) {
    throw new Error(`${context} did not clear the session cookie`);
  }
}

async function disableVerificationUser(
  email: string,
  cwd: string,
  envName: string,
  runner: CommandRunner,
): Promise<string> {
  try {
    const config = await readWrangler(cwd);
    const database = selectD1(config, envName, { remote: true });
    const context: D1CommandContext = {
      databaseName: database.database_name,
      remote: true,
      envName,
    };
    const now = d1NowMillisecondsSql();
    const target = userWhereClause(email);
    const sql = [
      `UPDATE users SET disabled_at = ${now}, updated_at = ${now} WHERE ${target}`,
      `UPDATE sessions SET revoked_at = ${now} WHERE user_id IN (SELECT id FROM users WHERE ${target}) AND revoked_at IS NULL`,
    ].join("; ");
    runRedactedD1Command(
      buildD1ExecuteCommand(context, sql),
      "wrangler d1 execute <redacted verification cleanup SQL>",
      cwd,
      runner,
    );
    return "throwaway verification user disabled";
  } catch {
    return `warning: the throwaway verification user could not be disabled; disable the newest setup-verify-* user with ${setupCliCommand} users disable <email> --remote --env ${envName}`;
  }
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

function verboseRunner(
  runner: CommandRunner,
  log: (line: string) => void,
): CommandRunner {
  return (command, args, options) => {
    log(`$ ${displayCommandForVerbose(command, args)}`);
    return runner(command, args, options);
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
  if (!names.ok) {
    return {
      id: remoteSecretCheckId(input.name),
      status: "fail",
      message: input.unavailableMessage,
      fix: input.unavailableFix ?? input.fix,
    };
  }
  if (!names.names.has(input.name)) {
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

function parseSecretNames(
  text: string,
): { ok: true; names: Set<string> } | { ok: false } {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return { ok: false };
    const names = new Set<string>();
    for (const item of parsed) {
      if (typeof item === "string") {
        names.add(item);
      } else if (isRecord(item) && typeof item.name === "string") {
        names.add(item.name);
      } else {
        return { ok: false };
      }
    }
    return { ok: true, names };
  } catch {
    return { ok: false };
  }
}

type RemoteSecretProbe =
  "present" | "missing" | "worker-missing" | "unavailable";

function probeRemoteSecretName(
  name: string,
  envName: string | undefined,
  cwd: string,
  runner: CommandRunner,
): RemoteSecretProbe {
  const args = [
    "secret",
    "list",
    "--format",
    "json",
    ...(envName ? ["--env", envName] : []),
  ];
  const result = runner("wrangler", args, { cwd });
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`;
    return /\bnot found\b/iu.test(detail) ? "worker-missing" : "unavailable";
  }
  const names = parseSecretNames(result.stdout);
  if (!names.ok) return "unavailable";
  return names.names.has(name) ? "present" : "missing";
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
  let pkg: unknown;
  try {
    pkg = JSON.parse(await safeReadFile(join(cwd, "package.json")));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return null;
    }
    if (error instanceof SyntaxError) {
      return malformedPackageVersionCheck(
        "package.json could not be parsed; Cloudflare Auth package versions could not be verified",
        remoteTarget,
      );
    }
    return malformedPackageVersionCheck(
      "package.json could not be read; Cloudflare Auth package versions could not be verified",
      remoteTarget,
    );
  }
  if (!isRecord(pkg)) {
    return malformedPackageVersionCheck(
      "package.json is not a JSON object; Cloudflare Auth package versions could not be verified",
      remoteTarget,
    );
  }
  const dependencyEntries = collectPackageDependencyEntries(pkg, remoteTarget);
  if (!dependencyEntries.ok) return dependencyEntries.check;
  const cfAuthEntries = dependencyEntries.entries.filter(([name]) =>
    isCfAuthPackageName(name),
  );
  if (cfAuthEntries.length === 0) return null;
  const workspaceEntries = cfAuthEntries.filter(([, version]) =>
    version.startsWith("workspace:"),
  );
  if (remoteTarget && workspaceEntries.length > 0) {
    return {
      id: "package_versions",
      status: "fail",
      message:
        "Cloudflare Auth dependencies use workspace protocol in a deploy target",
      fix: "pin published @cf-auth package versions before preview or production deploy",
    };
  }
  const localFileEntries = cfAuthEntries.filter(([, version]) =>
    version.startsWith("file:"),
  );
  const allowLocalFileSpecs =
    process.env.CF_AUTH_ALLOW_LOCAL_PACKAGE_SPECS === "1";
  if (remoteTarget && localFileEntries.length > 0 && !allowLocalFileSpecs) {
    return {
      id: "package_versions",
      status: "fail",
      message:
        "Cloudflare Auth dependencies use local file specs in a deploy target",
      fix: "pin published @cf-auth package versions before preview or production deploy",
    };
  }
  const comparableVersions = cfAuthEntries
    .map(([, version]) => version)
    .filter(
      (version) =>
        !version.startsWith("workspace:") && !version.startsWith("file:"),
    );
  if (
    comparableVersions.length > 0 &&
    localFileEntries.length > 0 &&
    (remoteTarget || allowLocalFileSpecs)
  ) {
    return {
      id: "package_versions",
      status: remoteTarget ? "fail" : "warn",
      message:
        "Cloudflare Auth package specs mix local file specs and published versions",
      fix: "use either one published @cf-auth version or one local tarball set for smoke testing",
    };
  }
  const publishedVersions = new Set(comparableVersions);
  if (
    publishedVersions.size === 0 &&
    localFileEntries.length > 0 &&
    allowLocalFileSpecs
  ) {
    return {
      id: "package_versions",
      status: "pass",
      message:
        "Cloudflare Auth package versions use local tarball specs for smoke testing",
    };
  }
  if (publishedVersions.size > 1) {
    return {
      id: "package_versions",
      status: remoteTarget ? "fail" : "warn",
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

function collectPackageDependencyEntries(
  pkg: Record<string, unknown>,
  remoteTarget: boolean,
):
  | { ok: true; entries: Array<[string, string]> }
  | { ok: false; check: DoctorCheck } {
  const entries: Array<[string, string]> = [];
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const dependencies = pkg[section];
    if (dependencies === undefined) continue;
    if (!isRecord(dependencies)) {
      return {
        ok: false,
        check: malformedPackageVersionCheck(
          `package.json ${section} must be an object; Cloudflare Auth package versions could not be verified`,
          remoteTarget,
        ),
      };
    }
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version === "string") {
        entries.push([name, version]);
      } else if (isCfAuthPackageName(name)) {
        return {
          ok: false,
          check: malformedPackageVersionCheck(
            `package.json ${section}.${name} must be a string version; Cloudflare Auth package versions could not be verified`,
            remoteTarget,
          ),
        };
      }
    }
  }
  const overrides = collectPackageOverrideEntries(
    pkg.overrides,
    "package.json overrides",
    remoteTarget,
  );
  if (!overrides.ok) return overrides;
  entries.push(...overrides.entries);
  if (pkg.pnpm !== undefined) {
    if (!isRecord(pkg.pnpm)) {
      return {
        ok: false,
        check: malformedPackageVersionCheck(
          "package.json pnpm must be an object; Cloudflare Auth package versions could not be verified",
          remoteTarget,
        ),
      };
    }
    const pnpmOverrides = collectPackageOverrideEntries(
      pkg.pnpm.overrides,
      "package.json pnpm.overrides",
      remoteTarget,
    );
    if (!pnpmOverrides.ok) return pnpmOverrides;
    entries.push(...pnpmOverrides.entries);
  }
  return { ok: true, entries };
}

function collectPackageOverrideEntries(
  overrides: unknown,
  label: string,
  remoteTarget: boolean,
):
  | { ok: true; entries: Array<[string, string]> }
  | { ok: false; check: DoctorCheck } {
  const entries: Array<[string, string]> = [];
  if (overrides === undefined) return { ok: true, entries };
  if (!isRecord(overrides)) {
    return {
      ok: false,
      check: malformedPackageVersionCheck(
        `${label} must be an object; Cloudflare Auth package versions could not be verified`,
        remoteTarget,
      ),
    };
  }
  for (const [rawName, spec] of Object.entries(overrides)) {
    const name = overridePackageName(rawName);
    if (!isCfAuthPackageName(name)) continue;
    if (typeof spec === "string") {
      entries.push([name, spec]);
      continue;
    }
    if (isRecord(spec) && typeof spec["."] === "string") {
      entries.push([name, spec["."]]);
      continue;
    }
    return {
      ok: false,
      check: malformedPackageVersionCheck(
        `${label}.${rawName} must be a string version; Cloudflare Auth package versions could not be verified`,
        remoteTarget,
      ),
    };
  }
  return { ok: true, entries };
}

function overridePackageName(rawName: string): string {
  if (!rawName.startsWith("@")) {
    const at = rawName.indexOf("@");
    return at === -1 ? rawName : rawName.slice(0, at);
  }
  const slash = rawName.indexOf("/");
  if (slash === -1) return rawName;
  const versionAt = rawName.indexOf("@", slash + 1);
  return versionAt === -1 ? rawName : rawName.slice(0, versionAt);
}

function malformedPackageVersionCheck(
  message: string,
  remoteTarget = false,
): DoctorCheck {
  return {
    id: "package_versions",
    status: remoteTarget ? "fail" : "warn",
    message,
    fix: "fix package.json so cf-auth doctor can verify package versions before deployment",
  };
}

function isCfAuthPackageName(name: string): boolean {
  return (
    name === "cf-auth" ||
    name === "create-cloudflare-auth" ||
    name.startsWith("@cf-auth/")
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
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
  const path = join(cwd, ".dev.vars");
  let text: string;
  let permissionCheck: DoctorCheck | null = null;
  try {
    const info = await safeFileInfo(path);
    text = await safeReadFile(path);
    permissionCheck = localSecretPermissionCheck(info.mode);
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
      ...(permissionCheck ? [permissionCheck] : []),
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
      ...(permissionCheck ? [permissionCheck] : []),
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
    ...(permissionCheck ? [permissionCheck] : []),
  ];
}

function localSecretPermissionCheck(mode: number): DoctorCheck | null {
  if (process.platform === "win32") return null;
  const permissions = mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    return {
      id: "local_secret_permissions",
      status: "warn",
      message: `.dev.vars permissions ${permissions.toString(8).padStart(3, "0")} allow group or other access`,
      fix: "chmod 600 .dev.vars",
    };
  }
  return {
    id: "local_secret_permissions",
    status: "pass",
    message: ".dev.vars permissions are restricted",
  };
}

async function readLocalSecretNames(cwd: string): Promise<Set<string>> {
  try {
    const text = await safeReadFile(join(cwd, ".dev.vars"));
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
    text = await safeReadFile(join(cwd, ".dev.vars"));
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

async function inspectAuthSource(
  cwd: string,
  authMode?: string,
): Promise<AuthSourceInspection> {
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
    ? emailSourceForAuthMode(byEnvironmentEmailText, authMode)
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

function emailSourceForAuthMode(
  byEnvironmentEmailText: string,
  authMode?: string,
): string {
  if (isAuthMode(authMode)) {
    return (
      extractPropertyExpression(byEnvironmentEmailText, authMode) ??
      byEnvironmentEmailText
    );
  }
  return (
    [
      extractPropertyExpression(byEnvironmentEmailText, "preview"),
      extractPropertyExpression(byEnvironmentEmailText, "production"),
    ]
      .filter(Boolean)
      .join("\n") || byEnvironmentEmailText
  );
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
    if (!(await safeFileInfo(path, true))) continue;
    files.push({ path, text: await safeReadFile(path) });
  }
  return files;
}

async function readSourceFiles(root: string): Promise<SourceFile[]> {
  const rootInfo = await lstatIfPresent(root);
  if (!rootInfo) return [];
  if (rootInfo.isSymbolicLink()) {
    throw new Error(`${root}: symbolic-link directories are not allowed`);
  }
  if (!rootInfo.isDirectory()) {
    throw new Error(`${root}: expected a directory`);
  }
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
        files.push({ path, text: await safeReadFile(path) });
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

function displayCommandForVerbose(command: string, args: string[]): string {
  if (command !== "wrangler" || args[0] !== "d1" || args[1] !== "execute") {
    return displayCommand(command, args);
  }
  const redactedArgs = [...args];
  const commandIndex = redactedArgs.indexOf("--command");
  if (commandIndex !== -1 && redactedArgs[commandIndex + 1]) {
    redactedArgs[commandIndex + 1] = "<redacted SQL>";
  }
  return displayCommand(command, redactedArgs);
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
  const secret = generateAuthSecret(kid);
  if (parsed.flags.apply) {
    const envName = parsed.flags.env as string | undefined;
    const config = await readWrangler(cwd);
    if (hasNamedEnvironments(config) && !envName) {
      throw new Error(
        "rotate-secret --apply requires --env when Wrangler config uses named environments.",
      );
    }
    assertRemoteAuthEnvironment(config, envName, "rotate-secret --apply");
    const previous = await resolvePreviousSecret(parsed);
    validateRotatedSecrets(secret, previous ?? undefined);
    assertRemoteAccountAccess(
      config,
      envName,
      cwd,
      runner,
      "rotate-secret --apply",
    );
    const lines = [
      runSecretBulk(envName, cwd, runner, {
        AUTH_SECRET: secret,
        AUTH_SECRET_PREVIOUS: previous,
      }),
    ];
    lines.push(
      previous
        ? "Remote AUTH_SECRET and AUTH_SECRET_PREVIOUS updated atomically."
        : "Remote AUTH_SECRET updated and AUTH_SECRET_PREVIOUS removed atomically.",
    );
    lines.push(
      "Wrangler created and deployed a Worker version for the secret update.",
    );
    if (!previous) {
      lines.push(
        "Warning: previous secret was not provided; existing sessions and email tokens will be invalidated.",
      );
    }
    return lines.join("\n");
  }
  return `AUTH_SECRET=${secret}`;
}

function validateRotatedSecrets(current: string, previous?: string): void {
  parseAuthKeyRing(current, previous);
}

function generateAuthSecret(kid = "k1"): string {
  const secret = `${kid}.${base64urlEncode(randomBytes(32))}`;
  validateRotatedSecrets(secret);
  return secret;
}

function runSecretBulk(
  envName: string | undefined,
  cwd: string,
  runner: CommandRunner,
  payload: Record<string, string | null>,
): string {
  const command = {
    command: "wrangler",
    args: ["secret", "bulk", ...(envName ? ["--env", envName] : [])],
  };
  return runCheckedCommand(
    command,
    cwd,
    runner,
    JSON.stringify(payload) + "\n",
  );
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
  const context = await d1CommandContext(parsed, cwd, runner, "Remote cleanup");
  const command = buildD1ExecuteCommand(context, cleanupSql());
  const display = displayD1ExecuteCommand(context, "<redacted cleanup SQL>");
  if (parsed.flags["dry-run"]) {
    return [
      "Dry run only. Would execute cleanup with default retention windows.",
      display,
    ].join("\n");
  }
  const result = runRedactedD1Command(command, display, cwd, runner);
  return `${result}\ncleanup completed`;
}

function d1NowMillisecondsSql(): string {
  return "(CAST(strftime('%s', 'now') AS INTEGER) * 1000)";
}

function cleanupSql(): string {
  const day = 24 * 60 * 60 * 1000;
  const now = d1NowMillisecondsSql();
  const sessionCutoff = `(${now} - ${7 * day})`;
  const tokenCutoff = `(${now} - ${7 * day})`;
  const rateLimitCutoff = `(${now} - ${day})`;
  const eventCutoff = `(${now} - ${90 * day})`;
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
  const context = await d1CommandContext(
    parsed,
    cwd,
    runner,
    "Remote recovery",
  );
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
  const now = d1NowMillisecondsSql();
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
    const now = d1NowMillisecondsSql();
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
  return runRedactedD1Command(
    command,
    "wrangler d1 execute <redacted recovery SQL>",
    cwd,
    runner,
  );
}

function runRedactedD1Command(
  command: { command: string; args: string[] },
  display: string,
  cwd: string,
  runner: CommandRunner,
): string {
  const result = runner(command.command, command.args, { cwd });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${display}`);
  }
  const output = [result.stdout.trim(), result.stderr.trim()]
    .filter(Boolean)
    .join("\n");
  const redacted = redactCliOutput(output);
  return redacted ? `${display}\n${redacted}` : display;
}

interface D1CommandContext {
  databaseName: string;
  remote: boolean;
  envName?: string;
}

async function d1CommandContext(
  parsed: ParsedArgs,
  cwd: string,
  runner: CommandRunner,
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
  if (target.remote && !envName && config.vars?.AUTH_ENV !== "production") {
    throw new Error(
      `${remoteErrorPrefix} without --env requires top-level vars.AUTH_ENV=production.`,
    );
  }
  if (target.remote) {
    assertRemoteAuthEnvironment(config, envName, remoteErrorPrefix);
    if (!parsed.flags["dry-run"]) {
      assertRemoteAccountAccess(
        config,
        envName,
        cwd,
        runner,
        remoteErrorPrefix,
      );
    }
  }
  const database = selectD1(config, envName, {
    remote: target.remote && !parsed.flags["dry-run"],
  });
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

function assertRemoteAuthEnvironment(
  config: WranglerConfig,
  envName: string | undefined,
  label: string,
): void {
  const selected = envName ? config.env?.[envName] : config;
  const authEnv = isRecord(selected?.vars) ? selected.vars.AUTH_ENV : undefined;
  if (authEnv === "development") {
    throw new Error(
      `${label} must not target vars.AUTH_ENV=development. Set the selected Wrangler environment to preview or production.`,
    );
  }
  if (authEnv !== "preview" && authEnv !== "production") {
    throw new Error(
      `${label} must target vars.AUTH_ENV=preview or production. Set the selected Wrangler environment vars.AUTH_ENV to preview or production.`,
    );
  }
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
    if (!isRecord(item))
      throw new Error("D1 JSON response had unexpected shape.");
    if ("id" in item) {
      rows.push(item);
      return;
    }
    let foundRowsProperty = false;
    for (const key of ["result", "results"]) {
      if (!(key in item)) continue;
      foundRowsProperty = true;
      const value = item[key];
      if (!Array.isArray(value)) {
        throw new Error("D1 JSON response had unexpected shape.");
      }
      visit(value);
    }
    if (!foundRowsProperty) {
      throw new Error("D1 JSON response had unexpected shape.");
    }
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

interface D1Binding {
  binding: string;
  database_name: string;
  database_id?: string;
  migrations_dir?: string;
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
  send_email?: Array<{ name: string; remote?: boolean }>;
  d1_databases?: D1Binding[];
  env?: Record<string, WranglerConfig>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readLocalMigrationVersions(
  cwd: string,
  database: Pick<D1Binding, "migrations_dir">,
): Promise<string[]> {
  try {
    const directory = resolve(
      cwd,
      database.migrations_dir?.trim() || "migrations",
    );
    await walkSafeDirectory(directory, false);
    const files = await readdir(directory);
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
  const path =
    (await existingWranglerPathForWrite(cwd)) ?? join(cwd, "wrangler.json");
  const text = await safeReadFile(path);
  return parseWranglerConfig(text, path);
}

function selectD1(
  config: WranglerConfig,
  envName?: string,
  options: { remote?: boolean } = {},
): D1Binding {
  const database = selectD1ForProvisioning(config, envName);
  if (!database.database_id?.trim()) {
    throw new Error("D1 binding AUTH_DB database_id is missing.");
  }
  if (options.remote && isPlaceholderD1DatabaseId(database.database_id)) {
    throw new Error(
      "D1 binding AUTH_DB database_id is still a placeholder; run cf-auth provision --env <name>.",
    );
  }
  return database;
}

function selectD1ForProvisioning(
  config: WranglerConfig,
  envName?: string,
): D1Binding {
  const selectedResult = selectWranglerEnvironment(config, envName);
  if (!selectedResult.ok) throw new Error(selectedResult.message);
  const selected = selectedResult.config;
  if (!Array.isArray(selected.d1_databases)) {
    throw new Error("Wrangler d1_databases must be an array.");
  }
  const matches = selected.d1_databases.filter(
    (item) => isRecord(item) && item.binding === "AUTH_DB",
  );
  if (matches.length !== 1) {
    throw new Error(
      "Wrangler config must contain exactly one AUTH_DB D1 binding.",
    );
  }
  const database = matches[0];
  if (!isAuthD1Binding(database) || !database.database_name?.trim()) {
    throw new Error("D1 binding AUTH_DB database_name is missing or invalid.");
  }
  if (
    database.migrations_dir !== undefined &&
    !database.migrations_dir.trim()
  ) {
    throw new Error("D1 binding AUTH_DB migrations_dir must not be empty.");
  }
  return database;
}

function hasNamedEnvironments(config: WranglerConfig): boolean {
  return isRecord(config.env) && Object.keys(config.env).length > 0;
}

function selectWranglerEnvironment(
  config: WranglerConfig,
  envName: string | undefined,
):
  | { ok: true; config: WranglerConfig }
  | { ok: false; message: string; fix: string } {
  if (!envName) return { ok: true, config };
  if (config.env !== undefined && !isRecord(config.env)) {
    return {
      ok: false,
      message: "Wrangler env must be an object",
      fix: "set env to an object containing named Wrangler environments",
    };
  }
  const selected = config.env?.[envName];
  if (selected === undefined) {
    return {
      ok: false,
      message: `Wrangler environment ${envName} missing`,
      fix: `add env.${envName} to wrangler.jsonc`,
    };
  }
  if (!isRecord(selected)) {
    return {
      ok: false,
      message: `Wrangler environment ${envName} must be an object`,
      fix: `set env.${envName} to an object with auth bindings and vars`,
    };
  }
  return { ok: true, config: selected as WranglerConfig };
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => {
      return typeof entry[1] === "string";
    }),
  );
}

function isAuthD1Binding(value: unknown): value is {
  binding: string;
  database_name?: string;
  database_id?: string;
  migrations_dir?: string;
} {
  return (
    isRecord(value) &&
    value.binding === "AUTH_DB" &&
    (value.database_name === undefined ||
      typeof value.database_name === "string") &&
    (value.database_id === undefined ||
      typeof value.database_id === "string") &&
    (value.migrations_dir === undefined ||
      typeof value.migrations_dir === "string")
  );
}

function findSendEmailBinding(config: WranglerConfig, name: string) {
  if (!Array.isArray(config.send_email)) return undefined;
  return config.send_email.find((item) => isRecord(item) && item.name === name);
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

function parseWranglerConfig(text: string, path: string): WranglerConfig {
  const label = basename(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    throw new Error(`${label}: must be valid JSONC`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label}: top-level JSON value must be an object`);
  }
  return parsed as WranglerConfig;
}

function wranglerConfigReadFailure(error: unknown): {
  message: string;
  fix: string;
} {
  if (error instanceof Error && /^wrangler\.jsonc?: /u.test(error.message)) {
    return {
      message: error.message,
      fix: "fix the Wrangler config JSONC or rerun cf-auth init --repair",
    };
  }
  return {
    message: "Wrangler config missing",
    fix: "npx --package @cf-auth/cli@latest cf-auth init --repair",
  };
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
  options: { backupExisting?: boolean } = {},
): Promise<{
  changed: boolean;
  backupPath?: string;
  backupCreated?: boolean;
}> {
  const path = wranglerPath(cwd);
  const text = await safeReadFile(path);
  const config = parseWranglerConfig(text, path);
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

  if (!isRecord(config.env)) {
    config.env = {};
    changed = true;
  }
  if (!isRecord(config.env.production)) {
    config.env.production = {
      name: appName,
    };
    changed = true;
  }
  const production = config.env.production as WranglerConfig;
  if (production.compatibility_date || production.compatibility_flags) {
    changed = ensureWorkersCompatibility(production) || changed;
  }
  if (production.observability !== undefined) {
    changed = ensureObservability(production) || changed;
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
  const sendEmailBindings = Array.isArray(production.send_email)
    ? production.send_email.filter(
        (binding): binding is { name: string; remote?: boolean } =>
          isRecord(binding) && typeof binding.name === "string",
      )
    : [];
  let foundAuthEmailBinding = false;
  let sendEmailChanged = !Array.isArray(production.send_email);
  const normalizedSendEmailBindings = sendEmailBindings.map((binding) => {
    if (binding.name !== "AUTH_EMAIL") return binding;
    foundAuthEmailBinding = true;
    if (binding.remote === true) return binding;
    sendEmailChanged = true;
    return { ...binding, remote: true };
  });
  if (!foundAuthEmailBinding) {
    normalizedSendEmailBindings.push({ name: "AUTH_EMAIL", remote: true });
    sendEmailChanged = true;
  }
  if (sendEmailChanged) {
    production.send_email = normalizedSendEmailBindings;
    changed = true;
  }

  let backupPath: string | undefined;
  let backupCreated = false;
  if (changed) {
    if (options.backupExisting) {
      const backup = await writeConfigBackup(path);
      backupPath = backup.path;
      backupCreated = backup.created;
    }
    await safeAtomicWriteFile(path, JSON.stringify(config, null, 2) + "\n");
  }
  return backupPath ? { changed, backupPath, backupCreated } : { changed };
}

async function writeConfigBackup(
  path: string,
): Promise<{ path: string; created: boolean }> {
  const backupPath = `${path}.cf-auth-backup`;
  const source = await safeFileInfo(path);
  const created = await writeIfMissing(backupPath, await safeReadFile(path), {
    mode: source.mode & 0o777,
  });
  return { path: backupPath, created };
}

function isExactHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function isPlaceholderPublicOrigin(value: string): boolean {
  return value === "https://example.com";
}

function validateSetupOrigin(value: string): string {
  if (!isExactHttpsOrigin(value) || isPlaceholderPublicOrigin(value)) {
    throw new Error(
      "--origin must be an exact https origin such as https://app.example.com.",
    );
  }
  return value;
}

async function patchAuthPublicOrigin(
  cwd: string,
  envName: string,
  origin: string,
): Promise<{ changed: boolean; backupPath?: string; backupCreated?: boolean }> {
  const path = wranglerPath(cwd);
  const config = await readWrangler(cwd);
  const selected = selectWranglerEnvironment(config, envName);
  if (!selected.ok) throw new Error(selected.message);
  const target = selected.config;
  if (!isRecord(target.vars)) target.vars = {};
  if (target.vars.AUTH_PUBLIC_ORIGIN === origin) return { changed: false };
  target.vars.AUTH_PUBLIC_ORIGIN = origin;
  const backup = await writeConfigBackup(path);
  await safeAtomicWriteFile(path, JSON.stringify(config, null, 2) + "\n");
  return {
    changed: true,
    backupPath: backup.path,
    backupCreated: backup.created,
  };
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
  if (!Array.isArray(config.compatibility_flags)) {
    config.compatibility_flags = [];
    changed = true;
  }
  if (!config.compatibility_flags.includes(workersNodeCompatibilityFlag)) {
    config.compatibility_flags.push(workersNodeCompatibilityFlag);
    changed = true;
  }
  return changed;
}

function ensureObservability(config: WranglerConfig): boolean {
  if (isRecord(config.observability)) return false;
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
  if (!isRecord(config.vars)) {
    config.vars = {};
    changed = true;
  }
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
  if (!Array.isArray(config.d1_databases)) {
    config.d1_databases = [];
    changed = true;
  }
  const matches = config.d1_databases.filter(
    (item) => isRecord(item) && item.binding === "AUTH_DB",
  );
  if (matches.length > 1) {
    throw new Error(
      "Wrangler config must contain exactly one AUTH_DB D1 binding.",
    );
  }
  let binding = matches[0];
  if (binding && !isAuthD1Binding(binding)) {
    throw new Error("D1 binding AUTH_DB has invalid fields.");
  }
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

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function safeFileInfo(path: string): Promise<Stats>;
async function safeFileInfo(
  path: string,
  allowMissing: true,
): Promise<Stats | null>;
async function safeFileInfo(
  path: string,
  allowMissing = false,
): Promise<Stats | null> {
  const info = await lstatIfPresent(path);
  if (!info) {
    if (allowMissing) return null;
    const error = new Error(
      `${path}: file is missing`,
    ) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`${path}: symbolic links are not allowed`);
  }
  if (!info.isFile()) {
    throw new Error(`${path}: expected a regular file`);
  }
  return info;
}

async function walkSafeDirectory(path: string, create: boolean): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  for (const part of parts) {
    current = join(current, part);
    let info = await lstatIfPresent(current);
    if (!info && create) {
      try {
        await mkdir(current);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
      }
      info = await lstatIfPresent(current);
    }
    if (!info) throw new Error(`${current}: directory is missing`);
    if (info.isSymbolicLink()) {
      throw new Error(`${current}: symbolic-link directories are not allowed`);
    }
    if (!info.isDirectory()) {
      throw new Error(`${current}: expected a directory`);
    }
  }
}

async function ensureSafeDirectory(path: string): Promise<void> {
  await walkSafeDirectory(path, true);
}

async function safeReadFile(path: string): Promise<string> {
  await walkSafeDirectory(dirname(path), false);
  const before = await safeFileInfo(path);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (
      before.dev !== opened.dev ||
      (before.ino !== 0 && opened.ino !== 0 && before.ino !== opened.ino)
    ) {
      throw new Error(`${path}: file changed while it was being opened`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function safeChmodFile(path: string, mode: number): Promise<void> {
  await walkSafeDirectory(dirname(path), false);
  const before = await safeFileInfo(path);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat();
    if (
      before.dev !== opened.dev ||
      (before.ino !== 0 && opened.ino !== 0 && before.ino !== opened.ino)
    ) {
      throw new Error(`${path}: file changed while it was being opened`);
    }
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

async function safeCreateFile(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  await walkSafeDirectory(dirname(path), false);
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_CREAT |
    fsConstants.O_EXCL |
    (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safeAtomicWriteFile(
  path: string,
  contents: string,
  options: { mode?: number } = {},
): Promise<void> {
  await walkSafeDirectory(dirname(path), false);
  const existing = await safeFileInfo(path, true);
  const mode = options.mode ?? (existing ? existing.mode & 0o777 : 0o644);
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.cf-auth-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await safeCreateFile(temporaryPath, contents, mode);
    await safeFileInfo(path, true);
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (!hasErrorCode(cleanupError, "ENOENT")) throw cleanupError;
    }
    throw error;
  }
}

async function writeIfMissing(
  path: string,
  contents: string,
  options: { mode?: number; enforceMode?: boolean } = {},
): Promise<boolean> {
  const existing = await safeFileInfo(path, true);
  if (existing) {
    if (options.enforceMode && options.mode !== undefined) {
      await safeChmodFile(path, options.mode);
    }
    return false;
  }
  await safeCreateFile(path, contents, options.mode ?? 0o644);
  return true;
}

async function ensureGitignoreEntries(path: string): Promise<void> {
  const required = gitignoreTemplate().trimEnd().split("\n");
  const existing = await safeFileInfo(path, true);
  if (!existing) {
    await safeCreateFile(path, gitignoreTemplate(), 0o644);
    return;
  }
  const text = await safeReadFile(path);
  const present = new Set(
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = required.filter((entry) => !present.has(entry));
  if (missing.length === 0) return;
  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  await safeAtomicWriteFile(path, `${text}${separator}${missing.join("\n")}\n`);
}

async function existingWranglerPathForWrite(
  cwd: string,
): Promise<string | null> {
  for (const path of [
    join(cwd, "wrangler.jsonc"),
    join(cwd, "wrangler.json"),
  ]) {
    if (await safeFileInfo(path, true)) return path;
  }
  return null;
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
          hono: "4.12.29",
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
      typescript: "7.0.2",
      wrangler: supportedWranglerVersion,
      vitest: "4.1.10",
    },
    engines: { node: ">=22.13.0" },
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
  const existing = await safeFileInfo(path, true);
  if (!existing) {
    await safeCreateFile(
      path,
      JSON.stringify(templatePackageJson(name, template), null, 2) + "\n",
      0o644,
    );
    return "created";
  }
  const pkg = parsePackageJsonObject(await safeReadFile(path), path);
  let changed = false;
  const dependencies = readPackageDependencySection(pkg, "dependencies", path);
  const devDependencies = readPackageDependencySection(
    pkg,
    "devDependencies",
    path,
  );
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
  await safeAtomicWriteFile(path, JSON.stringify(pkg, null, 2) + "\n");
  return "updated";
}

function parsePackageJsonObject(
  text: string,
  path: string,
): Record<string, unknown> {
  const label = basename(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${label}: must be valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label}: top-level JSON value must be an object`);
  }
  return parsed;
}

function readPackageDependencySection(
  pkg: Record<string, unknown>,
  section: "dependencies" | "devDependencies",
  path: string,
): Record<string, string> {
  const label = basename(path);
  const dependencies = pkg[section];
  if (dependencies === undefined) return {};
  if (!isRecord(dependencies)) {
    throw new Error(`${label}: ${section} must be an object`);
  }
  const output: Record<string, string> = {};
  for (const [name, version] of Object.entries(dependencies)) {
    if (typeof version !== "string") {
      throw new Error(`${label}: ${section}.${name} must be a string version`);
    }
    output[name] = version;
  }
  return output;
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
  rateLimit: {
    adapter: "d1",
    edgePrefilter: "optional"
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
  "compatibility_date": "2026-07-11",
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
          "name": "AUTH_EMAIL",
          "remote": true
        }
      ]
    }
  }
}
`;
}

function gitignoreTemplate(): string {
  return `.dev.vars
*.cf-auth-backup
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

function agentsRunbookTemplate(): string {
  return `# Agent Runbook — Cloudflare Auth

This application embeds Cloudflare Auth: self-deployed email/password,
magic-link, email-verification, and password-reset flows served by this
Worker at \`/auth\`, with users, sessions, and tokens stored in the \`AUTH_DB\`
D1 database. This file is the operating contract for coding agents and
automation working in this repository.

## Local development

\`\`\`bash
npx --package @cf-auth/cli@latest cf-auth migrate --local
npm run dev
\`\`\`

Expected: auth routes respond under \`/auth\`, and magic-link, verification,
and reset emails are printed to the terminal in development.

## Production is one command

Use \`wrangler login\`, or export both values for non-interactive automation:

\`\`\`bash
export CLOUDFLARE_ACCOUNT_ID="<account-id>"
export CLOUDFLARE_API_TOKEN="<scoped-api-token>"
npx --package @cf-auth/cli@latest cf-auth setup --env production
\`\`\`

\`setup\` runs in order: provision the D1 database, apply remote migrations,
create \`AUTH_SECRET\` only if it is missing (it never rotates an existing
secret), run \`doctor\` checks, deploy the Worker, and verify the deployed
\`/auth\` endpoints. Every step is idempotent; rerunning \`setup\` is safe.

If \`AUTH_PUBLIC_ORIGIN\` is not configured yet, pass it explicitly:

\`\`\`bash
npx --package @cf-auth/cli@latest cf-auth setup --env production --origin https://app.example.com
\`\`\`

## Convergence loop for automation

\`\`\`bash
npx --package @cf-auth/cli@latest cf-auth setup --report --env production
\`\`\`

- Parse the JSON report (\`schemas/setup-report.schema.json\` in the
  Cloudflare Auth repository). \`ok: true\` means setup is complete.
- Otherwise execute each failed step's \`fix\` string exactly as printed.
- If a failure points at a manual step, stop and hand the exact step to a
  human operator. Never automate the Cloudflare dashboard.
- Rerun the report command. Stop after 5 iterations, or when two consecutive
  runs report the same failures, and summarize what remains.

## API token scopes

Minimum permissions for the standard \`workers.dev\` deployment path:

- Account → Account Settings: Read
- Account → Workers Scripts: Edit
- Account → D1: Edit
- User → User Details: Read
- User → Memberships: Read

Optional: Zone → Workers Routes: Edit and Zone → DNS: Edit for custom
domains; Account → Email Sending: Edit for email automation.

## Human-only steps

Stop and hand these to a human operator; they cannot be automated:

1. Create the scoped API token above (dashboard: My Profile → API Tokens).
   Done when \`wrangler whoami\` lists the target account.
2. Register a workers.dev subdomain once per account (the first deploy fails
   with a dashboard onboarding URL). Done when rerunning setup deploys.
3. Enable Workers Paid and Cloudflare Email Sending, verify the sender
   domain, and publish its DNS records. Done when production email checks
   pass in \`doctor\` and a reset email arrives.
4. Create a Turnstile widget and store \`TURNSTILE_SECRET_KEY\` (only when
   Turnstile is enabled). Done when the remote Turnstile secret check passes.
5. Choose the exact public origin (workers.dev or a custom domain) and keep
   \`AUTH_PUBLIC_ORIGIN\` matching the origin that serves this Worker.

## Verify a deployment

\`\`\`bash
npx --package @cf-auth/cli@latest cf-auth doctor --env production
\`\`\`

\`doctor\` must exit 0. \`setup\` already exercises signup, login, and logout
against the deployed origin unless \`--skip-verify\` is passed.

## Common failures

- D1 binding or database_id missing: rerun
  \`npx --package @cf-auth/cli@latest cf-auth setup --env production\`.
- AUTH_SECRET missing remotely: rerun setup; it creates missing secrets
  without rotating existing ones.
- Migrations not applied remotely:
  \`npx --package @cf-auth/cli@latest cf-auth migrate --remote --env production\`.
- Multiple Cloudflare accounts: set \`CLOUDFLARE_ACCOUNT_ID\` or \`account_id\`
  in \`wrangler.jsonc\`.
- Terminal email rejected in production: configure the Cloudflare Email
  binding or a custom email adapter.
- Cookie not set in production: confirm \`AUTH_PUBLIC_ORIGIN\` is the exact
  https origin that serves this Worker.

## Do not

- Do not print, log, or commit secrets, tokens, cookies, or \`.dev.vars\`.
- Do not run \`rotate-secret --apply\` without \`--previous-from-env\` or
  \`--previous-from-stdin\` on a live deployment; it invalidates sessions and
  deploys immediately.
- Do not automate the Cloudflare dashboard; hand manual steps to a human.
- Do not edit existing files in \`migrations/\`; the schema is append-only.
- In an unfamiliar account, run setup with \`--dry-run\` first and review the
  plan.
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
