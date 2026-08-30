#!/usr/bin/env node
import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TSX_REGISTER_FLAG = "--import=tsx/esm";
const SCRIPT_ROOT = resolve(import.meta.dirname, "..");

if (!process.execArgv.includes(TSX_REGISTER_FLAG) && !process.execArgv.includes("--import") && !process.execArgv.includes("tsx/esm")) {
  const child = await execFileAsync(process.execPath, [TSX_REGISTER_FLAG, import.meta.filename, ...process.argv.slice(2)], {
    cwd: SCRIPT_ROOT,
    env: process.env,
    maxBuffer: 1024 * 1024,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  process.exit(0);
}

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

async function assertPostMutationGuidance(pluginRoot, label) {
  const linkedUrlPattern = /clickable verified URL|verified URL\s+as a clickable Markdown link/iu;
  const sources = [
    resolve(pluginRoot, "skills/planban/SKILL.md"),
    resolve(pluginRoot, "skills/planban-create/SKILL.md"),
    resolve(pluginRoot, "skills/planban/references/planban-protocol.md"),
  ];
  for (const source of sources) {
    const markdown = await readFile(source, "utf8");
    if (!/verified Board\s+URL once/iu.test(markdown) || !linkedUrlPattern.test(markdown)) {
      throw new Error(`${label} is missing the post-mutation Board handoff contract: ${source}`);
    }
  }
  const createSkill = await readFile(resolve(pluginRoot, "skills/planban-create/SKILL.md"), "utf8");
  if (!/## Post-creation handoff[\s\S]{0,240}new Planban board or project setup[\s\S]{0,120}one or more Work\s+Items/iu.test(createSkill)) {
    throw new Error(`${label} does not apply the post-creation handoff to boards, projects, and Work Items`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} expected ${expected}, got ${actual}`);
  }
}

async function assertSamePath(actual, expected, label) {
  const [actualPath, expectedPath] = await Promise.all([
    realpath(resolve(actual)),
    realpath(resolve(expected)),
  ]);
  assertEqual(actualPath, expectedPath, label);
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

function assertRuntimeDependency(root, specifier) {
  const requireFromRoot = createRequire(resolve(root, "package.json"));
  try {
    requireFromRoot.resolve(specifier);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not resolve Planban runtime dependency ${specifier}: ${message}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = await realpath(resolve(options.root));
  const expected = options.expectedVersion;

  const packageJson = await readJson(resolve(root, "package.json"));
  assertEqual(packageJson.version, expected, "package.json version");
  for (const specifier of ["tsx/esm", "express", "iconv-lite/encodings"]) {
    assertRuntimeDependency(root, specifier);
  }

  const versionModule = await import(pathToFileURL(resolve(root, "src/core/version.ts")).href);
  const version = versionModule.currentVersionInfo();
  assertEqual(version.version, expected, "Planban runtime version");
  assertEqual(version.pluginVersion, expected, "Planban plugin version");
  assertEqual(version.mcpVersion, expected, "Planban MCP version");

  const pluginManifest = await readJson(resolve(root, "plugins/planban/.codex-plugin/plugin.json"));
  assertEqual(pluginManifest.version, expected, "Codex plugin manifest version");
  await assertPostMutationGuidance(resolve(root, "plugins/planban"), "Planban runtime plugin");

  const mcpConfigPath = resolve(root, "plugins/planban/.mcp.json");
  if (!await exists(mcpConfigPath)) throw new Error("Planban MCP config is missing");
  const mcpConfig = await readJson(mcpConfigPath);
  const planbanMcp = mcpConfig.mcpServers?.planban;
  if (!planbanMcp) throw new Error("Planban MCP server config is missing");
  await assertSamePath(planbanMcp.cwd, root, "Planban MCP cwd");
  await assertSamePath(planbanMcp.env?.PLANBAN_REPO_ROOT ?? "", root, "Planban MCP runtime root");

  const mcpServer = await import(pathToFileURL(resolve(root, "plugins/planban/mcp/server.mjs")).href);
  if (typeof mcpServer.planbanMcpServerVersion === "function") {
    assertEqual(mcpServer.planbanMcpServerVersion(), expected, "Planban MCP server version");
  }

  const pluginList = await codexPluginList(options.codexHome);
  if (pluginList && !pluginList.includes("planban@planban")) {
    throw new Error("Codex plugin list does not show planban@planban");
  }
  const installedCacheRoot = options.codexHome
    ? resolve(options.codexHome, "plugins/cache/planban/planban", expected)
    : null;
  const cachedGuidancePresent = Boolean(installedCacheRoot && await exists(resolve(installedCacheRoot, "skills")));
  if (installedCacheRoot && cachedGuidancePresent) {
    await assertPostMutationGuidance(installedCacheRoot, "Installed Planban plugin cache");
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    root,
    expectedVersion: expected,
    codexPluginInstalled: pluginList ? pluginList.includes("planban@planban") : null,
    cachedGuidanceVerified: cachedGuidancePresent,
  }, null, 2) + "\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
