import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("local plugin configuration records the executable that ran the installer", () => {
  const root = mkdtempSync(join(tmpdir(), "planban-local-plugin-config-"));
  try {
    mkdirSync(join(root, "plugins/planban"), { recursive: true });
    execFileSync(process.execPath, ["scripts/configure-local-plugin.mjs", root], {
      cwd: process.cwd(),
      stdio: "pipe",
    });

    const manifest = JSON.parse(readFileSync(join(root, "plugins/planban/.mcp.json"), "utf8"));
    assert.equal(manifest.mcpServers.planban.cwd, root);
    assert.equal(manifest.mcpServers.planban.command, process.execPath);
    assert.equal(manifest.mcpServers.planban.env.PLANBAN_REPO_ROOT, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
