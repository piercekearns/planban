// End-to-end check of the Planban Online service on a local Convex backend:
// development sign-in, Take Online, edits, conflicts, owner-only actions, a
// second person, a per-board agent, history and Take Local. Creates throwaway
// boards with random ids; touches no local board.
//
//   (cd online/service && CONVEX_AGENT_MODE=anonymous npx convex dev)   # in another terminal
//   npx convex env set PLANBAN_DEV_AUTH 1                                # once, in online/service
//   PLANBAN_ONLINE_URL=http://127.0.0.1:3211 node --import tsx/esm online/scripts/smoke-convex.ts
import assert from "node:assert/strict";
import { createEmptyRoadmap, planCreateCard } from "../../src/core/boardOperations";

const origin = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3211").replace(/\/+$/, "");

let step = 0;
function ok(label: string) {
  console.log(`  ok ${++step} - ${label}`);
}

interface Session { token: string }

async function devLogin(userId: string, options: { boards?: string[]; level?: string; clientName?: string } = {}): Promise<Session> {
  const response = await fetch(`${origin}/dev/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, ...options }),
  });
  assert.equal(response.status, 201, "development sign-in must be enabled on the local backend (PLANBAN_DEV_AUTH=1)");
  return { token: (await response.json()).token };
}

async function api(session: Session | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: await response.json().catch(() => null) as any };
}


/** An edit that states the board revision it was based on, read just before. */
async function op(session: Session, board: string, name: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const input = { ...body };
  if (!("baseRevision" in input)) {
    const current = await api(session, "GET", `/api/v1/boards/${board}`);
    input.baseRevision = current.json?.roadmap?.revision;
  }
  return api(session, "POST", `/api/v1/boards/${board}/ops/${name}`, input, headers);
}

const boardId = `smoke-${Date.now().toString(36)}`;
const now = new Date().toISOString();
let roadmap = createEmptyRoadmap({ repoId: boardId, title: "Smoke test board", now });
const first = planCreateCard(roadmap, { title: "First card", summary: "Imported from local" }, { now });
roadmap = { ...first.roadmap, revision: 7 };
const bundle = {
  format: "planban-board-bundle",
  version: 1,
  roadmap,
  docs: first.docWrites.map((doc) => ({ cardId: doc.cardId, kind: doc.kind, markdown: doc.markdown })),
  history: [{
    entry: { version: 3, roadmapRevision: 7, createdAt: now, actor: "user", operation: "card.create", summary: "Created First card", affectedCards: [first.cardId], affectedDocs: [] },
    roadmap,
  }],
};

console.log(`Planban Online smoke test against ${origin}, board ${boardId}`);

assert.equal((await api(null, "GET", "/api/v1/me")).status, 401);
assert.equal((await api({ token: "pbd_not-a-real-token-000000000000" }, "GET", "/api/v1/me")).status, 401);
ok("requests without a valid connection are refused");

const owner = await devLogin("owner", { clientName: "MacBook Planban" });
const me = await api(owner, "GET", "/api/v1/me");
assert.equal(me.json.userId, "owner");
ok("the owner signs in (development sign-in) and the service knows who they are");

const imported = await api(owner, "POST", "/api/v1/boards/import", bundle);
assert.equal(imported.status, 201, JSON.stringify(imported.json));
assert.equal(imported.json.roadmap.revision, 8);
ok("Take Online imports the board and bumps its revision once");
assert.equal((await api(owner, "POST", "/api/v1/boards/import", bundle)).status, 409);
ok("importing the same board id again is refused");

const raceId = `${boardId}-race`;
const raceRoadmap = { ...roadmap, project: { ...roadmap.project, id: raceId } };
const raced = await Promise.all([
  api(owner, "POST", "/api/v1/boards/import", { ...bundle, version: 99, roadmap: raceRoadmap }),
  api(owner, "POST", "/api/v1/boards/import", { ...bundle, roadmap: raceRoadmap }),
]);
assert.equal(raced[0].status, 400);
assert.equal(raced[1].status, 201, JSON.stringify(raced[1].json));
assert.equal((await api(owner, "GET", `/api/v1/boards/${raceId}`)).status, 200);
ok("a failed import leaves nothing behind and never orphans a racing import");

const listed = await api(owner, "GET", "/api/v1/boards");
assert.ok(listed.json.boards.some((board: { boardId: string }) => board.boardId === boardId));
ok("the board appears in the owner's board list");

const created = await op(owner, boardId, "createCard", { title: "Second card", baseRevision: 8, actor: "user" });
assert.equal(created.status, 200, JSON.stringify(created.json));
const secondId = created.json.result.createdCard.id;
assert.equal(created.json.roadmap.revision, 9);
ok("creating a card with the current revision works");

const unchanged = await api(owner, "GET", `/api/v1/boards/${boardId}?since=9`);
assert.deepEqual(unchanged.json, { unchanged: true, revision: 9, authority: "online" });
assert.equal((await api(owner, "GET", `/api/v1/boards/${boardId}/changes?since=0&waitMs=0`)).json.revision, 9);
ok("a client holding the current revision gets a small 'unchanged' reply");

const stale = await op(owner, boardId, "updateCard", { cardId: secondId, summary: "stale", baseRevision: 8 });
assert.equal(stale.status, 409);
assert.equal(stale.json.error.code, "conflict");
assert.equal(stale.json.error.currentRevision, 9);
ok("a stale revision is refused with a conflict and the current revision");

const spec = await api(owner, "GET", `/api/v1/boards/${boardId}/docs/${first.cardId}/spec`);
assert.equal(spec.json.exists, true);
const written = await op(owner, boardId, "writeDoc", { cardId: first.cardId, kind: "spec", markdown: "# First card\n\nEdited online.\n", expectedMtimeMs: spec.json.mtimeMs });
assert.equal(written.status, 200, JSON.stringify(written.json));
assert.ok(written.json.result.doc.mtimeMs > spec.json.mtimeMs);
const staleDoc = await op(owner, boardId, "writeDoc", { cardId: first.cardId, kind: "spec", markdown: "lost", expectedMtimeMs: spec.json.mtimeMs });
assert.equal(staleDoc.status, 409);
ok("document writes check the document stamp");

const cofounder = await devLogin("cofounder", { clientName: "Co-founder laptop" });
assert.equal((await api(cofounder, "GET", `/api/v1/boards/${boardId}`)).status, 404);
ok("a person who is not a member cannot see the board");
const invited = await api(owner, "POST", `/api/v1/boards/${boardId}/members`, { userId: "cofounder" });
assert.equal(invited.status, 200, JSON.stringify(invited.json));
const seen = await api(cofounder, "GET", `/api/v1/boards/${boardId}`);
assert.equal(seen.status, 200);
const edit = await op(cofounder, boardId, "updateCard", { cardId: secondId, nextAction: "Co-founder picks this up", baseRevision: seen.json.roadmap.revision });
assert.equal(edit.status, 200, JSON.stringify(edit.json));
ok("after the owner adds them, the co-founder can read and edit");

const agent = await devLogin("owner", { boards: [boardId], level: "plan", clientName: "Unattended agent" });
const agentBoards = await api(agent, "GET", "/api/v1/boards");
assert.deepEqual(agentBoards.json.boards.map((board: { boardId: string }) => board.boardId), [boardId]);
assert.equal((await api(agent, "GET", `/api/v1/boards/${raceId}`)).status, 404);
assert.equal((await op(agent, boardId, "moveCard", { cardId: secondId, status: "complete" })).status, 403);
const agentEdit = await op(agent, boardId, "moveCard", { cardId: secondId, status: "in-progress" });
assert.equal(agentEdit.status, 200, JSON.stringify(agentEdit.json));
ok("a per-board agent connection reaches only its board and can plan but not complete");

const reader = await devLogin("owner", { boards: [boardId], level: "read", clientName: "Read-only agent" });
assert.equal((await api(reader, "GET", `/api/v1/boards/${boardId}`)).status, 200);
assert.equal((await op(reader, boardId, "updateCard", { cardId: secondId, summary: "nope" })).status, 403);
ok("a read-only connection can read but not edit");

assert.equal((await op(cofounder, boardId, "moveCard", { cardId: secondId, status: "complete" })).status, 403);
assert.equal((await op(cofounder, boardId, "createCard", { title: "Sneaky", status: "complete" })).status, 403);
ok("an editor's own connection cannot complete cards");
const parentAlias = await op(agent, boardId, "setCardParent", { cardId: secondId, parentId: null, status: "complete" });
assert.equal(parentAlias.status, 200, JSON.stringify(parentAlias.json));
assert.notEqual(parentAlias.json.roadmap.roadmapItems.find((item: { id: string }) => item.id === secondId).status, "complete");
ok("setCardParent ignores status, so it cannot be used to complete a card");
const doneCard = await op(owner, boardId, "createCard", { title: "Already done", status: "complete" });
assert.equal(doneCard.status, 200, JSON.stringify(doneCard.json));
const doneId = doneCard.json.result.createdCard.id;
assert.equal((await op(agent, boardId, "createGroup", { title: "Group from done", itemIds: [doneId], anchorId: doneId })).status, 403);
ok("a Group that would inherit Complete status is owner-only too");
await api(owner, "POST", `/api/v1/boards/${boardId}/members`, { userId: "owner" });
const members = await api(owner, "GET", `/api/v1/boards/${boardId}/members`);
assert.equal(members.json.members.find((member: { userId: string }) => member.userId === "owner").role, "owner");
ok("inviting an existing owner never demotes them");
assert.equal((await op(owner, boardId, "moveCard", { cardId: doneId, status: "archived" })).status, 200);
assert.equal((await op(agent, boardId, "deleteArchivedCard", { cardId: doneId })).status, 403);
assert.equal((await op(owner, boardId, "deleteArchivedCard", { cardId: doneId })).status, 200);
const recreated = await op(owner, boardId, "createCard", { title: "Already done" });
assert.notEqual(recreated.json.result.createdCard.id, doneId);
ok("only the owner deletes cards, and a deleted card's id is never reused");

// Owner decision 10: every edit states its base version, and retries never duplicate.
const unbased = await api(owner, "POST", `/api/v1/boards/${boardId}/ops/createCard`, { title: "No base" });
assert.equal(unbased.status, 400);
assert.match(unbased.json.error.message, /baseRevision/);
assert.equal(typeof unbased.json.error.currentRevision, "number");
const unbasedDoc = await op(owner, boardId, "writeDoc", { cardId: first.cardId, kind: "plan", markdown: "# Plan\n" });
assert.equal(unbasedDoc.status, 400);
assert.match(unbasedDoc.json.error.message, /expectedMtimeMs/);
ok("an edit without the version it was based on is refused, with the current revision");
const key = `smoke-retry-${Date.now()}`;
const retryBase = (await api(owner, "GET", `/api/v1/boards/${boardId}`)).json.roadmap.revision;
const firstTry = await op(owner, boardId, "createCard", { title: "Created once", baseRevision: retryBase }, { "Idempotency-Key": key });
assert.equal(firstTry.status, 200, JSON.stringify(firstTry.json));
const retry = await op(owner, boardId, "createCard", { title: "Created once", baseRevision: retryBase }, { "Idempotency-Key": key });
assert.equal(retry.status, 200, JSON.stringify(retry.json));
assert.equal(retry.json.result.createdCard.id, firstTry.json.result.createdCard.id);
assert.equal(retry.json.roadmap.revision, firstTry.json.roadmap.revision);
const afterRetry = (await api(owner, "GET", `/api/v1/boards/${boardId}`)).json.roadmap;
assert.equal(afterRetry.roadmapItems.filter((item: { title: string }) => item.title === "Created once").length, 1);
assert.equal(afterRetry.revision, firstTry.json.roadmap.revision);
const misuse = await op(owner, boardId, "createCard", { title: "Different", baseRevision: afterRetry.revision }, { "Idempotency-Key": key });
assert.equal(misuse.status, 400);
ok("a retried edit with the same idempotency key returns the original result and applies once");

const history = await api(owner, "GET", `/api/v1/boards/${boardId}/history`);
assert.ok(history.json.entries.some((entry: { version: number }) => entry.version === 3), "imported history version kept");
assert.ok(history.json.entries.some((entry: any) => entry.attribution?.userId === "cofounder"));
ok("history keeps imported versions and attributes each change to a person and app");

// Many edits cross a snapshot boundary; export must rebuild every version exactly.
let revision = (await api(owner, "GET", `/api/v1/boards/${boardId}`)).json.roadmap.revision;
for (let index = 0; index < 30; index += 1) {
  const response = await op(owner, boardId, "updateCard", { cardId: secondId, summary: `Edit ${index}`, baseRevision: revision });
  assert.equal(response.status, 200, JSON.stringify(response.json));
  revision = response.json.roadmap.revision;
}

const returned = await api(owner, "POST", `/api/v1/boards/${boardId}/authority`, { state: "returned-local" });
assert.equal(returned.status, 200, JSON.stringify(returned.json));
const exported = await api(owner, "GET", `/api/v1/boards/${boardId}/export`);
assert.equal(exported.json.format, "planban-board-bundle");
assert.ok(exported.json.docs.some((doc: { markdown: string }) => doc.markdown.includes("Edited online")));
for (const version of exported.json.history) assert.equal(version.roadmap.revision, version.entry.roadmapRevision, `version ${version.entry.version}`);
for (let index = 0; index < 30; index += 1) {
  const version = exported.json.history.find((entry: any) => entry.roadmap.roadmapItems.find((item: any) => item.id === secondId)?.summary === `Edit ${index}`);
  assert.ok(version, `history version for edit ${index}`);
}
assert.equal(exported.json.history.at(-1).roadmap.revision, exported.json.roadmap.revision);
assert.deepEqual(exported.json.history.at(-1).roadmap, exported.json.roadmap);
assert.equal((await op(owner, boardId, "updateCard", { cardId: secondId, summary: "after take local" })).status, 409);
ok("export rebuilds every history version from snapshots and changes; after Take Local the online copy is read-only");
assert.ok(exported.json.historyDocs.some((doc: { markdown: string }) => doc.markdown.includes("Edited online")));
ok("export includes document bodies as they were at each history version");

const lastRevision = exported.json.roadmap.revision;
const reonline = await api(owner, "POST", "/api/v1/boards/import", exported.json);
assert.equal(reonline.status, 201, JSON.stringify(reonline.json));
assert.ok(reonline.json.roadmap.revision > lastRevision);
const reHistory = await api(owner, "GET", `/api/v1/boards/${boardId}/history`);
assert.ok(reHistory.json.entries.some((entry: { version: number }) => entry.version === 3));
assert.equal((await op(owner, boardId, "updateCard", { cardId: secondId, summary: "back online", baseRevision: reonline.json.roadmap.revision })).status, 200);
assert.equal((await api(cofounder, "POST", "/api/v1/boards/import", exported.json)).status, 409);
ok("the owner can take the same board online again; others cannot");
assert.ok(exported.json.retiredIds.includes(doneId));
const freshId = `${boardId}-copy`;
const copy = await api(owner, "POST", "/api/v1/boards/import", { ...exported.json, retiredIds: [], roadmap: { ...exported.json.roadmap, project: { ...exported.json.roadmap.project, id: freshId } } });
assert.equal(copy.status, 201, JSON.stringify(copy.json));
const copyCard = await op(owner, freshId, "createCard", { title: "Already done" });
assert.notEqual(copyCard.json.result.createdCard.id, doneId);
ok("deleted card ids stay retired through export and import, even rebuilt from history alone");

console.log(`All ${step} checks passed.`);
