import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function runtimeAt(root) {
  return readJson(join(root, "package.json"))?.name === "planban"
    && ["bin/planban.mjs", "src/cli.ts", "src/core/storage.ts"].every((path) => existsSync(join(root, path)));
}

function configuredPath(value, base) {
  if (typeof value !== "string" || !value.trim() || value.includes("__PLANBAN_REPO_ROOT__")) return null;
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function canonicalPath(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
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

  const codexHome = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homedir(), ".codex");
  const cacheParts = relative(canonicalPath(join(codexHome, "plugins/cache")), canonicalPath(pluginRoot)).split(sep);
  const installedCache = cacheParts.length === 3 && cacheParts[0] !== ".." && cacheParts[1] === "planban";
  const marketplaceRoot = join(codexHome, ".tmp/marketplaces/planban");
  if (installedCache && runtimeAt(marketplaceRoot)) return marketplaceRoot;
  throw new Error("Planban runtime not found. Reinstall the Planban marketplace, or run scripts/configure-local-plugin.mjs from a complete Planban checkout and reinstall the plugin.");
}
