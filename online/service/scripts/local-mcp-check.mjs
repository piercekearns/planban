// Drives the ordinary local Planban MCP server (stdio) against a project whose
// manifest points at an Online Board, proving local agents need no changes.
//
//   PLANBAN_HOME=... node scripts/local-mcp-check.mjs <planban-repo-root> <project-dir>
import { createServer } from "node:net";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [repoRoot, cwd] = process.argv.slice(2);
if (!repoRoot || !cwd) throw new Error("Usage: local-mcp-check.mjs <planban-repo-root> <project-dir>");

// Point the activity bridge at a closed port so nothing reaches a real board server on 4317.
const closedPort = await new Promise((resolve) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repoRoot, "plugins/planban/scripts/start-planban-mcp.mjs")],
  env: { ...process.env, PLANBAN_REPO_ROOT: repoRoot, PLANBAN_ACTIVITY_URL: `http://127.0.0.1:${closedPort}` },
  stderr: "ignore",
});
const client = new Client({ name: "local-mcp-check", version: "1.0.0" });
await client.connect(transport);

const text = (result) => result.structuredContent ?? JSON.parse(result.content.find((part) => part.type === "text").text);
const board = text(await client.callTool({ name: "planban_get_board", arguments: { cwd } }));
const roadmap = board.roadmap ?? board;
console.log(`  ok - local MCP read the Online Board: ${roadmap.roadmapItems.length} cards at revision ${roadmap.revision}`);
const created = await client.callTool({
  name: "planban_create_card",
  arguments: { cwd, title: "Added by a local agent over local MCP", summary: "Written through the local stdio MCP server.", baseRevision: roadmap.revision },
});
if (created.isError) throw new Error(JSON.stringify(created.content));
console.log("  ok - local MCP created a card on the Online Board");
// The local server reports conflicts as a tool error or a JSON-RPC error, as it does for local boards.
const stale = await client.callTool({
  name: "planban_update_card",
  arguments: { cwd, cardId: roadmap.roadmapItems[0].id, summary: "stale write", baseRevision: roadmap.revision },
}).catch((error) => ({ isError: true, content: [{ type: "text", text: error.message }] }));
if (!stale.isError || !/revision/i.test(stale.content[0].text)) throw new Error("Expected a revision conflict from a stale local MCP write.");
console.log("  ok - a stale local MCP write is refused as a conflict");
await client.close();
