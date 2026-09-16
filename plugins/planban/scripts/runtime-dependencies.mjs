import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { platformInvocation } from "./platform-invocation.mjs";

const requiredPaths = ["node_modules/tsx", "node_modules/express", "node_modules/iconv-lite/encodings/index.js"];

export async function ensureRuntimeDependencies(runtimeRoot) {
  const missing = () => requiredPaths.filter((path) => !existsSync(resolve(runtimeRoot, path)));
  if (missing().length === 0) return;
  process.stderr.write("Planban is preparing runtime dependencies...\n");
  const invocation = platformInvocation(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"]);
  await new Promise((resolveInstall, rejectInstall) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: runtimeRoot,
      env: process.env,
      // MCP stdout is exclusively JSON-RPC, including during first launch.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let detail = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        detail = (detail + chunk).slice(-8000);
        process.stderr.write(chunk);
      });
    }
    child.once("error", rejectInstall);
    child.once("close", (code) => code === 0 ? resolveInstall() : rejectInstall(new Error(`npm install failed (${code}): ${detail.trim()}`)));
  });
  const remaining = missing();
  if (remaining.length) throw new Error(`Planban runtime dependencies are still missing after npm install: ${remaining.join(", ")}`);
}

export async function loadRuntimeTypescript(runtimeRoot) {
  const runtimeRequire = createRequire(resolve(runtimeRoot, "package.json"));
  await import(pathToFileURL(runtimeRequire.resolve("tsx/esm")).href);
}
