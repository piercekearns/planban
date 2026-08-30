import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { openUrlInCodexBrowser } from "./codex-browser-adapter.mjs";

export { openUrlInCodexBrowser } from "./codex-browser-adapter.mjs";

const realProcess = globalThis.process;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, "..");

export function resolveRuntimeRoot() {
  const bundledRuntimeRoot = resolve(pluginRoot, "runtime");
  if (existsSync(resolve(bundledRuntimeRoot, "bin/planban.mjs"))) return bundledRuntimeRoot;
  if (existsSync(resolve(pluginRoot, "bin/planban.mjs"))) return pluginRoot;
  const mcpRuntimeRoot = runtimeRootFromMcpConfig(pluginRoot);
  if (mcpRuntimeRoot) return mcpRuntimeRoot;
  if (realProcess?.env?.PLANBAN_REPO_ROOT) return resolve(realProcess.env.PLANBAN_REPO_ROOT);
  const parentRuntimeRoot = resolve(pluginRoot, "../..");
  if (existsSync(resolve(parentRuntimeRoot, "bin/planban.mjs"))) return parentRuntimeRoot;
  return parentRuntimeRoot;
}

function runtimeRootFromMcpConfig(root) {
  try {
    const config = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"));
    const rootValue = config?.mcpServers?.planban?.env?.PLANBAN_REPO_ROOT;
    if (typeof rootValue === "string" && rootValue.trim()) {
      const runtimeRoot = isAbsolute(rootValue) ? resolve(rootValue) : resolve(root, rootValue);
      if (existsSync(resolve(runtimeRoot, "bin/planban.mjs"))) return runtimeRoot;
    }
    const cwdValue = config?.mcpServers?.planban?.cwd;
    if (typeof cwdValue === "string" && cwdValue.trim()) {
      const runtimeRoot = isAbsolute(cwdValue) ? resolve(cwdValue) : resolve(root, cwdValue);
      if (existsSync(resolve(runtimeRoot, "bin/planban.mjs"))) return runtimeRoot;
    }
  } catch {
    // Not an installed plugin cache, or not enough metadata to resolve a runtime.
  }
  return null;
}

function nodeCommand(explicitNodePath = null) {
  if (explicitNodePath) return explicitNodePath;
  if (realProcess?.execPath) return realProcess.execPath;
  for (const candidate of [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return "node";
}

function processEnv() {
  return {
    PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    ...(realProcess?.env ?? {}),
  };
}

function runTimed(command, args, options = {}) {
  return new Promise((resolveRun) => {
    const started = performance.now();
    const child = spawn(command, args, {
      cwd: options.cwd ?? resolveRuntimeRoot(),
      env: { ...processEnv(), ...(options.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolveRun({
        durationMs: performance.now() - started,
        stdout,
        stderr,
        ...result,
      });
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1000).unref();
        finish({ ok: false, exitCode: null, error: `Timed out after ${options.timeoutMs}ms` });
      }, options.timeoutMs)
      : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      finish({ ok: false, exitCode: null, error: error.message });
    });
    child.once("close", (code) => {
      finish({
        ok: code === 0,
        exitCode: code,
        error: code === 0 ? null : stderr.trim() || `${command} ${args.join(" ")} exited with code ${code}`,
      });
    });
  });
}

function extractFirstUrl(stdout) {
  const match = /https?:\/\/[^\s"'<>]+/u.exec(stdout);
  return match?.[0] ?? null;
}

async function fetchJson(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function statusFor(baseUrl, timeoutMs) {
  return await fetchJson(`${baseUrl}/api/status`, timeoutMs);
}

async function boardsFor(baseUrl, timeoutMs) {
  return await fetchJson(`${baseUrl}/api/boards`, timeoutMs);
}

export async function verifiedWebSurface(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return false;
    if (!(await response.text()).includes('<div id="root"></div>')) return false;
    const parsedUrl = new URL(url);
    const boardMatch = parsedUrl.pathname.match(/^\/boards\/([^/]+)$/u);
    if (!boardMatch) return true;
    const health = await fetch(`${parsedUrl.origin}/api/boards/${boardMatch[1]}/health`, { signal: controller.signal });
    if (!health.ok) return false;
    const payload = await health.json().catch(() => null);
    return payload?.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function repoIdFromCwd(cwd) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(cwd, ".planban/project.json"), "utf8"));
    return typeof manifest.repoId === "string" && manifest.repoId.trim() ? manifest.repoId.trim() : null;
  } catch {
    return null;
  }
}

