import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePlanbanRuntime } from "./runtime-root.mjs";
import { ensureRuntimeDependencies, loadRuntimeTypescript } from "./runtime-dependencies.mjs";

try {
  const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const runtimeRoot = resolvePlanbanRuntime(pluginRoot);
  await ensureRuntimeDependencies(runtimeRoot);
  await loadRuntimeTypescript(runtimeRoot);
  process.env.PLANBAN_REPO_ROOT = runtimeRoot;
  const { startMcpServer } = await import(pathToFileURL(resolve(runtimeRoot, "plugins/planban/mcp/server.mjs")).href);
  startMcpServer();
} catch (error) {
  process.stderr.write(`Planban MCP startup failed: ${error.message}\n`);
  process.exitCode = 1;
}
