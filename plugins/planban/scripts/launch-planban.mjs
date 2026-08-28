#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, "..");
const requiredRuntimePaths = [
  "node_modules/tsx",
  "node_modules/express",
  "node_modules/iconv-lite/encodings/index.js",
];

export function resolveRuntimeRoot() {
  const bundledRuntimeRoot = resolve(pluginRoot, "runtime");
  if (existsSync(resolve(bundledRuntimeRoot, "bin/planban.mjs"))) return bundledRuntimeRoot;
  if (existsSync(resolve(pluginRoot, "bin/planban.mjs"))) return pluginRoot;
  const mcpRuntimeRoot = runtimeRootFromMcpConfig(pluginRoot);
  if (mcpRuntimeRoot) return mcpRuntimeRoot;
  if (process.env.PLANBAN_REPO_ROOT) return resolve(process.env.PLANBAN_REPO_ROOT);
  const parentRuntimeRoot = resolve(pluginRoot, "../..");
  if (existsSync(resolve(parentRuntimeRoot, "bin/planban.mjs"))) return parentRuntimeRoot;
  return parentRuntimeRoot;
}

function runtimeRootFromMcpConfig(root) {
  try {
    const config = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"));
    for (const value of [
      config?.mcpServers?.planban?.env?.PLANBAN_REPO_ROOT,
      config?.mcpServers?.planban?.cwd,
    ]) {
      if (typeof value !== "string" || !value.trim()) continue;
      const runtimeRoot = isAbsolute(value) ? resolve(value) : resolve(root, value);
      if (existsSync(resolve(runtimeRoot, "bin/planban.mjs"))) return runtimeRoot;
    }
  } catch {
    // Not an installed plugin cache, or not enough metadata to resolve a runtime.
  }
  return null;
}

