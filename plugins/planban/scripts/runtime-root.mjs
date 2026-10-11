import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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

// Read one string value from a TOML line: a basic "..." string (with escapes) or a literal '...' string,
// optionally followed by a comment. Anything else (arrays, inline tables, multi-line strings) is ignored.
function tomlString(raw) {
  const basic = raw.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/u);
  if (basic) {
    try { return JSON.parse(`"${basic[1]}"`); } catch { return null; }
  }
  return raw.match(/^'([^']*)'\s*(?:#.*)?$/u)?.[1] ?? null;
}

// Extract the string keys of one [marketplaces.<name>] table from Codex's config.toml without a TOML dependency.
export function codexMarketplaceConfig(configText, name) {
  const header = /^\s*\[\s*marketplaces\s*\.\s*(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*\]\s*(?:#.*)?$/u;
  const values = {};
  let inTable = false;
  let found = false;
  for (const line of configText.split(/\r?\n/u)) {
    if (/^\s*\[/u.test(line)) {
      const match = line.match(header);
      inTable = Boolean(match) && (match[1] ?? match[2] ?? match[3]) === name;
      found ||= inTable;
      continue;
    }
    if (!inTable) continue;
    const entry = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/u);
    if (!entry) continue;
    const value = tomlString(entry[2]);
    if (value !== null) values[entry[1]] = value;
  }
  return found ? values : null;
}

function expandHome(value) {
  return typeof value === "string" && (value === "~" || value.startsWith("~/")) ? join(homedir(), value.slice(1)) : value;
}

// Codex clones Git marketplaces to .tmp/marketplaces/planban; a local marketplace stays in the folder
// recorded as `source` in config.toml's [marketplaces.planban] table.
function codexMarketplaceRuntime(env, pluginRoot) {
  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), ".codex");
  if (!installedCacheParts(codexHome, pluginRoot)) return null;
  const marketplaceRoot = join(codexHome, ".tmp/marketplaces/planban");
  if (runtimeAt(marketplaceRoot)) return marketplaceRoot;
  let configText;
  try { configText = readFileSync(join(codexHome, "config.toml"), "utf8"); } catch { return null; }
  const configured = codexMarketplaceConfig(configText, "planban");
  if (configured?.source_type !== "local") return null;
  const localRoot = configuredPath(expandHome(configured.source), codexHome);
  return localRoot && runtimeAt(localRoot) ? localRoot : null;
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
export function resolvePlanbanRuntime(pluginRoot, env = process.env) {
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

  const marketplaceRuntime = codexMarketplaceRuntime(env, pluginRoot) ?? claudeMarketplaceRuntime(env, pluginRoot);
  if (marketplaceRuntime) return marketplaceRuntime;
  throw new Error("Planban runtime not found. Reinstall the Planban marketplace in your host (codex plugin marketplace add / claude plugin marketplace add), or run scripts/configure-local-plugin.mjs from a complete Planban checkout and reinstall the plugin.");
}
