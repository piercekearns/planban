#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = resolve(process.argv[2] ?? process.cwd());
const mcpPath = resolve(repoRoot, "plugins/planban/.mcp.json");

const manifest = {
  mcpServers: {
    planban: {
      cwd: repoRoot,
      command: "node",
      args: ["--import", "tsx/esm", "./plugins/planban/mcp/server.mjs"],
      env: {
        PLANBAN_REPO_ROOT: repoRoot,
      },
    },
  },
};

await writeFile(mcpPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

process.stdout.write(`Configured Planban plugin MCP runtime for ${repoRoot}

Next:
  codex plugin marketplace add "${repoRoot}"
  codex plugin add planban@planban
  node plugins/planban/scripts/launch-planban.mjs --demo
`);
