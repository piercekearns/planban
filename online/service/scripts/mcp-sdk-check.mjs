// Connects to the remote MCP endpoint on a local Convex backend with the
// official MCP TypeScript SDK, as Claude Code, Codex and other SDK-based
// clients do. Signs in with bearer credentials (a development sign-in and a
// personal access key); the OAuth sign-in through Clerk is checked once the
// Clerk application exists. Creates throwaway boards only.
//
//   PLANBAN_ONLINE_URL=http://127.0.0.1:3211 node scripts/mcp-sdk-check.mjs
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const origin = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3211").replace(/\/+$/, "");
let step = 0;
const ok = (label) => console.log(`  ok ${++step} - ${label}`);
const post = async (path, token, body) => {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body ?? {}) });
  return { status: response.status, json: await response.json().catch(() => null) };
};
const connect = async (token) => {
  const client = new Client({ name: "mcp-sdk-check", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
  await client.connect(transport);
  return client;
};
const structured = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);
console.log(`Remote MCP checks against ${origin}/mcp`);

const unauthenticated = await fetch(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
assert.equal(unauthenticated.status, 401);
const challenge = unauthenticated.headers.get("www-authenticate") ?? "";
assert.match(challenge, /resource_metadata="([^"]+)"/);
const metadata = await (await fetch(challenge.match(/resource_metadata="([^"]+)"/)[1])).json();
assert.equal(typeof metadata.resource, "string");
await assert.rejects(connect(null));
ok("an unauthenticated client gets a 401 with a resource metadata challenge, and the SDK refuses to connect");

const owner = (await post("/dev/token", null, { userId: `mcp-owner-${Date.now().toString(36)}` })).json.token;
const boardId = `mcp-${Date.now().toString(36)}`;
const now = new Date().toISOString();
const roadmap = { version: 2, writerVersion: 6, revision: 1, updatedAt: now, project: { id: boardId, title: "MCP check", status: "active", description: "", tags: [] }, columns: [], roadmapItems: [] };
assert.equal((await post("/api/v1/boards/import", owner, { format: "planban-board-bundle", version: 1, roadmap, docs: [], history: [] })).status, 201);
const otherBoard = `${boardId}-other`;
assert.equal((await post("/api/v1/boards/import", owner, { format: "planban-board-bundle", version: 1, roadmap: { ...roadmap, project: { ...roadmap.project, id: otherBoard } }, docs: [], history: [] })).status, 201);

const ownerClient = await connect(owner);
const tools = (await ownerClient.listTools()).tools.map((tool) => tool.name);
for (const name of ["planban_list_boards", "planban_get_board", "planban_create_card", "planban_update_card", "planban_move_card", "planban_write_doc", "planban_read_doc", "search", "fetch"]) assert.ok(tools.includes(name), name);
const update = (await ownerClient.listTools()).tools.find((tool) => tool.name === "planban_update_card");
assert.ok(update.inputSchema.required.includes("baseRevision"), "edits require a base revision");
ok("the official SDK connects with the owner's credentials and lists the tools; edit tools require a base revision");

let board = structured(await ownerClient.callTool({ name: "planban_get_board", arguments: { boardId } }));
const created = await ownerClient.callTool({ name: "planban_create_card", arguments: { boardId, title: "Over MCP", specMarkdown: "# Over MCP\n", baseRevision: board.revision, idempotencyKey: `create-${boardId}` } });
assert.equal(created.isError, false, JSON.stringify(created));
const cardId = structured(created).createdCard.id;
const retried = await ownerClient.callTool({ name: "planban_create_card", arguments: { boardId, title: "Over MCP", specMarkdown: "# Over MCP\n", baseRevision: board.revision, idempotencyKey: `create-${boardId}` } });
assert.equal(structured(retried).createdCard.id, cardId);
assert.equal(structured(retried).replayed, true, "a retried edit says it was already applied");
board = structured(await ownerClient.callTool({ name: "planban_get_board", arguments: { boardId } }));
assert.equal(board.cards.filter((card) => card.title === "Over MCP").length, 1);
ok("creating a card over MCP and retrying with the same idempotency key creates it once");

const noBase = await ownerClient.callTool({ name: "planban_update_card", arguments: { boardId, cardId, summary: "No base" } });
assert.equal(noBase.isError, true);
assert.match(noBase.content[0].text, /baseRevision/);
const stale = await ownerClient.callTool({ name: "planban_update_card", arguments: { boardId, cardId, summary: "Stale", baseRevision: board.revision - 1 } });
assert.equal(stale.isError, true);
assert.match(stale.content[0].text, /conflict/);
const doc = structured(await ownerClient.callTool({ name: "planban_read_doc", arguments: { boardId, cardId, kind: "spec" } }));
const written = await ownerClient.callTool({ name: "planban_write_doc", arguments: { boardId, cardId, kind: "spec", markdown: "# Edited over MCP\n", expectedMtimeMs: doc.mtimeMs } });
assert.equal(written.isError, false, JSON.stringify(written));
ok("edits without a base revision or on a stale one are refused; document writes check the document version");

const unconfirmed = await ownerClient.callTool({ name: "planban_move_card", arguments: { boardId, cardId, status: "complete", baseRevision: structured(written).revision } });
assert.equal(unconfirmed.isError, true);
const confirmed = await ownerClient.callTool({ name: "planban_move_card", arguments: { boardId, cardId, status: "complete", completionConfirmed: true, baseRevision: structured(written).revision } });
assert.equal(confirmed.isError, false, JSON.stringify(confirmed));
ok("completing a card over MCP needs explicit confirmation");

const key = (await post("/api/v1/keys", owner, { boardId, level: "plan", name: "MCP agent" })).json.key;
const agent = await connect(key);
const boards = structured(await agent.callTool({ name: "planban_list_boards", arguments: {} })).boards.map((entry) => entry.boardId);
assert.deepEqual(boards, [boardId]);
const outside = await agent.callTool({ name: "planban_get_board", arguments: { boardId: otherBoard } });
assert.equal(outside.isError, true);
const agentBoard = structured(await agent.callTool({ name: "planban_get_board", arguments: { boardId } }));
const reopen = await agent.callTool({ name: "planban_move_card", arguments: { boardId, cardId, status: "in-progress", baseRevision: agentBoard.revision } });
assert.equal(reopen.isError, false, JSON.stringify(reopen));
const agentComplete = await agent.callTool({ name: "planban_move_card", arguments: { boardId, cardId, status: "complete", completionConfirmed: true, baseRevision: structured(reopen).revision } });
assert.equal(agentComplete.isError, true);
const found = structured(await agent.callTool({ name: "search", arguments: { query: "Over MCP" } })).results;
assert.equal(found[0].id, `${boardId}/${cardId}`);
const fetched = structured(await agent.callTool({ name: "fetch", arguments: { id: found[0].id } }));
assert.match(fetched.text, /Edited over MCP/);
ok("an agent on a personal access key reaches only its board, can plan but not complete, and can search and fetch");

const history = structured(await ownerClient.callTool({ name: "planban_history", arguments: { boardId, limit: 3 } }));
assert.equal(history.entries[0].attribution.clientName, "Key: MCP agent");
ok("history attributes each change to the person and the app or key that made it");

const keyId = (await (await fetch(`${origin}/api/v1/connections`, { headers: { Authorization: `Bearer ${owner}` } })).json()).connections.find((connection) => connection.name === "MCP agent").id;
assert.equal((await post(`/api/v1/connections/${keyId}/revoke`, owner)).status, 200);
await assert.rejects(agent.callTool({ name: "planban_list_boards", arguments: {} }));
ok("revoking the key cuts the connected agent off at once");
await ownerClient.close();
await agent.close().catch(() => undefined);
console.log(`All ${step} checks passed.`);
