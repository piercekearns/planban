#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(`\nRelease preflight failed while running: ${command} ${args.join(" ")}\n`);
    process.exit(result.status ?? 1);
  }
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(join(repoRoot, relativePath), "utf8"));
}

const packageJson = await readJson("package.json");
const packageLock = await readJson("package-lock.json");
const releaseManifest = await readJson("release/latest.json");
const pluginManifest = await readJson("plugins/planban/.codex-plugin/plugin.json");
const versionSource = await readFile(join(repoRoot, "src/core/version.ts"), "utf8");
const findings = [];

if (packageJson.version !== releaseManifest.version) {
  findings.push(`package.json version ${packageJson.version} does not match release/latest.json ${releaseManifest.version}`);
}
if (packageLock.version !== releaseManifest.version || packageLock.packages?.[""]?.version !== releaseManifest.version) {
  findings.push(`package-lock.json root versions do not match release/latest.json ${releaseManifest.version}`);
}
if (pluginManifest.version !== releaseManifest.pluginVersion) {
  findings.push(`plugin manifest ${pluginManifest.version} does not match pluginVersion ${releaseManifest.pluginVersion}`);
}
if (releaseManifest.version !== releaseManifest.pluginVersion || releaseManifest.version !== releaseManifest.mcpVersion) {
  findings.push("release version, pluginVersion, and mcpVersion must match");
}
if (!releaseManifest.releaseNotesUrl?.endsWith(`/v${releaseManifest.version}`)) {
  findings.push(`release notes URL does not end with /v${releaseManifest.version}`);
}
for (const [constantName, expectedVersion] of [
  ["PLANBAN_VERSION", releaseManifest.version],
  ["PLANBAN_PLUGIN_VERSION", releaseManifest.pluginVersion],
  ["PLANBAN_MCP_VERSION", releaseManifest.mcpVersion],
]) {
  const match = versionSource.match(new RegExp(`export const ${constantName} = "([^"]+)";`, "u"));
  if (match?.[1] !== expectedVersion) {
    findings.push(`src/core/version.ts ${constantName} ${match?.[1] ?? "missing"} does not match ${expectedVersion}`);
  }
}

const installScriptAudit = spawnSync("npm", ["install-scripts", "ls", "--json"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (installScriptAudit.status !== 0) {
  findings.push(`could not audit dependency install scripts: ${installScriptAudit.stderr.trim() || "unknown npm error"}`);
} else {
  const unreviewedInstallScripts = JSON.parse(installScriptAudit.stdout).allowScripts ?? [];
  if (unreviewedInstallScripts.length > 0) {
    findings.push(`unreviewed dependency install scripts: ${unreviewedInstallScripts.map((entry) => entry.key ?? entry.name).join(", ")}`);
  }
}

if (findings.length > 0) {
  process.stderr.write(JSON.stringify({ ok: false, findings }, null, 2) + "\n");
  process.exit(1);
}

run("npm", ["run", "typecheck"]);
run("npm", ["test"]);
run("npm", ["audit", "--audit-level=high"]);
run("npm", ["run", "build"]);
run("npm", ["run", "smoke"]);
run("node", ["scripts/verify-planban-mcp.mjs"]);
run("node", ["scripts/verify-cache-launcher.mjs", "--runtime-root", repoRoot]);

process.stdout.write(JSON.stringify({
  ok: true,
  version: releaseManifest.version,
  checked: [
    "version consistency",
    "dependency install-script allowlist",
    "typecheck",
    "tests",
    "high-severity dependency audit",
    "build",
    "HTTP smoke",
    "MCP verifier",
    "cache launcher and stale-server repair verifier",
  ],
}, null, 2) + "\n");