async function boardUrl(baseUrl, status, cwd, timeoutMs) {
  const targetRepoId = repoIdFromCwd(cwd);
  const statusRepoId = status.currentRepoId ?? status.repoId;

  if (targetRepoId && statusRepoId === targetRepoId) {
    return `${baseUrl}/boards/${encodeURIComponent(targetRepoId)}`;
  }

  const boards = await boardsFor(baseUrl, timeoutMs).catch(() => null);
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

async function runningPlanbanUrl({ cwd, port = 4317, tutorial = false, demo = false, statusTimeoutMs = 1200 }) {
  if (demo) return null;
  const resolvedCwd = resolve(cwd ?? processEnv().PWD ?? ".");
  const baseUrl = `http://127.0.0.1:${port}`;
  const status = await statusFor(baseUrl, statusTimeoutMs).catch(() => null);
  if (!status) return null;
  return tutorial ? `${baseUrl}/tutorial?mode=first-run` : await boardUrl(baseUrl, status, resolvedCwd, statusTimeoutMs);
}

function launchFailureMessage(launch) {
  const details = [
    launch.error,
    launch.stderr?.trim() ? `stderr: ${launch.stderr.trim()}` : null,
    launch.stdout?.trim() ? `stdout: ${launch.stdout.trim()}` : null,
  ].filter(Boolean);
  return details.length > 0
    ? `Planban launcher failed: ${details.join("; ")}`
    : `Planban launcher exited with code ${launch.exitCode ?? "unknown"} without returning a URL`;
}

export async function resolvePlanbanBoard({
  cwd,
  port = 4317,
  noVite = false,
  tutorial = false,
  demo = false,
  nodePath = null,
  statusTimeoutMs = 1200,
  launchTimeoutMs = 15000,
}) {
  const started = performance.now();
  const existingUrl = await runningPlanbanUrl({ cwd, port, tutorial, demo, statusTimeoutMs });
  if (existingUrl && await verifiedWebSurface(existingUrl, statusTimeoutMs)) {
    return {
      launch: {
        ok: true,
        boundary: "service-url",
        status: "ready",
        urlVerified: true,
        reused: true,
        exitCode: 0,
        error: null,
        stdout: `Planban already running at ${existingUrl}\n`,
        stderr: "",
        durationMs: performance.now() - started,
      },
      url: existingUrl,
    };
  }

  const runtimeRoot = resolveRuntimeRoot();
  const launchScriptCandidates = [
    resolve(runtimeRoot, "plugins/planban/scripts/launch-planban.mjs"),
    resolve(runtimeRoot, "scripts/launch-planban.mjs"),
  ];
  const launchScript = launchScriptCandidates.find((candidate) => existsSync(candidate));
  if (!launchScript) {
    throw new Error(`Could not find launch-planban.mjs under ${runtimeRoot}`);
  }
  const args = [launchScript, "--cwd", resolve(cwd ?? processEnv().PWD ?? "."), "--port", String(port)];
  if (noVite) args.push("--no-vite");
  if (demo) args.push("--demo");
  if (tutorial) args.push("--tutorial");

  const launch = await runTimed(nodeCommand(nodePath), args, {
    cwd: runtimeRoot,
    env: { PLANBAN_REPO_ROOT: runtimeRoot },
    timeoutMs: launchTimeoutMs,
  });
  const url = launch.ok ? extractFirstUrl(launch.stdout) : null;
  if (!launch.ok || !url) {
    const recoveredUrl = await runningPlanbanUrl({ cwd, port, tutorial, demo, statusTimeoutMs }).catch(() => null);
    if (recoveredUrl && await verifiedWebSurface(recoveredUrl, statusTimeoutMs)) {
      return {
        launch: {
          ...launch,
          ok: true,
          boundary: "service-url",
          status: "ready",
          urlVerified: true,
          recovered: true,
        },
        url: recoveredUrl,
      };
    }
    throw new Error(launchFailureMessage(launch));
  }
  if (!await verifiedWebSurface(url, statusTimeoutMs)) {
    throw new Error(`Planban resolved ${url}, but the board web surface did not pass health verification`);
  }
  return {
    launch: {
      ...launch,
      boundary: "service-url",
      status: "ready",
      urlVerified: true,
    },
    url,
  };
}

export async function openPlanbanBoardInCodexBrowser(options = {}) {
  const started = performance.now();
  const launchStarted = performance.now();
  const resolveBoard = options.resolveBoard ?? resolvePlanbanBoard;
  const presentUrl = options.presentUrl ?? openUrlInCodexBrowser;
  const { launch, url } = await resolveBoard(options);
  const launchMs = performance.now() - launchStarted;

  const opened = await presentUrl({ ...options, url, urlVerified: true, serviceReady: true });

  return {
    ...opened,
    ok: true,
    url,
    urlVerified: true,
    serviceReady: true,
    launch,
    timings: {
      totalMs: Math.round(performance.now() - started),
      launchMs: Math.round(launchMs),
      browserMs: opened.timings?.browserMs ?? null,
      launcherProcessMs: Math.round(launch.durationMs),
    },
  };
}

export async function printCodexFastOpenResult(options = {}) {
  const result = await openPlanbanBoardInCodexBrowser(options);
  return JSON.stringify(result, null, 2);
}

if (import.meta.url === `file://${realProcess?.argv?.[1]}`) {
  realProcess.stdout.write(`This module is intended to be imported from Codex's Node REPL Browser runtime.

Example:
  const mod = await import("${fileURLToPath(import.meta.url)}");
  await mod.openPlanbanBoardInCodexBrowser({ cwd: "/path/to/repo" });
`);
}
