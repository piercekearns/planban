import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const realProcess = globalThis.process;

function processEnv() {
  return realProcess?.env ?? {};
}

function codexHome() {
  return processEnv().CODEX_HOME ? resolve(processEnv().CODEX_HOME) : join(homedir(), ".codex");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function diagnostic(stage, code, error) {
  return {
    boundary: "browser-presentation",
    stage,
    code,
    message: errorMessage(error),
  };
}

async function findMatchingFiles(root, matcher, maxDepth = 6) {
  const matches = [];

  async function visit(directory, depth) {
    if (depth > maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const candidate = join(directory, entry.name);
      if (entry.isDirectory()) return await visit(candidate, depth + 1);
      if (entry.isFile() && matcher(candidate)) matches.push(candidate);
    }));
  }

  await visit(root, 0);
  return matches.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
}

async function discoverBrowserClientPath() {
  const browserCacheRoot = join(codexHome(), "plugins/cache/openai-bundled/browser");
  const versions = await readdir(browserCacheRoot).catch(() => []);
  const versioned = versions
    .map((version) => join(browserCacheRoot, version, "scripts/browser-client.mjs"))
    .filter((candidate) => existsSync(candidate))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  if (versioned[0]) return versioned[0];

  const matches = await findMatchingFiles(
    join(codexHome(), "plugins/cache"),
    (candidate) => candidate.endsWith("/scripts/browser-client.mjs"),
  );
  if (matches[0]) return matches[0];
  throw new Error("The current Codex Browser runtime is not installed or discoverable");
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveBrowser(options) {
  if (options.browserAvailable === false) throw new Error("Codex browser capability was not provided by this host");
  if (options.browser) return { browser: options.browser, source: "injected", browserClientPath: null };
  if (globalThis.iab?.tabs) return { browser: globalThis.iab, source: "existing-iab", browserClientPath: null };

  let browserAgent = options.agent ?? (globalThis.agent?.browsers ? globalThis.agent : null);
  let browserClientPath = options.browserClientPath ?? null;
  if (!browserAgent) {
    let setupBrowserRuntime = options.setupBrowserRuntime;
    if (!setupBrowserRuntime) {
      browserClientPath ??= await discoverBrowserClientPath();
      const module = await import(pathToFileURL(browserClientPath).href);
      setupBrowserRuntime = module.setupBrowserRuntime;
    }
    if (typeof setupBrowserRuntime !== "function") {
      throw new Error("The current Codex Browser runtime does not expose setupBrowserRuntime");
    }
    browserAgent = await setupBrowserRuntime();
  }

  if (!browserAgent?.browsers?.get) {
    throw new Error("The current Codex Browser runtime does not expose browser access");
  }
  const browser = await browserAgent.browsers.get("iab");
  if (!browser?.tabs) throw new Error("The Codex in-app browser capability is unavailable");
  return { browser, source: "browser-runtime", browserClientPath };
}

async function openTab(browser, url, options) {
  if (options.reuseSelectedTab && browser.tabs?.selected) {
    const selected = await browser.tabs.selected().catch(() => null);
    if (selected && await selected.url().catch(() => null) === url) return selected;
  }

  if (browser.tabs?.new) {
    const created = await browser.tabs.new().catch(() => null);
    if (created) return created;
  }

  if (browser.tabs?.selected) {
    const selected = await browser.tabs.selected().catch(() => null);
    if (selected) return selected;
  }

  throw new Error("The Codex in-app browser could not create or select a tab");
}

async function present(url, options) {
  let resolved;
  try {
    resolved = await resolveBrowser(options);
  } catch (error) {
    return { status: "unavailable", stage: "setup", diagnostic: diagnostic("setup", "browser_unavailable", error) };
  }

  const { browser, source, browserClientPath } = resolved;
  try {
    const visibility = await browser.capabilities?.get?.("visibility").catch(() => null);
    if (visibility?.set) await visibility.set(true);
  } catch (error) {
    return {
      status: "failed",
      stage: "visibility",
      source,
      browserClientPath,
      diagnostic: diagnostic("visibility", "browser_visibility_failed", error),
    };
  }

  try {
    const tab = await openTab(browser, url, options);
    if (typeof tab.goto !== "function") throw new Error("The selected Codex browser tab cannot navigate");
    await tab.goto(url);
    if (tab.playwright?.waitForLoadState) {
      await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: options.loadTimeoutMs ?? 10_000 });
    }
    const finalUrl = typeof tab.url === "function" ? await tab.url() : null;
    const title = typeof tab.title === "function" ? await tab.title().catch(() => null) : null;
    if (finalUrl !== url) throw new Error(`Opened ${finalUrl ?? "an unknown URL"}, expected ${url}`);
    return { status: "opened", stage: "complete", source, browserClientPath, finalUrl, title };
  } catch (error) {
    return {
      status: "failed",
      stage: "navigation",
      source,
      browserClientPath,
      diagnostic: diagnostic("navigation", "browser_navigation_failed", error),
    };
  }
}

export async function openUrlInCodexBrowser(options = {}) {
  const started = performance.now();
  const url = typeof options.url === "string" ? options.url.trim() : "";
  if (!url) throw new Error("openUrlInCodexBrowser requires a verified URL");

  const timeoutMs = options.browserTimeoutMs ?? 12_000;
  let presentation;
  try {
    presentation = await withTimeout(present(url, options), timeoutMs, "Codex browser presentation");
  } catch (error) {
    presentation = {
      status: "failed",
      stage: "timeout",
      diagnostic: diagnostic("timeout", "browser_timeout", error),
    };
  }

  const browserOpened = presentation.status === "opened";
  return {
    ok: true,
    url,
    urlVerified: options.urlVerified !== false,
    serviceReady: options.serviceReady !== false,
    browserOpened,
    finalUrl: presentation.finalUrl ?? null,
    title: presentation.title ?? null,
    presentation: {
      adapter: "codex-in-app-browser",
      optional: true,
      status: presentation.status,
      stage: presentation.stage,
      source: presentation.source ?? null,
    },
    capabilities: {
      canonicalUrl: true,
      browserPresentation: presentation.status === "unavailable" ? "unavailable" : "available",
    },
    diagnostics: presentation.diagnostic ? [presentation.diagnostic] : [],
    browserClientPath: presentation.browserClientPath ?? null,
    timings: {
      totalMs: Math.round(performance.now() - started),
      browserMs: Math.round(performance.now() - started),
    },
  };
}
