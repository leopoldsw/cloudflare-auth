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
    }
  }
}

export function documentedLocalSetupCommands(packageTag) {
  const appName = "[A-Za-z0-9._-]+";
  return [
    npxCfAuthCommand(packageTag, `init ${appName} --template hono-basic`),
    new RegExp(`^cd ${appName}$`, "u"),
    /^pnpm install$/u,
    npxCfAuthCommand(packageTag, "migrate --local"),
    /^npm run dev$/u,
  ];
}

export function documentedProductionDeployCommands(
  packageTag,
  { doctorReport },
) {
  return [
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

function npxCfAuthCommand(packageTag, commandPattern) {
  return new RegExp(
    `^npx --package @cf-auth/cli@${escapeRegex(packageTag)} cf-auth ${commandPattern}$`,
    "u",
  );
}

function escapeRegex(value) {
  return String(value).replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}
