#!/usr/bin/env node
import { runCli } from "./index.js";

runCli().then((code) => {
  process.exitCode = code;
});
