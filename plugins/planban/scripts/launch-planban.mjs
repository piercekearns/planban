#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, "..");

function resolveRuntimeRoot() {
  const bundledRuntimeRoot = resolve(pluginRoot, "runtime");
  if (existsSync(resolve(bundledRuntimeRoot, "bin/planban.mjs"))) return bundledRuntimeRoot;
  if (process.env.PLANBAN_REPO_ROOT) return resolve(process.env.PLANBAN_REPO_ROOT);
  return resolve(pluginRoot, "../..");
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    port: 4317,
    open: false,
    demo: false,
    tutorial: false,
    noVite: false,
    vite: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      options.cwd = argv[++index] ?? options.cwd;
    } else if (arg === "--port") {
      options.port = Number(argv[++index] ?? options.port);
    } else if (arg === "--open") {
      options.open = true;
    } else if (arg === "--demo") {
      options.demo = true;
    } else if (arg === "--tutorial") {
      options.tutorial = true;
      options.demo = true;
    } else if (arg === "--no-vite") {
      options.noVite = true;
    } else if (arg === "--vite") {
      options.vite = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(options.port) || options.port <= 0) {
    throw new Error("--port must be a positive integer");
  }
  return options;
}

function printHelp() {
  process.stdout.write(`Launch the local Planban board.

Usage:
  node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo [--port 4317] [--open] [--no-vite|--vite]
  node plugins/planban/scripts/launch-planban.mjs --demo [--port 4317] [--open] [--no-vite|--vite]
  node plugins/planban/scripts/launch-planban.mjs --tutorial [--port 4317] [--open] [--no-vite|--vite]

Options:
  --cwd <path>   Repository with .planban/project.json. Defaults to the current directory.
  --demo         Create or reuse the Planban Demo board and launch it.
  --tutorial     Create or reuse the demo board and launch the first-run tutorial.
  --port <port>  Local port to use. Defaults to 4317.
  --open         Open the board URL with the OS URL handler after the server is ready.
  --no-vite      Serve the built web bundle instead of Vite middleware.
  --vite         Force Vite middleware even when a built web bundle exists.
`);
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

async function statusFor(baseUrl) {
  return await fetchJson(`${baseUrl}/api/status`);
}

async function boardsFor(baseUrl) {
  return await fetchJson(`${baseUrl}/api/boards`);
}

async function waitForStatus(baseUrl, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await statusFor(baseUrl);
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw lastError ?? new Error("Timed out waiting for Planban");
}

function repoIdFromCwd(cwd) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(cwd, ".planban/project.json"), "utf8"));
    return typeof manifest.repoId === "string" && manifest.repoId.trim() ? manifest.repoId.trim() : null;
  } catch {
    return null;
  }
}

async function boardUrl(baseUrl, status, cwd) {
  const targetRepoId = repoIdFromCwd(cwd);
  const statusRepoId = status.currentRepoId ?? status.repoId;
  if (targetRepoId && statusRepoId && targetRepoId !== statusRepoId) {
    const boards = await boardsFor(baseUrl).catch(() => null);
    const hasTargetBoard = Array.isArray(boards?.boards) && boards.boards.some((board) => board.repoId === targetRepoId);
    if (!hasTargetBoard) {
      throw new Error(
        `Planban is already running on ${baseUrl}, but it is not serving repo "${targetRepoId}". ` +
        "Use --port to start this board on another port.",
      );
    }
  }
  const repoId = targetRepoId ?? statusRepoId;
  return repoId ? `${baseUrl}/boards/${encodeURIComponent(repoId)}` : baseUrl;
}

function tutorialUrl(baseUrl) {
  return `${baseUrl}/tutorial?mode=first-run`;
}

function openUrl(url) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "darwin"
    ? [url]
    : process.platform === "win32"
      ? ["/c", "start", "", url]
      : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const baseUrl = `http://localhost:${options.port}`;
  const runtimeRoot = resolveRuntimeRoot();
  const cliPath = resolve(runtimeRoot, "bin/planban.mjs");
  const hasBuiltWebBundle = existsSync(resolve(runtimeRoot, "dist/web/index.html"));
  const shouldUseBuiltBundle = options.noVite || (!options.vite && hasBuiltWebBundle);
  if (!existsSync(cliPath)) {
    throw new Error(`Planban CLI not found at ${cliPath}`);
  }

  let cwd = resolve(options.cwd);
  if (options.demo) {
    const demo = await new Promise((resolveDemo, rejectDemo) => {
      const child = spawn(process.execPath, [cliPath, "demo", "--output", "json"], {
        cwd: runtimeRoot,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", rejectDemo);
      child.on("close", (code) => {
        if (code === 0) resolveDemo(JSON.parse(stdout));
        else rejectDemo(new Error(stderr || `Planban demo exited with code ${code}`));
      });
    });
    cwd = demo.cwd;
  }

  const existingStatus = await statusFor(baseUrl).catch(() => null);
  if (existingStatus) {
    const url = options.tutorial ? tutorialUrl(baseUrl) : await boardUrl(baseUrl, existingStatus, cwd);
    if (options.open) openUrl(url);
    process.stdout.write(`Planban already running at ${url}\n`);
    return;
  }

  const args = [cliPath, "serve", "--cwd", cwd, "--port", String(options.port)];
  if (shouldUseBuiltBundle) args.push("--no-vite");

  const child = spawn(process.execPath, args, {
    cwd: runtimeRoot,
    detached: true,
    stdio: "ignore",
  });
  if (process.env.PLANBAN_RESTART_PID_FILE && child.pid) {
    mkdirSync(dirname(process.env.PLANBAN_RESTART_PID_FILE), { recursive: true });
    writeFileSync(process.env.PLANBAN_RESTART_PID_FILE, String(child.pid), "utf8");
  }
  child.unref();

  const status = await waitForStatus(baseUrl);
  const url = options.tutorial ? tutorialUrl(baseUrl) : await boardUrl(baseUrl, status, cwd);
  if (options.open) openUrl(url);
  process.stdout.write(`Planban started at ${url}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
