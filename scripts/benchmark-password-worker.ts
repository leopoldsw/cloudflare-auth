import {
  passwordHashProfiles,
  type PasswordHashProfileName,
} from "../packages/core/src/index.js";
import { runWorkersPasswordBenchmark } from "../packages/cli/src/password-benchmark.js";

const profile = parseProfile(process.argv);
const result = await runWorkersPasswordBenchmark({
  profile,
  params: passwordHashProfiles[profile],
});

console.log(JSON.stringify(result, null, 2));

function parseProfile(args: string[]): PasswordHashProfileName {
  const index = args.indexOf("--profile");
  const value = index === -1 ? "workers-balanced" : args[index + 1];
  if (
    value === "development-fast" ||
    value === "workers-balanced" ||
    value === "high-cost"
  ) {
    return value;
  }
  throw new Error(
    "Usage: pnpm benchmark:password -- --profile <development-fast|workers-balanced|high-cost>",
  );
}
