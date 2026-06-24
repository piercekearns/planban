import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const realProcess = globalThis.process;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, "..");

function resolveRuntimeRoot() {
  const bundledRuntimeRoot = resolve(pluginRoot, "runtime");
  if (existsSync(resolve(bundledRuntimeRoot, "bin/planban.mjs"))) return bundledRuntimeRoot;
  if (existsSync(resolve(pluginRoot, "bin/planban.mjs"))) return pluginRoot;
  const mcpRuntimeRoot = runtimeRootFromMcpConfig(pluginRoot);
  if (mcpRuntimeRoot) return mcpRuntimeRoot;
  if (realProcess?.env?.PLANBAN_REPO_ROOT) return resolve(realProcess.env.PLANBAN_REPO_ROOT);
  const marketplaceRuntimeRoot = runtimeRootFromCodexMarketplace();
  if (marketplaceRuntimeRoot) return marketplaceRuntimeRoot;
  const parentRuntimeRoot = resolve(pluginRoot, "../..");
  if (existsSync(resolve(parentRuntimeRoot, "bin/planban.mjs"))) return parentRuntimeRoot;
  return parentRuntimeRoot;
}

function runtimeRootFromMcpConfig(root) {
  try {
    const config = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8"));
    const rootValue = config?.mcpServers?.planban?.env?.PLANBAN_REPO_ROOT;
    if (typeof rootValue === "string" && rootValue.trim()) {
      const runtimeRoot = resolve(rootValue);
      if (existsSync(resolve(runtimeRoot, "bin/planban.mjs"))) return runtimeRoot;
    }
    const cwdValue = config?.mcpServers?.planban?.cwd;
    if (typeof cwdValue === "string" && cwdValue.trim()) {
      const runtimeRoot = resolve(cwdValue);
      if (existsSync(resolve(runtimeRoot, "bin/planban.mjs"))) return runtimeRoot;
    }
  } catch {
    // Not an installed plugin cache, or not enough metadata to resolve a runtime.
  }
  return null;
}

function codexHome() {
  return processEnv().CODEX_HOME
    ? resolve(processEnv().CODEX_HOME)
    : join(homedir(), ".codex");
}

function runtimeRootFromCodexMarketplace() {
  const runtimeRoot = join(codexHome(), ".tmp/marketplaces/planban");
  if (existsSync(resolve(runtimeRoot, "bin/planban.mjs"))) return runtimeRoot;
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
  const baseUrl = `http://localhost:${port}`;
  const status = await statusFor(baseUrl, statusTimeoutMs).catch(() => null);
  if (!status) return null;
  return tutorial ? `${baseUrl}/tutorial?mode=first-run` : await boardUrl(baseUrl, status, resolvedCwd, statusTimeoutMs);
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function setupBrowserRuntimeWithRetry(setupBrowserRuntime, globals) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await setupBrowserRuntime({ globals });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await wait(150);
    }
  }
  throw lastError;
}

async function findMatchingFiles(root, matcher, maxDepth = 6) {
  const matches = [];

  async function visit(directory, depth) {
    if (depth > maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
        return;
      }
      if (entry.isFile() && matcher(candidate)) matches.push(candidate);
    }));
  }

  await visit(root, 0);
  return matches.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
}

async function findBrowserClientPath() {
  const browserCacheRoot = join(codexHome(), "plugins/cache/openai-bundled/browser");
  const versions = await readdir(browserCacheRoot).catch(() => []);
  const candidates = versions
    .map((version) => join(browserCacheRoot, version, "scripts/browser-client.mjs"))
    .filter((candidate) => existsSync(candidate))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  if (candidates[0]) return candidates[0];

  const pluginCacheRoot = join(codexHome(), "plugins/cache");
  const fallbackCandidates = await findMatchingFiles(
    pluginCacheRoot,
    (candidate) => candidate.endsWith("/scripts/browser-client.mjs"),
  );
  if (fallbackCandidates[0]) return fallbackCandidates[0];

  throw new Error(`Could not find browser-client.mjs under ${browserCacheRoot} or ${pluginCacheRoot}`);
}

async function launchPlanban({
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
  if (existingUrl) {
    return {
      launch: {
        ok: true,
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
    if (recoveredUrl) {
      return {
        launch: {
          ...launch,
          ok: true,
          recovered: true,
        },
        url: recoveredUrl,
      };
    }
    throw new Error(launch.error ?? "Planban launcher did not return a URL");
  }
  return { launch, url };
}

async function openPlanbanTab(browser, url, options = {}) {
  const errors = [];
  let tab = null;

  if (options.reuseSelectedTab) {
    try {
      const selected = await browser.tabs.selected();
      if (selected && await selected.url().catch(() => null) === url) tab = selected;
    } catch (error) {
      errors.push(error);
    }
  }

  if (!tab) {
    try {
      tab = await browser.tabs.new();
    } catch (error) {
      errors.push(error);
    }
  }

  if (!tab) {
    try {
      tab = await browser.tabs.selected();
    } catch (error) {
      errors.push(error);
    }
  }

  if (!tab) {
    const message = errors.map((error) => error?.message).filter(Boolean).join("; ");
    throw new Error(message || "Could not open or select a Codex browser tab");
  }

  await tab.goto(url);
  return tab;
}

export async function openUrlInCodexBrowser(options = {}) {
  const started = performance.now();
  const { url } = options;
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("openUrlInCodexBrowser requires a URL");
  }

  const browserStarted = performance.now();
  const browserClientPath = options.browserClientPath ?? await findBrowserClientPath();
  const { setupBrowserRuntime } = await import(pathToFileURL(browserClientPath).href);
  await setupBrowserRuntimeWithRetry(setupBrowserRuntime, globalThis);
  const browser = options.browser ?? globalThis.browser ?? await globalThis.agent.browsers.get("iab");
  globalThis.browser = browser;

  const visibility = await browser.capabilities.get("visibility").catch(() => null);
  if (visibility) await visibility.set(true);

  const tab = await openPlanbanTab(browser, url, options);
  await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: options.loadTimeoutMs ?? 10000 });
  const finalUrl = await tab.url();
  const title = await tab.title().catch(() => null);
  const browserMs = performance.now() - browserStarted;

  if (finalUrl !== url) {
    throw new Error(`Opened ${finalUrl}, expected ${url}`);
  }

  return {
    ok: true,
    url,
    finalUrl,
    title,
    browserClientPath,
    timings: {
      totalMs: Math.round(performance.now() - started),
      browserMs: Math.round(browserMs),
    },
  };
}

export async function openPlanbanBoardInCodexBrowser(options = {}) {
  const started = performance.now();
  const launchStarted = performance.now();
  const { launch, url } = await launchPlanban(options);
  const launchMs = performance.now() - launchStarted;

  const opened = await openUrlInCodexBrowser({ ...options, url });

  return {
    ...opened,
    url,
    timings: {
      totalMs: Math.round(performance.now() - started),
      launchMs: Math.round(launchMs),
      browserMs: opened.timings.browserMs,
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
