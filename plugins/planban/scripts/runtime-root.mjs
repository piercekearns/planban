import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { platformInvocation } from "./platform-invocation.mjs";

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function runtimeAt(root) {
  return typeof root === "string"
    && readJson(join(root, "package.json"))?.name === "planban"
    && ["bin/planban.mjs", "src/cli.ts", "src/core/storage.ts"].every((path) => existsSync(join(root, path)));
}

function configuredPath(value, base) {
  if (typeof value !== "string" || !value.trim() || value.includes("__PLANBAN_REPO_ROOT__") || value.includes("${")) return null;
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function canonicalPath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

// Split an installed plugin cache path into its host marketplace and plugin names.
// Both Codex and Claude Code copy installed plugins to <home>/plugins/cache/<marketplace>/<plugin>/<version>.
function installedCacheParts(hostHome, pluginRoot) {
  const parts = relative(canonicalPath(join(hostHome, "plugins/cache")), canonicalPath(pluginRoot)).split(sep);
  if (parts.length !== 3 || parts[0] === ".." || parts[1] !== "planban") return null;
  return { marketplace: parts[0], plugin: parts[1], version: parts[2] };
}

// Ask Codex where it keeps the planban marketplace, so its own config parser decides. Codex puts its own directory
// first on PATH when it starts MCP servers, so `codex` here is the Codex that launched Planban.
// Returns { root } or, when Codex cannot answer, { reason }.
function codexListedMarketplaceRoot(env, timeoutMs) {
  const invocation = platformInvocation("codex", ["plugin", "marketplace", "list", "--json"]);
  const result = spawnSync(invocation.command, invocation.args, {
    env,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error?.code === "ENOENT") return { reason: "codex was not found on PATH" };
  if (result.error?.code === "ETIMEDOUT") return { reason: "codex plugin marketplace list timed out" };
  if (result.error) return { reason: `codex plugin marketplace list failed: ${result.error.message}` };
  if (result.status !== 0) {
    // Codex fails the whole list when any configured marketplace cannot load, so show what it said.
    const said = String(result.stderr ?? "").replace(/\s+/gu, " ").trim().slice(0, 300);
    return { reason: `codex plugin marketplace list exited with ${result.status ?? result.signal}${said ? `: ${said}` : ""}` };
  }
  let listed;
  try { listed = JSON.parse(result.stdout); } catch { return { reason: "codex plugin marketplace list printed invalid JSON" }; }
  const entry = Array.isArray(listed?.marketplaces) ? listed.marketplaces.find((marketplace) => marketplace?.name === "planban") : null;
  if (!entry) return { reason: "Codex lists no planban marketplace" };
  if (typeof entry.root !== "string" || !isAbsolute(entry.root)) return { reason: "Codex listed a planban marketplace root that is not an absolute path" };
  if (!runtimeAt(entry.root)) return { reason: `Codex's planban marketplace root has no complete Planban runtime: ${entry.root}` };
  return { root: resolve(entry.root) };
}

// Codex clones Git marketplaces to .tmp/marketplaces/planban; for other sources, such as a local folder, ask Codex.
function codexMarketplaceRuntime(env, pluginRoot, timeoutMs) {
  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), ".codex");
  if (!installedCacheParts(codexHome, pluginRoot)) return {};
  const marketplaceRoot = join(codexHome, ".tmp/marketplaces/planban");
  if (runtimeAt(marketplaceRoot)) return { root: marketplaceRoot };
  return codexListedMarketplaceRoot(env, timeoutMs);
}

// Claude Code records each marketplace's checkout (or, for directory sources, the source directory itself)
// in plugins/known_marketplaces.json. Fall back to the conventional clone location when that registry is missing.
function claudeMarketplaceRuntime(env, pluginRoot) {
  const claudeHome = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude");
  const cache = installedCacheParts(claudeHome, pluginRoot);
  if (!cache) return null;
  const registered = readJson(join(claudeHome, "plugins/known_marketplaces.json"))?.[cache.marketplace];
  const candidates = [
    configuredPath(registered?.installLocation, claudeHome),
    configuredPath(registered?.source?.path, claudeHome),
    join(claudeHome, "plugins/marketplaces", cache.marketplace),
  ];
  return candidates.find((candidate) => runtimeAt(candidate)) ?? null;
}

// Keep installed, configured, and source entry points on the same runtime.
export function resolvePlanbanRuntime(pluginRoot, env = process.env, { codexTimeoutMs = 5000 } = {}) {
  for (const root of [resolve(pluginRoot, "runtime"), pluginRoot]) {
    if (runtimeAt(root)) return root;
  }
  const config = readJson(join(pluginRoot, ".mcp.json"))?.mcpServers?.planban;
  for (const value of [config?.env?.PLANBAN_REPO_ROOT, config?.cwd]) {
    const root = configuredPath(value, pluginRoot);
    if (root && runtimeAt(root)) return root;
  }
  const explicitRoot = configuredPath(env.PLANBAN_REPO_ROOT, process.cwd());
  if (explicitRoot) {
    if (runtimeAt(explicitRoot)) return explicitRoot;
    throw new Error(`PLANBAN_REPO_ROOT does not contain a complete Planban runtime: ${explicitRoot}`);
  }
  const parentRoot = resolve(pluginRoot, "../..");
  if (runtimeAt(parentRoot)) return parentRoot;

  const codex = codexMarketplaceRuntime(env, pluginRoot, codexTimeoutMs);
  const marketplaceRuntime = codex.root ?? claudeMarketplaceRuntime(env, pluginRoot);
  if (marketplaceRuntime) return marketplaceRuntime;
  const reason = codex.reason ? ` (${codex.reason})` : "";
  throw new Error(`Planban runtime not found${reason}. Reinstall the Planban marketplace in your host (codex plugin marketplace add / claude plugin marketplace add), or run scripts/configure-local-plugin.mjs from a complete Planban checkout and reinstall the plugin.`);
}
