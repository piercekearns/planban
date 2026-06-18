#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredRuntimePaths = [
  "node_modules/tsx",
  "node_modules/express",
  "node_modules/iconv-lite/encodings/index.js",
];

function missingRuntimePaths() {
  return requiredRuntimePaths.filter((relativePath) => !existsSync(resolve(runtimeRoot, relativePath)));
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function ensureRuntimeDependencies() {
  const missing = missingRuntimePaths();
  if (missing.length === 0) return;

  process.stderr.write(`Planban runtime dependencies are missing. Running npm install in ${runtimeRoot}...\n`);
  const result = spawnSync(npmCommand(), ["install"], {
    cwd: runtimeRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`npm install failed while preparing Planban runtime dependencies in ${runtimeRoot}`);
  }

  const stillMissing = missingRuntimePaths();
  if (stillMissing.length > 0) {
    throw new Error(`Planban runtime dependencies are still missing after npm install: ${stillMissing.join(", ")}`);
  }
}

ensureRuntimeDependencies();
await import("tsx/esm");
await import("../src/cli.ts");
