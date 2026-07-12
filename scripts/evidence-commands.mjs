export function requireOnlyDocumentedCommands({
  evidencePath,
  failures,
  commands,
  path,
  allowedPatterns,
  label,
}) {
  if (!Array.isArray(commands)) {
    failures.push(`${evidencePath}: ${path} must be an array`);
    return;
  }
  const commandList = commands;
  const seen = new Set();
  for (const [index, command] of commandList.entries()) {
    const itemPath = `${path}[${index}]`;
    if (typeof command !== "string" || command.trim().length === 0) {
      failures.push(`${evidencePath}: ${itemPath} must be a non-empty string`);
      continue;
    }
    if (command.trim() !== command) {
      failures.push(
        `${evidencePath}: ${itemPath} must not include leading or trailing whitespace`,
      );
      continue;
    }
    if (!allowedPatterns.some((pattern) => pattern.test(command))) {
      failures.push(
        `${evidencePath}: ${itemPath} must be one of the documented ${label} commands`,
      );
      continue;
    }
    if (seen.has(command)) {
      failures.push(`${evidencePath}: ${itemPath} duplicates ${command}`);
      continue;
    }
    seen.add(command);
  }
}

export function requireDocumentedCommandOrder({
  evidencePath,
  failures,
  commands,
  path,
  expected,
}) {
  if (!Array.isArray(commands)) {
    return;
  }
  if (commands.some((command) => !isValidCommandString(command))) {
    return;
  }

  let previousIndex = -1;
  let previousLabel = "";
  for (const item of expected) {
    const descriptor = normalizeExpectedCommand(item);
    const nextIndex = commands.findIndex(
      (command, index) =>
        index > previousIndex && commandMatches(command, descriptor),
    );
    if (nextIndex !== -1) {
      previousIndex = nextIndex;
      previousLabel = descriptor.label;
      continue;
    }

    const earlierIndex = commands.findIndex((command) =>
      commandMatches(command, descriptor),
    );
    if (earlierIndex !== -1 && previousLabel.length > 0) {
      failures.push(
        `${evidencePath}: ${path}: ${descriptor.label} must appear after ${previousLabel}`,
      );
    }
    return;
  }
}

export function documentedLocalSetupCommands(packageTag) {
  const appName = "[A-Za-z0-9][A-Za-z0-9_-]*(?:\\.[A-Za-z0-9][A-Za-z0-9_-]*)*";
  return [
    npxCfAuthCommand(packageTag, `init ${appName} --template hono-basic`),
    new RegExp(`^cd ${appName}$`, "u"),
    /^pnpm install$/u,
    npxCfAuthCommand(packageTag, "migrate --local"),
    /^npm run dev$/u,
  ];
}

export function documentedLocalSetupCommandOrder() {
  return [
    "cf-auth init",
    "cd my-app",
    "pnpm install",
    "cf-auth migrate --local",
    "npm run dev",
  ];
}

export function commandsIncludeSetup(commands) {
  return (
    Array.isArray(commands) &&
    commands.some(
      (command) =>
        typeof command === "string" && command.includes("cf-auth setup"),
    )
  );
}

export function documentedProductionDeployCommands(
  packageTag,
  { doctorReport },
) {
  const setupFlags =
    "(?: --report| --skip-verify| --dry-run| --output [A-Za-z0-9][A-Za-z0-9._-]*| --origin https://[A-Za-z0-9.-]+(?::\\d+)?)*";
  return [
    npxCfAuthCommand(
      packageTag,
      `setup${setupFlags} --env production${setupFlags}`,
    ),
    npxCfAuthCommand(
      packageTag,
      doctorReport
        ? "doctor --report --env production"
        : "doctor --env production",
    ),
    npxCfAuthCommand(packageTag, "migrate --remote --env production"),
    npxCfAuthCommand(packageTag, "deploy --env production"),
  ];
}

export function documentedProductionDeployCommandOrder({ doctorReport }) {
  return [
    doctorReport
      ? {
          label: "cf-auth doctor --report --env production",
          includes: ["cf-auth doctor", "--report", "--env production"],
        }
      : "cf-auth doctor --env production",
    "cf-auth migrate --remote --env production",
    "cf-auth deploy --env production",
  ];
}

function npxCfAuthCommand(packageTag, commandPattern) {
  return new RegExp(
    `^npx --package @cf-auth/cli@${escapeRegex(packageTag)} cf-auth ${commandPattern}$`,
    "u",
  );
}

function escapeRegex(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function isValidCommandString(command) {
  return (
    typeof command === "string" &&
    command.trim().length > 0 &&
    command.trim() === command
  );
}

function normalizeExpectedCommand(item) {
  if (typeof item === "string") {
    return { label: item, includes: [item] };
  }
  return item;
}

function commandMatches(command, descriptor) {
  return descriptor.includes.every((part) => command.includes(part));
}
