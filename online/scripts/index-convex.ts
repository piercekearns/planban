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
// Every field a board brings with it is checked, in a single import and in parts.
const wrapped = Buffer.alloc(3000, 5).toString("base64").match(/.{1,76}/g)!.join("\n");
const fresh = (suffix: string) => planCreateCard(createEmptyRoadmap({ repoId: `${boardId}-${suffix}`, title: "Import", now }), { title: "Card" }, { now }).roadmap;
const viaImport = async (suffix: string, change: (bundle: any) => void) => {
  const bundle: any = { format: "planban-board-bundle", version: 1, roadmap: fresh(suffix), docs: [], history: [] };
  change(bundle);
  return api(token, "POST", "/api/v1/boards/import", bundle);
};
const smuggling: Array<[string, (bundle: any) => void]> = [
  ["the board's details", (bundle) => { bundle.roadmap.project.description = picture; }],
  ["a card's metadata as numbers", (bundle) => { bundle.roadmap.roadmapItems[0].metadata = { logo: Array.from({ length: 4000 }, (_, i) => i % 256) }; }],
  ["a document wrapped over lines", (bundle) => { bundle.docs = [{ cardId: bundle.roadmap.roadmapItems[0].id, kind: "plan", markdown: `# Plan\n\n${wrapped}\n` }]; }],
  ["a history entry", (bundle) => { bundle.history = [{ entry: { version: 1, roadmapRevision: 1, createdAt: now, actor: "user", operation: "card.create", summary: picture, affectedCards: [], affectedDocs: [] }, roadmap: bundle.roadmap }]; }],
  ["retired card ids", (bundle) => { bundle.retiredIds = [picture]; }],
  ["history settings", (bundle) => { bundle.retention = { boardVersions: 100, note: picture }; }],
];
for (const [what, change] of smuggling) {
  const refused = await viaImport(what.replace(/\W+/g, "-").slice(0, 20).toLowerCase(), change);
  assert.equal(refused.status, 400, `${what}: ${JSON.stringify(refused.json)}`);
}
const parted = fresh("parted");
const transferId = `index-parts-${Date.now()}`;
assert.equal((await api(token, "POST", "/api/v1/transfers", { transferId, roadmap: parted })).status, 200);
const part = await api(token, "POST", `/api/v1/transfers/${transferId}/parts`, { seq: 0, history: [{ entry: { version: 1, roadmapRevision: 1, createdAt: now, actor: "user", operation: "card.create", summary: picture, affectedCards: [], affectedDocs: [] }, roadmap: parted }] });
assert.equal(part.status, 400, JSON.stringify(part.json));
ok("every field a board brings with it is checked: details, metadata, wrapped documents, history entries, ids and settings, in one import or in parts");

const viaMcpWrapped = await mcp("tools/call", { name: "planban_update_card", arguments: { boardId, cardId, summary: `data:;base64,${Buffer.alloc(600, 3).toString("base64")}`, baseRevision: await revision() } });
assert.equal(viaMcpWrapped.result.isError, true);
const example = await api(token, "POST", `/api/v1/boards/${boardId}/ops/updateCard`, { cardId, summary: "Reject input such as `data:image/png;base64,AAAA` in the upload validator.", baseRevision: await revision() });
assert.equal(example.status, 200, "a short example in prose is fine");
ok("a data: address with no type is refused through MCP; a short example in prose is accepted");
console.log(`All ${step} checks passed.`);
