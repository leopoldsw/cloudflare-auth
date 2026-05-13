#!/usr/bin/env node
import { runCli } from "@cf-auth/cli";

runCli().then((code) => {
  process.exitCode = code;
});
