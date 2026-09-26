import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

async function readJson(relativePath: string) {
  return JSON.parse(await readFile(resolve(repoRoot, relativePath), "utf8"));
}

test("Codex and Claude Code plugin manifests describe the same plugin and version", async () => {
  const codex = await readJson("plugins/planban/.codex-plugin/plugin.json");
  const claude = await readJson("plugins/planban/.claude-plugin/plugin.json");
  const marketplace = await readJson(".claude-plugin/marketplace.json");
  const pkg = await readJson("package.json");

  assert.equal(claude.name, codex.name);
  assert.equal(claude.version, codex.version);
  assert.equal(claude.version, pkg.version);
  assert.equal(marketplace.name, "planban");
  assert.equal(marketplace.metadata.version, pkg.version);
  assert.deepEqual(marketplace.plugins.map((plugin: { name: string; source: string }) => [plugin.name, plugin.source]), [["planban", "./plugins/planban"]]);
});

test("the Claude Code manifest launches the MCP server through the plugin root, not the session cwd", async () => {
  // Claude Code runs plugin MCP servers with the session directory as cwd and expands ${CLAUDE_PLUGIN_ROOT}
  // in args, so the manifest must carry an absolute plugin-root path. The inline manifest entry takes precedence
  // over the Codex-shaped .mcp.json that sits beside it.
  const claude = await readJson("plugins/planban/.claude-plugin/plugin.json");
  const server = claude.mcpServers?.planban;
  assert.ok(server, "manifest must declare the planban MCP server inline");
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/start-planban-mcp.mjs"]);
  assert.equal(server.cwd, undefined);

  const codexConfig = await readJson("plugins/planban/.mcp.json");
  assert.equal(Object.keys(codexConfig.mcpServers).join(","), "planban", "the Codex .mcp.json must use the same server name so hosts merge rather than duplicate it");
});

test("the Claude Code session hook only orients sessions in projects that use Planban", async () => {
  const hooks = await readJson("plugins/planban/hooks/hooks.json");
  const sessionStart = hooks.hooks.SessionStart;
  assert.equal(sessionStart.length, 1);
  assert.match(sessionStart[0].hooks[0].command, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/claude-session-context\.mjs/u);
  const { planbanSessionContext } = await import("../plugins/planban/scripts/claude-session-context.mjs");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const project = await mkdtemp(join(tmpdir(), "planban-hook-"));
  try {
    await mkdir(join(project, ".git"));
    assert.equal(planbanSessionContext({ projectDir: project }), null, "a repo without a board gets no orientation");
    await mkdir(join(project, ".planban"));
    await writeFile(join(project, ".planban/project.json"), JSON.stringify({ version: 1, repoId: "demo board", enabled: true }));
    const context = planbanSessionContext({ projectDir: project });
    assert.match(context ?? "", /board `demo board`/u);
    assert.match(context ?? "", /http:\/\/127\.0\.0\.1:4317\/boards\/demo%20board/u);
    assert.match(context ?? "", /\.planban\/agent-context\.md/u);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});
