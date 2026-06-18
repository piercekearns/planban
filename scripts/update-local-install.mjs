#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const hasDryRun = args.includes("--dry-run");
const hasExecute = args.includes("--execute");

if (!hasDryRun && !hasExecute) {
  process.stderr.write("Choose --dry-run to inspect or --execute to run a preflight-gated update.\n");
  process.exit(1);
}

if (hasDryRun && hasExecute) {
  process.stderr.write("Use either --dry-run or --execute, not both.\n");
  process.exit(1);
}

const child = spawn(process.execPath, [
  "--import",
  "tsx/esm",
  "src/cli.ts",
  "update",
  hasExecute ? "--execute" : "--dry-run",
  "--runtime-root",
  repoRoot,
  ...args.filter((arg) => arg !== "--dry-run" && arg !== "--execute"),
], {
  cwd: repoRoot,
  stdio: "inherit",
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