function missingRuntimeDependencies(runtimeRoot) {
  return requiredRuntimePaths.filter((relativePath) => !existsSync(resolve(runtimeRoot, relativePath)));
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function ensureRuntimeDependencies(runtimeRoot) {
  const missing = missingRuntimeDependencies(runtimeRoot);
  if (missing.length === 0) return;

  await new Promise((resolveInstall, rejectInstall) => {
    const child = spawn(npmCommand(), ["install"], {
      cwd: runtimeRoot,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectInstall);
    child.on("close", (code) => {
      if (code === 0) resolveInstall();
      else rejectInstall(new Error(stderr.trim() || `npm install exited with code ${code}`));
    });
  });

  const stillMissing = missingRuntimeDependencies(runtimeRoot);
  if (stillMissing.length > 0) {
    throw new Error(`Planban runtime dependencies are missing after npm install: ${stillMissing.join(", ")}`);
  }
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

async function webSurfaceHealthy(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    return (await response.text()).includes('<div id="root"></div>');
  } catch {
    return false;
  }
}

export function launchLogPath(port) {
  if (process.env.PLANBAN_LAUNCH_LOG_FILE) return resolve(process.env.PLANBAN_LAUNCH_LOG_FILE);
  const planbanHome = process.env.PLANBAN_HOME ? resolve(process.env.PLANBAN_HOME) : join(homedir(), ".planban");
  return join(planbanHome, "logs", `launch-${port}.log`);
}

function launchLogTail(path) {
  try {
    const contents = readFileSync(path, "utf8").trim();
    return contents ? contents.slice(-4000) : "";
  } catch {
    return "";
  }
}

async function waitForDetachedServer({ baseUrl, child, cwd, logPath, timeoutMs = 15000 }) {
  const started = Date.now();
  let lastError = null;
  let healthyChecks = 0;
  let spawnError = null;
  child.once("error", (error) => {
    spawnError = error;
  });

  while (Date.now() - started < timeoutMs) {
    if (spawnError || child.exitCode !== null || child.signalCode !== null) {
      const exitSummary = spawnError?.message ?? (
        child.signalCode ? `terminated by ${child.signalCode}` : `exited with code ${child.exitCode}`
      );
      const log = launchLogTail(logPath);
      throw new Error(`Detached Planban server ${exitSummary}.${log ? ` Server log: ${log}` : ` See ${logPath}.`}`);
    }

    try {
      const status = await statusFor(baseUrl);
      const url = await boardUrl(baseUrl, status, cwd);
      if (await webSurfaceHealthy(url)) {
        healthyChecks += 1;
        if (healthyChecks >= 2) return { status, url };
      } else {
        healthyChecks = 0;
        lastError = new Error(`Planban API is responding, but ${url} is not serving the web app`);
      }
    } catch (error) {
      healthyChecks = 0;
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }

  const log = launchLogTail(logPath);
  const reason = lastError instanceof Error ? lastError.message : "server did not become healthy";
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for detached Planban server at ${baseUrl}: ${reason}.` +
    (log ? ` Server log: ${log}` : ` See ${logPath}.`),
  );
}

async function isPortOpen(port, timeoutMs = 750) {
  return await new Promise((resolveProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function listenerPids(port) {
  if (process.platform === "win32") return [];
  const result = spawnSync("lsof", [`-tiTCP:${port}`, "-sTCP:LISTEN"], {
    encoding: "utf8",
  });
  if (result.status !== 0 && !result.stdout.trim()) return [];
  return result.stdout
    .split(/\s+/u)
    .map((entry) => Number.parseInt(entry, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function terminatePortListeners(port) {
  const pids = listenerPids(port);
  if (pids.length === 0) return false;
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // The process may already be gone.
    }
  }

  const started = Date.now();
  while (Date.now() - started < 3000) {
    if (!await isPortOpen(port, 100)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may already be gone.
    }
  }

  const killStarted = Date.now();
  while (Date.now() - killStarted < 1000) {
    if (!await isPortOpen(port, 100)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
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

  if (targetRepoId && statusRepoId === targetRepoId) {
    return `${baseUrl}/boards/${encodeURIComponent(targetRepoId)}`;
  }

  const boards = await boardsFor(baseUrl).catch(() => null);
  const boardList = Array.isArray(boards?.boards) ? boards.boards : null;

  if (targetRepoId) {
    const hasTargetBoard = boardList?.some((board) => board.repoId === targetRepoId) ?? statusRepoId === targetRepoId;
    return hasTargetBoard ? `${baseUrl}/boards/${encodeURIComponent(targetRepoId)}` : `${baseUrl}/boards`;
  }

  if (boardList?.length === 1 && typeof boardList[0]?.repoId === "string") {
    return `${baseUrl}/boards/${encodeURIComponent(boardList[0].repoId)}`;
  }

  if (boardList && boardList.length !== 1) return `${baseUrl}/boards`;

  return statusRepoId ? `${baseUrl}/boards/${encodeURIComponent(statusRepoId)}` : `${baseUrl}/boards`;
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
  await ensureRuntimeDependencies(runtimeRoot);

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
    if (await webSurfaceHealthy(url)) {
      if (options.open) openUrl(url);
      process.stdout.write(`Planban already running at ${url}\n`);
      return;
    }

    const restarted = await terminatePortListeners(options.port);
    if (!restarted) {
      throw new Error(
        `Planban is responding on ${baseUrl}, but its web bundle is unavailable. ` +
        `Stop the stale process on port ${options.port} or choose another Planban port.`,
      );
    }
  }

  if (await isPortOpen(options.port)) {
    throw new Error(`Port ${options.port} is already in use by another service. Stop that process or choose a different Planban port.`);
  }

  const args = [cliPath, "serve", "--cwd", cwd, "--port", String(options.port)];
  if (shouldUseBuiltBundle) args.push("--no-vite");

  const logPath = launchLogPath(options.port);
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "w");
  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: runtimeRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }

  let ready;
  try {
    ready = await waitForDetachedServer({ baseUrl, child, cwd, logPath });
  } catch (error) {
    if (child.pid && child.exitCode === null) child.kill("SIGTERM");
    throw error;
  }

  if (process.env.PLANBAN_RESTART_PID_FILE && child.pid) {
    mkdirSync(dirname(process.env.PLANBAN_RESTART_PID_FILE), { recursive: true });
    writeFileSync(process.env.PLANBAN_RESTART_PID_FILE, String(child.pid), "utf8");
  }
  child.unref();

  const url = options.tutorial ? tutorialUrl(baseUrl) : ready.url;
  if (options.open) openUrl(url);
  process.stdout.write(`Planban started at ${url}\n`);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
