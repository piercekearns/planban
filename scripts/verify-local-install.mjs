#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    expectedVersion: null,
    codexHome: process.env.CODEX_HOME ?? null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      options.root = resolve(argv[++index] ?? options.root);
    } else if (arg === "--expected-version") {
      options.expectedVersion = argv[++index] ?? null;
    } else if (arg === "--codex-home") {
      options.codexHome = resolve(argv[++index] ?? "");
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.expectedVersion) throw new Error("--expected-version is required");
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function exists(path) {
  return access(path).then(() => true, () => false);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} expected ${expected}, got ${actual}`);
  }
}

async function codexPluginList(codexHome) {
  if (!codexHome) return null;
  try {
    const result = await execFileAsync("codex", ["plugin", "list"], {
      env: { ...process.env, CODEX_HOME: codexHome },
      maxBuffer: 1024 * 1024,
      timeout: 10000,
    });
    return result.stdout;
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not verify Codex plugin list: ${stderr || message}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = resolve(options.root);
  const expected = options.expectedVersion;

  const packageJson = await readJson(resolve(root, "package.json"));
  assertEqual(packageJson.version, expected, "package.json version");

  const versionModule = await import(pathToFileURL(resolve(root, "src/core/version.ts")).href);
  const version = versionModule.currentVersionInfo();
  assertEqual(version.version, expected, "Planban runtime version");
  assertEqual(version.pluginVersion, expected, "Planban plugin version");
  assertEqual(version.mcpVersion, expected, "Planban MCP version");

  const pluginManifest = await readJson(resolve(root, "plugins/planban/.codex-plugin/plugin.json"));
  assertEqual(pluginManifest.version, expected, "Codex plugin manifest version");

  const mcpConfigPath = resolve(root, "plugins/planban/.mcp.json");
  if (!await exists(mcpConfigPath)) throw new Error("Planban MCP config is missing");
  const mcpConfig = await readJson(mcpConfigPath);
  const planbanMcp = mcpConfig.mcpServers?.planban;
  if (!planbanMcp) throw new Error("Planban MCP server config is missing");
  assertEqual(resolve(planbanMcp.cwd), root, "Planban MCP cwd");
  assertEqual(resolve(planbanMcp.env?.PLANBAN_REPO_ROOT ?? ""), root, "Planban MCP runtime root");

  const mcpServer = await import(pathToFileURL(resolve(root, "plugins/planban/mcp/server.mjs")).href);
  if (typeof mcpServer.planbanMcpServerVersion === "function") {
    assertEqual(mcpServer.planbanMcpServerVersion(), expected, "Planban MCP server version");
  }

  const pluginList = await codexPluginList(options.codexHome);
  if (pluginList && !pluginList.includes("planban@planban")) {
    throw new Error("Codex plugin list does not show planban@planban");
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    root,
    expectedVersion: expected,
    codexPluginInstalled: pluginList ? pluginList.includes("planban@planban") : null,
  }, null, 2) + "\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
