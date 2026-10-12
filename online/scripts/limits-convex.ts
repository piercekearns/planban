// Size and volume caps (owner decision 18) against a local Convex backend
// started with low test limits:
//
//   npx convex env set PLANBAN_TEST_LIMITS 100000,40,1000000,600000
//   PLANBAN_ONLINE_URL=http://127.0.0.1:3411 node --import tsx/esm online/scripts/limits-convex.ts
//   npx convex env remove PLANBAN_TEST_LIMITS
//
// (board stored bytes, changes a day, written bytes a day, imported bytes a day)
import assert from "node:assert/strict";
import { createEmptyRoadmap, planCreateCard } from "../../src/core/boardOperations";

const origin = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3411").replace(/\/+$/, "");
let step = 0;
const ok = (label: string) => console.log(`  ok ${++step} - ${label}`);
async function api(token: string | null, method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json().catch(() => null) as any };
}
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 997} planning note`).join(" ");

console.log(`Limit checks against ${origin}`);
const stamp = Date.now().toString(36);
const signIn = async (userId: string) => (await api(null, "POST", "/dev/token", { userId })).json.token as string;
const now = new Date().toISOString();
const board = async (token: string, id: string) => {
  const created = planCreateCard(createEmptyRoadmap({ repoId: id, title: "Limits", now }), { title: "Card" }, { now });
  const imported = await api(token, "POST", "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap: created.roadmap, docs: [], history: [] });
  assert.equal(imported.status, 201, JSON.stringify(imported.json));
  return created.roadmap.roadmapItems[0]!.id;
};
const writeSpec = async (token: string, boardId: string, cardId: string, markdown: string) => {
  const spec = await api(token, "GET", `/api/v1/boards/${boardId}/docs/${cardId}/spec`);
  return api(token, "POST", `/api/v1/boards/${boardId}/ops/writeDoc`, { cardId, kind: "spec", markdown, expectedMtimeMs: spec.json.mtimeMs });
};

// Daily changes: the 41st change in a day is refused with a clear message.
const busy = await signIn(`busy-${stamp}`);
const busyBoard = `limits-busy-${stamp}`;
const busyCard = await board(busy, busyBoard);
let refused: { status: number; json: any } | null = null;
for (let i = 0; i < 45 && !refused; i += 1) {
  const revision = (await api(busy, "GET", `/api/v1/boards/${busyBoard}`)).json.roadmap.revision;
  const result = await api(busy, "POST", `/api/v1/boards/${busyBoard}/ops/updateCard`, { cardId: busyCard, summary: `Edit ${i}`, baseRevision: revision });
  if (result.status !== 200) refused = result;
}
assert.equal(refused?.status, 429, JSON.stringify(refused?.json));
assert.match(refused!.json.error.message, /today's limit of 40 changes/);
ok("an account's changes are limited per day, with a message saying when it resets");

// Daily written text: writing the same large text again and again runs out.
const writer = await signIn(`writer-${stamp}`);
const writerBoard = `limits-writer-${stamp}`;
const writerCard = await board(writer, writerBoard);
let statuses: number[] = [];
for (let i = 0; i < 6; i += 1) statuses.push((await writeSpec(writer, writerBoard, writerCard, `# Round ${i}\n\n${words(10000)}`)).status);
assert.ok(statuses.includes(429), `written text is limited per day: ${statuses.join(", ")}`);
ok("the text an account writes is limited per day, however it is split");

// Board size: history included, a board cannot grow past its limit.
const filler = await signIn(`filler-${stamp}`);
const fillBoard = `limits-fill-${stamp}`;
const fillCard = await board(filler, fillBoard);
statuses = [];
for (let i = 0; i < 12 && !statuses.includes(400); i += 1) {
  const result = await writeSpec(filler, fillBoard, fillCard, `# Version ${i}\n\n${Array.from({ length: 2500 }, (_, j) => `Note ${i} ${j}: ${Math.random().toString(36).slice(2)} planning`).join("\n")}`);
  statuses.push(result.status);
  if (result.status === 400) assert.match(result.json.error.message, /history included/, result.json.error.message);
}
assert.ok(statuses.includes(400), `the board filled up: ${statuses.join(", ")}`);
ok("a board's stored text, history included, is capped");

// Imports: Take Online counts towards a daily allowance.
const importer = await signIn(`importer-${stamp}`);
let importStatus = 201;
for (let i = 0; i < 6 && importStatus === 201; i += 1) {
  const id = `limits-import-${stamp}-${i}`;
  const roadmap = planCreateCard(createEmptyRoadmap({ repoId: id, title: "Import", now }), { title: "Card" }, { now }).roadmap;
  importStatus = (await api(importer, "POST", "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap, docs: [{ cardId: roadmap.roadmapItems[0]!.id, kind: "spec", markdown: words(15000) }], history: [] })).status;
}
assert.equal(importStatus, 429);
ok("what an account takes online is limited per day");
console.log(`All ${step} checks passed.`);
