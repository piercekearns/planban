// History checks against a local Convex backend: card ids that are also
// JavaScript property names, document bodies kept across pruning, and
// imports larger than the history cap. Creates throwaway boards only.
//
//   PLANBAN_ONLINE_URL=http://127.0.0.1:3211 node --import tsx/esm online/scripts/history-convex.ts
import assert from "node:assert/strict";
import { createEmptyRoadmap, planCreateCard } from "../../src/core/boardOperations";

const origin = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3211").replace(/\/+$/, "");
let step = 0;
const ok = (label: string) => console.log(`  ok ${++step} - ${label}`);

const token = (await (await fetch(`${origin}/dev/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "owner" }) })).json()).token as string;
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json() as any };
}
async function op(boardId: string, name: string, body: Record<string, unknown>) {
  const response = await api("POST", `/api/v1/boards/${boardId}/ops/${name}`, body);
  assert.equal(response.status, 200, JSON.stringify(response.json));
  return response.json;
}
async function exportAll(boardId: string) {
  const meta = await api("GET", `/api/v1/boards/${boardId}/export/meta`);
  assert.equal(meta.status, 200, JSON.stringify(meta.json));
  const history: any[] = [];
  const historyDocs: any[] = [];
  for (let after = 0; ;) {
    const page = await api("GET", `/api/v1/boards/${boardId}/export/history?after=${after}&limit=20`);
    assert.equal(page.status, 200, JSON.stringify(page.json));
    if (page.json.history.length === 0) break;
    history.push(...page.json.history);
    historyDocs.push(...page.json.historyDocs);
    after = page.json.history.at(-1).entry.version;
  }
  return { meta: meta.json, history, historyDocs };
}
function board(id: string) {
  const now = new Date().toISOString();
  return { format: "planban-board-bundle", version: 1, roadmap: createEmptyRoadmap({ repoId: id, title: id, now }), docs: [], history: [] };
}
console.log(`History checks against ${origin}`);

const names = `names-${Date.now().toString(36)}`;
let revision = (await api("POST", "/api/v1/boards/import", board(names))).json.roadmap.revision;
for (const title of ["Constructor", "Other", "Hasownproperty"]) revision = (await op(names, "createCard", { title, baseRevision: revision })).roadmap.revision;
revision = (await op(names, "updateCard", { cardId: "other", summary: "Edited", baseRevision: revision })).roadmap.revision;
const exported = await exportAll(names);
const latest = exported.history.at(-1).roadmap;
assert.deepEqual(latest.roadmapItems.map((item: { id: string }) => item.id).sort(), ["constructor", "hasownproperty", "other"]);
assert.equal(latest.roadmapItems.find((item: { id: string }) => item.id === "constructor").title, "Constructor");
ok("cards whose ids are JavaScript property names rebuild correctly from history");

const pruned = `prune-${Date.now().toString(36)}`;
revision = (await api("POST", "/api/v1/boards/import", board(pruned))).json.roadmap.revision;
const created = await op(pruned, "createCard", { title: "Documented", specMarkdown: "# Written once\n", baseRevision: revision });
revision = created.roadmap.revision;
const cardId = created.result.createdCard.id;
const started = Date.now();
for (let index = 0; index < 1010; index += 1) revision = (await op(pruned, "updateCard", { cardId, summary: `Edit ${index}`, baseRevision: revision })).roadmap.revision;
const afterPrune = await exportAll(pruned);
assert.ok(afterPrune.history.length <= 1000, `kept ${afterPrune.history.length} versions`);
const first = afterPrune.history[0].entry.version;
assert.ok(first > 2, "the oldest versions were pruned");
assert.ok(afterPrune.historyDocs.some((doc: any) => doc.cardId === cardId && doc.kind === "spec" && doc.version === first && doc.markdown === "# Written once\n"),
  "the document body written before the cut is kept at the first kept version");
ok(`pruning to 1,000 versions keeps each document's body for the versions that remain (${Math.round((Date.now() - started) / 1000)} s of edits)`);

const big = `bigimport-${Date.now().toString(36)}`;
const bundle = board(big);
const now = new Date().toISOString();
let roadmap = bundle.roadmap as any;
const versions: any[] = [];
const card = planCreateCard(roadmap, { title: "Only card" }, { now });
roadmap = card.roadmap;
for (let version = 1; version <= 1100; version += 1) {
  roadmap = { ...roadmap, revision: version };
  versions.push({ entry: { version, roadmapRevision: version, createdAt: now, actor: "user", operation: "card.update", summary: `Version ${version}`, affectedCards: [], affectedDocs: [] }, roadmap });
}
const transferId = `big-import-${Date.now()}`;
assert.equal((await api("POST", "/api/v1/transfers", { transferId, roadmap })).status, 200);
for (let seq = 0; seq < 11; seq += 1) {
  const part = await api("POST", `/api/v1/transfers/${transferId}/parts`, { seq, history: versions.slice(seq * 100, seq * 100 + 100) });
  assert.equal(part.status, 200, JSON.stringify(part.json));
}
assert.equal((await api("POST", `/api/v1/transfers/${transferId}/commit`, { partCount: 11 })).status, 200);
let kept = Infinity;
for (let attempt = 0; attempt < 40 && kept > 1000; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  kept = (await api("GET", `/api/v1/boards/${big}/history`)).json.entries.length;
}
assert.ok(kept <= 1000, `kept ${kept} versions`);
ok("an import above the history cap is pruned to the cap in the background, without further edits");
console.log(`All ${step} checks passed.`);
