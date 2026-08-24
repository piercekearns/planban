import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { openUrlInCodexBrowser } from "../plugins/planban/scripts/codex-fast-open-planban.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);

test("uses the Agent returned by Browser setup and safely reuses a distinct in-app binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-browser-runtime-"));
  const browserClientPath = join(root, "browser-client.mjs");
  const previous = {
    agent: globalThis.agent,
    browser: globalThis.browser,
    iab: globalThis.iab,
  };
  let currentUrl = "about:blank";
  let newTabCalls = 0;
  const inAppBrowser = {
    capabilities: { get: async () => null },
    tabs: {
      new: async () => {
        newTabCalls += 1;
        return {
          goto: async (url: string) => { currentUrl = url; },
          playwright: { waitForLoadState: async () => undefined },
          title: async () => "Planban",
          url: async () => currentUrl,
        };
      },
      selected: async () => null,
    },
  };

  try {
    await writeFile(browserClientPath, `
      export async function setupBrowserRuntime() {
        globalThis.__planbanSetupCalls = (globalThis.__planbanSetupCalls ?? 0) + 1;
        return {
          browsers: {
            async get(selector) {
              globalThis.__planbanGetCalls = (globalThis.__planbanGetCalls ?? 0) + 1;
              if (selector !== "iab") throw new Error("unexpected selector " + selector);
              return globalThis.__planbanTestBrowser;
            }
          }
        };
      }
    `, "utf8");
    globalThis.agent = undefined;
    globalThis.iab = undefined;
    globalThis.browser = { externalBrowserSentinel: true };
    globalThis.__planbanSetupCalls = 0;
    globalThis.__planbanGetCalls = 0;
    globalThis.__planbanTestBrowser = inAppBrowser;

    const first = await openUrlInCodexBrowser({ url: "http://localhost:4317/boards/alpha", browserClientPath });
    globalThis.agent = undefined;
    const second = await openUrlInCodexBrowser({ url: "http://localhost:4317/boards/beta", browserClientPath });

    assert.equal(first.finalUrl, "http://localhost:4317/boards/alpha");
    assert.equal(second.finalUrl, "http://localhost:4317/boards/beta");
    assert.equal(globalThis.__planbanSetupCalls, 1);
    assert.equal(globalThis.__planbanGetCalls, 1);
    assert.equal(globalThis.iab, inAppBrowser);
    assert.deepEqual(globalThis.browser, { externalBrowserSentinel: true });
    assert.equal(newTabCalls, 2);
  } finally {
    globalThis.agent = previous.agent;
    globalThis.browser = previous.browser;
    globalThis.iab = previous.iab;
    delete globalThis.__planbanSetupCalls;
    delete globalThis.__planbanGetCalls;
    delete globalThis.__planbanTestBrowser;
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves an installed-cache runtime from adjacent MCP metadata without env or marketplace fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "planban-installed-cache-"));
  const cacheRoot = join(root, "codex-home", "plugins", "cache", "planban", "planban", "1.0.0");
  const scriptsRoot = join(cacheRoot, "scripts");
  const runtimeRoot = join(root, "installed-runtime");
  const previousRepoRoot = process.env.PLANBAN_REPO_ROOT;
  const previousCodexHome = process.env.CODEX_HOME;

  try {
    await mkdir(join(runtimeRoot, "bin"), { recursive: true });
    await mkdir(scriptsRoot, { recursive: true });
    await writeFile(join(runtimeRoot, "bin", "planban.mjs"), "#!/usr/bin/env node\n", "utf8");
    await writeFile(join(cacheRoot, ".mcp.json"), JSON.stringify({
      mcpServers: {
        planban: {
          cwd: runtimeRoot,
          command: "node",
          args: ["--import", "tsx/esm", "./plugins/planban/mcp/server.mjs"],
          env: { PLANBAN_REPO_ROOT: runtimeRoot },
        },
      },
    }), "utf8");
    await cp(join(repoRoot, "plugins/planban/scripts/codex-fast-open-planban.mjs"), join(scriptsRoot, "codex-fast-open-planban.mjs"));
    await cp(join(repoRoot, "plugins/planban/scripts/launch-planban.mjs"), join(scriptsRoot, "launch-planban.mjs"));

    delete process.env.PLANBAN_REPO_ROOT;
    process.env.CODEX_HOME = join(root, "codex-home");
    const cacheBust = `?test=${Date.now()}`;
    const fastOpen = await import(`${pathToFileURL(join(scriptsRoot, "codex-fast-open-planban.mjs")).href}${cacheBust}`);
    const launcher = await import(`${pathToFileURL(join(scriptsRoot, "launch-planban.mjs")).href}${cacheBust}`);

    assert.equal(fastOpen.resolveRuntimeRoot(), runtimeRoot);
    assert.equal(launcher.resolveRuntimeRoot(), runtimeRoot);
  } finally {
    if (previousRepoRoot === undefined) delete process.env.PLANBAN_REPO_ROOT;
    else process.env.PLANBAN_REPO_ROOT = previousRepoRoot;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(root, { recursive: true, force: true });
  }
});
