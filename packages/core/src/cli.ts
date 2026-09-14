#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runLintCli } from "./cli-lib.js";

// Set the exit code rather than calling process.exit() so a piped stdout drains first.
process.exitCode = await runLintCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  readFile: (path) => readFileSync(path, "utf8"),
  readStdin: () => readFileSync(0, "utf8"),
});
