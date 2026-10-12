// Planban is an index, not storage (owner decision 18), against a local
// Convex backend: no route stores a file, and every write path refuses
// embedded file content with an error that says how to refer to it instead.
//
//   PLANBAN_ONLINE_URL=http://127.0.0.1:3411 node --import tsx/esm online/scripts/index-convex.ts
import assert from "node:assert/strict";
import { createEmptyRoadmap, planCreateCard } from "../../src/core/boardOperations";

const origin = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3411").replace(/\/+$/, "");
let step = 0;
const ok = (label: string) => console.log(`  ok ${++step} - ${label}`);
async function api(token: string | null, method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json().catch(() => null) as any };
}
const picture = `![front](data:image/png;base64,${Buffer.alloc(900, 1).toString("base64")})`;
const encoded = Buffer.alloc(3000, 9).toString("base64");

console.log(`Index checks against ${origin}`);
const token = (await api(null, "POST", "/dev/token", { userId: `index-${Date.now().toString(36)}` })).json.token as string;
const boardId = `index-${Date.now().toString(36)}`;
const now = new Date().toISOString();
const created = planCreateCard(createEmptyRoadmap({ repoId: boardId, title: "Index", now }), { title: "Card" }, { now });
const cardId = created.roadmap.roadmapItems[0]!.id;
assert.equal((await api(token, "POST", "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap: created.roadmap, docs: [], history: [] })).status, 201);

const files = await api(token, "GET", `/api/v1/boards/${boardId}/attachments`);
assert.equal(files.status, 404);
assert.match(files.json.error.message, /hold text only/);
const upload = await api(token, "POST", `/api/v1/boards/${boardId}/attachments/begin`, { cardId, path: "a.png", sha256: "0".repeat(64), size: 1, contentType: "image/png" });
assert.equal(upload.status, 404);
ok("the service has no file routes; asking for one explains that boards hold text only");

const revision = async () => (await api(token, "GET", `/api/v1/boards/${boardId}`)).json.roadmap.revision as number;
const card = await api(token, "POST", `/api/v1/boards/${boardId}/ops/updateCard`, { cardId, summary: `Logo: ${encoded}`, baseRevision: await revision() });
assert.equal(card.status, 400);
assert.match(card.json.error.message, /contains an encoded file.*GitHub link/s);
const spec = await api(token, "GET", `/api/v1/boards/${boardId}/docs/${cardId}/spec`);
const doc = await api(token, "POST", `/api/v1/boards/${boardId}/ops/writeDoc`, { cardId, kind: "spec", markdown: `# Renders\n\n${picture}\n`, expectedMtimeMs: spec.json.mtimeMs });
assert.equal(doc.status, 400);
assert.match(doc.json.error.message, /Spec of card .* contains an embedded file/);
const big = await api(token, "POST", `/api/v1/boards/${boardId}/ops/writeDoc`, { cardId, kind: "spec", markdown: "word ".repeat(220 * 1024), expectedMtimeMs: spec.json.mtimeMs });
assert.equal(big.status, 400);
assert.match(big.json.error.message, /limit is 1024 KB/);
const fine = await api(token, "POST", `/api/v1/boards/${boardId}/ops/writeDoc`, { cardId, kind: "spec", markdown: "# Renders\n\nOn GitHub: https://github.com/example/northfold/tree/main/renders\n", expectedMtimeMs: spec.json.mtimeMs });
assert.equal(fine.status, 200, JSON.stringify(fine.json));
ok("edits through the API refuse embedded files and oversized documents; references are fine");

const mcp = async (method: string, params: unknown) => {
  const response = await fetch(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const text = await response.text();
  const line = text.split("\n").find((entry) => entry.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : text);
};
const tools = (await mcp("tools/list", {})).result.tools as Array<{ name: string; description: string }>;
assert.ok(!tools.some((tool) => /attachment/.test(tool.name)), "no file tools");
const read = await mcp("tools/call", { name: "planban_read_doc", arguments: { boardId, cardId, kind: "plan" } });
const viaMcp = await mcp("tools/call", { name: "planban_write_doc", arguments: { boardId, cardId, kind: "plan", markdown: `# Plan\n\n${picture}`, expectedMtimeMs: JSON.parse(read.result.content[0].text).mtimeMs ?? null } });
assert.equal(viaMcp.result.isError, true);
assert.match(viaMcp.result.content[0].text, /embedded file.*local path labelled with its machine/s);
ok("remote MCP has no file tools, and refuses embedded files with how to refer to them instead");

const importing = planCreateCard(createEmptyRoadmap({ repoId: `${boardId}-b`, title: "Import", now }), { title: "Card" }, { now });
const smuggled = await api(token, "POST", "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap: importing.roadmap, docs: [{ cardId: importing.roadmap.roadmapItems[0]!.id, kind: "spec", markdown: picture }], history: [] });
assert.equal(smuggled.status, 400);
assert.match(smuggled.json.error.message, /embedded file/);
assert.equal((await api(token, "GET", `/api/v1/boards/${boardId}-b`)).status, 404, "nothing of the refused board remains");
ok("taking a board online refuses embedded files too, and leaves nothing behind");
console.log(`All ${step} checks passed.`);
