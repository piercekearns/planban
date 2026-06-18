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

async function findBrowserClientPath() {
  const browserCacheRoot = join(codexHome(), "plugins/cache/openai-bundled/browser");
  const versions = await readdir(browserCacheRoot).catch(() => []);
  const candidates = versions
    .map((version) => join(browserCacheRoot, version, "scripts/browser-client.mjs"))
    .filter((candidate) => existsSync(candidate))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  if (candidates[0]) return candidates[0];
  throw new Error(`Could not find browser-client.mjs under ${browserCacheRoot}`);
}

async function launchPlanban({ cwd, port, noVite = false, tutorial = false, demo = false, nodePath = null }) {
  const runtimeRoot = resolveRuntimeRoot();
  const launchScriptCandidates = [
    resolve(runtimeRoot, "plugins/planban/scripts/launch-planban.mjs"),
    resolve(runtimeRoot, "scripts/launch-planban.mjs"),
  ];
  const launchScript = launchScriptCandidates.find((candidate) => existsSync(candidate));
  if (!launchScript) {
    throw new Error(`Could not find launch-planban.mjs under ${runtimeRoot}`);
  }
  const args = [launchScript, "--cwd", resolve(cwd ?? processEnv().PWD ?? "."), "--port", String(port ?? 4317)];
  if (noVite) args.push("--no-vite");
  if (demo) args.push("--demo");
  if (tutorial) args.push("--tutorial");

  const launch = await runTimed(nodeCommand(nodePath), args, {
    cwd: runtimeRoot,
    env: { PLANBAN_REPO_ROOT: runtimeRoot },
    timeoutMs: 15000,
  });
  const url = launch.ok ? extractFirstUrl(launch.stdout) : null;
  if (!launch.ok || !url) {
    throw new Error(launch.error ?? "Planban launcher did not return a URL");
  }
  return { launch, url };
}

export async function openPlanbanBoardInCodexBrowser(options = {}) {
  const started = performance.now();
  const launchStarted = performance.now();
  const { launch, url } = await launchPlanban(options);
  const launchMs = performance.now() - launchStarted;

  const browserStarted = performance.now();
  const browserClientPath = options.browserClientPath ?? await findBrowserClientPath();
  const { setupBrowserRuntime } = await import(pathToFileURL(browserClientPath).href);
  await setupBrowserRuntimeWithRetry(setupBrowserRuntime, globalThis);
  const browser = options.browser ?? globalThis.browser ?? await globalThis.agent.browsers.get("iab");
  globalThis.browser = browser;

  const visibility = await browser.capabilities.get("visibility").catch(() => null);
  if (visibility) await visibility.set(true);

  const tab = await browser.tabs.new();
  await tab.goto(url);
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
      launchMs: Math.round(launchMs),
      browserMs: Math.round(browserMs),
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
