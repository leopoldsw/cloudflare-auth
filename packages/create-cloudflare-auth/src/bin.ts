#!/usr/bin/env node
import { runCli } from "@cf-auth/cli";

runCli(["init", ...process.argv.slice(2)]).then((code) => {
  process.exitCode = code;
});
