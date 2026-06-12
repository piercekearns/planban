#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const options = {
    parentPid: null,
    runtimeRoot: process.cwd(),
    cwd: process.cwd(),
    port: 4317,
    noVite: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--parent-pid") {
      options.parentPid = Number(argv[++index]);
    } else if (arg === "--runtime-root") {
      options.runtimeRoot = resolve(argv[++index] ?? options.runtimeRoot);
    } else if (arg === "--cwd") {
      options.cwd = resolve(argv[++index] ?? options.cwd);
    } else if (arg === "--port") {
      options.port = Number(argv[++index] ?? options.port);
    } else if (arg === "--no-vite") {
      options.noVite = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isInteger(options.parentPid) || options.parentPid <= 0) {
    throw new Error("--parent-pid is required");
  }
  if (!Number.isInteger(options.port) || options.port <= 0) {
    throw new Error("--port must be a positive integer");
  }
  return options;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function portIsListening(port) {
  return new Promise((resolveCheck) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolveCheck(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolveCheck(false);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolveCheck(false);
    });
  });
}

async function waitForRestartWindow(pid, port, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const parentAlive = processExists(pid);
    const portBusy = await portIsListening(port);
    if (!parentAlive || !portBusy) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
}

const options = parseArgs(process.argv.slice(2));
await waitForRestartWindow(options.parentPid, options.port);

const cliPath = resolve(options.runtimeRoot, "bin/planban.mjs");
if (!existsSync(cliPath)) {
  throw new Error(`Planban CLI not found at ${cliPath}`);
}

const args = [cliPath, "serve", "--cwd", options.cwd, "--port", String(options.port)];
if (options.noVite) args.push("--no-vite");

const child = spawn(process.execPath, args, {
  cwd: options.runtimeRoot,
  detached: true,
  stdio: "ignore",
});
if (process.env.PLANBAN_RESTART_PID_FILE && child.pid) {
  await mkdir(dirname(process.env.PLANBAN_RESTART_PID_FILE), { recursive: true });
  await writeFile(process.env.PLANBAN_RESTART_PID_FILE, String(child.pid), "utf8");
}
child.unref();
