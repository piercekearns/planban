// Checks the review scenarios around board generations against a local
// Convex backend: Take Local bound to the generation it froze, cancelled
// uploads never touching a later board with the same id, exports of large
// documents, and idempotent replays after a board was taken online again.
// Creates throwaway boards only.
//
//   PLANBAN_ONLINE_URL=http://127.0.0.1:3211 node --import tsx/esm online/scripts/generations-convex.ts
import assert from "node:assert/strict";
import { createEmptyRoadmap, planCreateCard } from "../../src/core/boardOperations";

const origin = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3211").replace(/\/+$/, "");
let step = 0;
const ok = (label: string) => console.log(`  ok ${++step} - ${label}`);
const login = async (userId: string) => (await (await fetch(`${origin}/dev/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) })).json()).token as string;
async function api(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json() as any };
}
const now = new Date().toISOString();
const stamp = Date.now().toString(36);
const owner = await login("owner");
const other = await login("someone-else");
console.log(`Generation checks against ${origin}`);

// 1. Take Local is bound to the generation it froze.
const bound = `bound-${stamp}`;
const imported = await api(owner, "POST", "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap: createEmptyRoadmap({ repoId: bound, title: bound, now }), docs: [], history: [] });
assert.equal(imported.status, 201, JSON.stringify(imported.json));
const localA = `local-a-${stamp}`;
const fenced = await api(owner, "POST", `/api/v1/boards/${bound}/take-local/fence`, { transferId: localA });
assert.equal(fenced.status, 200, JSON.stringify(fenced.json));
assert.equal((await api(owner, "POST", `/api/v1/boards/${bound}/take-local/fence`, { transferId: localA })).status, 200, "fencing again with the same transfer is safe");
assert.equal((await api(owner, "POST", `/api/v1/boards/${bound}/take-local/fence`, { transferId: `local-b-${stamp}` })).status, 409, "another Take Local is refused");
const replacement = await api(owner, "POST", "/api/v1/transfers", { transferId: `replace-${stamp}`, roadmap: createEmptyRoadmap({ repoId: bound, title: "Replacement", now }) });
assert.equal(replacement.status, 409, "the board cannot be taken online again while a Take Local is downloading");
assert.equal((await api(owner, "GET", `/api/v1/boards/${bound}/export/meta?transferId=${localA}`)).status, 200);
assert.equal((await api(owner, "GET", `/api/v1/boards/${bound}/export/meta?transferId=wrong-transfer-1`)).status, 409);
assert.equal((await api(owner, "POST", `/api/v1/boards/${bound}/take-local/finish`, { transferId: localA })).status, 200);
const again = await api(owner, "POST", "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap: { ...createEmptyRoadmap({ repoId: bound, title: "Taken online again", now }), revision: 50 }, docs: [], history: [] });
assert.equal(again.status, 201, JSON.stringify(again.json));
const late = await api(owner, "POST", `/api/v1/boards/${bound}/take-local/fence`, { transferId: localA, expectedGeneration: fenced.json.generation });
assert.equal(late.status, 409, "an old Take Local retry never freezes the board taken online again");
assert.equal((await api(owner, "GET", `/api/v1/boards/${bound}`)).json.authority, "online");
ok("Take Local is bound to the transfer and generation it froze");

// 2. Cancelled uploads never touch a later board with the same id.
const reused = `reused-${stamp}`;
const bigRoadmap = planCreateCard(createEmptyRoadmap({ repoId: reused, title: reused, now }), { title: "Card" }, { now }).roadmap;
const first = `first-${stamp}`;
assert.equal((await api(owner, "POST", "/api/v1/transfers", { transferId: first, roadmap: bigRoadmap })).status, 200);
const history = Array.from({ length: 60 }, (_, index) => ({ entry: { version: index + 1, roadmapRevision: index + 1, createdAt: now, actor: "user", operation: "card.update", summary: `v${index + 1}`, affectedCards: [], affectedDocs: [] }, roadmap: bigRoadmap }));
assert.equal((await api(owner, "POST", `/api/v1/transfers/${first}/parts`, { seq: 0, history })).status, 200);
assert.equal((await api(owner, "POST", `/api/v1/transfers/${first}/abort`, {})).status, 200);
const second = `second-${stamp}`;
assert.equal((await api(owner, "POST", "/api/v1/transfers", { transferId: second, roadmap: bigRoadmap })).status, 200);
assert.equal((await api(owner, "POST", `/api/v1/transfers/${second}/abort`, {})).status, 200);
let taken = { status: 0, json: {} as any };
for (let attempt = 0; attempt < 40 && taken.status !== 200; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  taken = await api(other, "POST", "/api/v1/transfers", { transferId: `third-${stamp}`, roadmap: { ...bigRoadmap, project: { ...bigRoadmap.project, title: "Someone else's" } } });
}
assert.equal(taken.status, 200, JSON.stringify(taken.json));
await new Promise((resolve) => setTimeout(resolve, 2000));
const committed = await api(other, "POST", `/api/v1/transfers/third-${stamp}/commit`, { partCount: 0 });
assert.equal(committed.status, 200, JSON.stringify(committed.json));
assert.equal((await api(other, "GET", `/api/v1/boards/${reused}`)).json.roadmap.project.title, "Someone else's");
ok("clean-up of cancelled uploads never touches a later board that reuses the id");

// 3. Large documents export in pages that fit.
const large = `large-${stamp}`;
let roadmap = createEmptyRoadmap({ repoId: large, title: large, now });
const docs = [];
for (let index = 0; index < 60; index += 1) {
  const planned = planCreateCard(roadmap, { title: `Doc ${index}` }, { now });
  roadmap = planned.roadmap;
  docs.push({ cardId: planned.cardId, kind: "spec", markdown: `# Doc ${index}\n\n${"Compressible planning text. ".repeat(11000)}` });
}
const largeTransfer = `large-${stamp}`;
assert.equal((await api(owner, "POST", "/api/v1/transfers", { transferId: largeTransfer, roadmap })).status, 200);
for (let seq = 0; seq < 6; seq += 1) assert.equal((await api(owner, "POST", `/api/v1/transfers/${largeTransfer}/parts`, { seq, docs: docs.slice(seq * 10, seq * 10 + 10) })).status, 200);
assert.equal((await api(owner, "POST", `/api/v1/transfers/${largeTransfer}/commit`, { partCount: 6 })).status, 200);
let exportedDocs = 0;
let pages = 0;
for (let offset: number | null = 0; offset !== null; pages += 1) {
  const page = await api(owner, "GET", `/api/v1/boards/${large}/export/docs?offset=${offset}&limit=100`);
  assert.equal(page.status, 200, JSON.stringify(page.json).slice(0, 300));
  exportedDocs += page.json.docs.length;
  offset = page.json.nextOffset;
}
assert.equal(exportedDocs, 60);
assert.ok(pages > 1, "the export was split by size");
ok(`60 documents of about 300 KB export in ${pages} pages that fit`);

// 4. A replay after the board was taken online again says it is not the original roadmap.
const replay = `replay-${stamp}`;
const replayBoard = await api(owner, "POST", "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap: planCreateCard(createEmptyRoadmap({ repoId: replay, title: replay, now }), { title: "Card" }, { now }).roadmap, docs: [], history: [] });
const key = `replay-key-${stamp}`;
const edit = await api(owner, "POST", `/api/v1/boards/${replay}/ops/updateCard`, { cardId: "card", summary: "original edit", baseRevision: replayBoard.json.roadmap.revision }, { "Idempotency-Key": key });
assert.equal(edit.status, 200, JSON.stringify(edit.json));
const sameGeneration = await api(owner, "POST", `/api/v1/boards/${replay}/ops/updateCard`, { cardId: "card", summary: "original edit", baseRevision: replayBoard.json.roadmap.revision }, { "Idempotency-Key": key });
assert.equal(sameGeneration.json.roadmap.revision, edit.json.roadmap.revision);
const fence = `replay-local-${stamp}`;
await api(owner, "POST", `/api/v1/boards/${replay}/take-local/fence`, { transferId: fence });
const bundle = await api(owner, "GET", `/api/v1/boards/${replay}/export`);
await api(owner, "POST", `/api/v1/boards/${replay}/take-local/finish`, { transferId: fence });
assert.equal((await api(owner, "POST", "/api/v1/boards/import", bundle.json)).status, 201);
const later = await api(owner, "POST", `/api/v1/boards/${replay}/ops/updateCard`, { cardId: "card", summary: "original edit", baseRevision: replayBoard.json.roadmap.revision }, { "Idempotency-Key": key });
assert.equal(later.status, 200);
assert.equal(later.json.replayed, true);
assert.equal(later.json.originalRevision, edit.json.roadmap.revision);
assert.deepEqual(later.json.result, edit.json.result);
ok("a replay returns the original result, and says which revision it produced when that roadmap is gone");
console.log(`All ${step} checks passed.`);
