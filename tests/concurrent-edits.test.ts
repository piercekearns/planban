// Editing at the same time (Spec point 20), end to end against the service's
// real handlers: two agents working from the same read of an online board.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import { errorReport } from "../src/core/errorReport";
import { onlineLogin } from "../src/core/online/login";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { takeOnline } from "../src/core/online/transfers";
import { serviceBridge } from "./service-bridge";

let root: string;
let bridge: Awaited<ReturnType<typeof serviceBridge>>;
const savedHome = process.env.PLANBAN_HOME;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-concurrent-"));
  process.env.PLANBAN_HOME = join(root, "home");
  bridge = await serviceBridge();
  resetCopyChecks();
});

test.afterEach(async () => {
  await bridge.close();
  await rm(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
});

async function onlineBoard(...titles: string[]) {
  const cwd = join(root, "project");
  await storage.initializeProject({ cwd, repoId: "roadmap", title: "Roadmap", updateAgents: false });
  for (const title of titles) await storage.createCard({ cwd, title });
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, cwd);
  return cwd;
}

const agent = "agent" as const;
const card = async (cwd: string, id: string) => (await storage.loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === id)!;
const column = async (cwd: string, status = "pending") => (await storage.loadState(cwd)).roadmap.roadmapItems.filter((item) => item.status === status).map((item) => item.id);
const refusal = (promise: Promise<unknown>) => promise.then(() => assert.fail("expected a refusal"), (error: unknown) => errorReport(error));

test("two agents on different cards, and on different fields of one card, both land", async () => {
  const cwd = await onlineBoard("Alpha", "Beta");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  await storage.updateCard({ cwd, cardId: "alpha", summary: "First agent", baseRevision: read, actor: agent });
  await storage.updateCard({ cwd, cardId: "beta", summary: "Second agent", baseRevision: read, actor: agent });
  await storage.updateCard({ cwd, cardId: "alpha", nextAction: "Second agent, other field", baseRevision: read, actor: agent });
  assert.deepEqual([(await card(cwd, "alpha")).summary, (await card(cwd, "alpha")).nextAction, (await card(cwd, "beta")).summary], ["First agent", "Second agent, other field", "Second agent"]);
});

test("moves never clash: two agents rearranging different cards from the same read both land", async () => {
  const cwd = await onlineBoard("A", "B", "C", "D");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  await storage.moveCard({ cwd, cardId: "d", afterId: null, baseRevision: read, actor: agent });
  await storage.moveCard({ cwd, cardId: "a", afterId: "c", baseRevision: read, actor: agent });
  assert.deepEqual(await column(cwd), ["d", "b", "c", "a"]);
});

test("the same field clashes; the refused edit waits as an unresolved change until a reconsidered version is saved", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  await storage.updateCard({ cwd, cardId: "alpha", summary: "First agent", baseRevision: read, actor: agent });
  const report = await refusal(storage.updateCard({ cwd, cardId: "alpha", summary: "Second agent", baseRevision: read, actor: agent }));
  assert.equal(report.category, "conflict");
  assert.match(report.message, /changed the summary of card "Alpha" since you read it/);
  const changeId = (report.details as { conflict: { unresolvedChange: string } }).conflict.unresolvedChange;
  assert.match(report.message, new RegExp(`kept as unresolved change ${changeId} on this card, for agents to see`));
  assert.equal((await card(cwd, "alpha")).summary, "First agent", "nothing overwritten");

  // Agents see it: on the board, and on the card.
  const waiting = (await storage.unresolvedChanges({ cwd })).changes;
  assert.deepEqual(waiting.map((change) => [change.changeId, change.cardId, change.fields, (change.proposed as { summary: string }).summary, change.by]), [[changeId, "alpha", ["summary"], "Second agent", "Ana's agent (Planban CLI)"]]);
  assert.equal((await storage.unresolvedChanges({ cwd, cardId: "alpha" })).changes.length, 1);

  // A reconsidered version, saved from the current revision, settles it, and the history says so plainly.
  const now = (await storage.loadState(cwd)).roadmap.revision;
  await storage.updateCard({ cwd, cardId: "alpha", summary: "First agent, and the second agent's point", baseRevision: now, actor: agent });
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes, []);
  const latest = (await storage.historyPayload(cwd)).entries[0]!;
  assert.match(latest.summary, /\(reconsidered after an earlier clash\)$/);
});

test("an agent drops a refused edit with a reason, and the card's history keeps it quietly", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  await storage.updateCard({ cwd, cardId: "alpha", nextAction: "Owner: pick a supplier", baseRevision: read, actor: agent });
  const report = await refusal(storage.updateCard({ cwd, cardId: "alpha", nextAction: "Agent: pick a supplier", baseRevision: read, actor: agent }));
  const changeId = (report.details as { conflict: { unresolvedChange: string } }).conflict.unresolvedChange;
  await assert.rejects(storage.dropChange({ cwd, changeId, reason: " ", baseRevision: (await storage.loadState(cwd)).roadmap.revision, actor: agent }), /Say why/);
  await storage.dropChange({ cwd, changeId, reason: "The owner is choosing the supplier.", baseRevision: (await storage.loadState(cwd)).roadmap.revision, actor: agent });
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes, []);
  assert.equal((await storage.historyPayload(cwd)).entries[0]!.summary, "Dropped an edit to Alpha: The owner is choosing the supplier.");
  assert.equal((await card(cwd, "alpha")).nextAction, "Owner: pick a supplier");
});

test("a clashing document write waits too, and a write of the current document settles it", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" });
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# First", expectedMtimeMs: read.mtimeMs, actor: agent });
  const report = await refusal(storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Second", expectedMtimeMs: read.mtimeMs, actor: agent }));
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes.map((change) => change.fields), [["spec"]]);
  const current = (report.details as { conflict: { document: { mtimeMs: number } } }).conflict.document;
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# First, with the second's point", expectedMtimeMs: current.mtimeMs, actor: agent });
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes, []);
});

test("a person's own refused edit isn't kept: the page shows them what changed", async () => {
  const cwd = await onlineBoard("Alpha");
  const read = (await storage.loadState(cwd)).roadmap.revision;
  await storage.updateCard({ cwd, cardId: "alpha", summary: "An agent's", baseRevision: read, actor: agent });
  const report = await refusal(storage.updateCard({ cwd, cardId: "alpha", summary: "The person's", baseRevision: read }));
  assert.equal(report.category, "conflict");
  assert.doesNotMatch(report.message, /unresolved/);
  assert.deepEqual((await storage.unresolvedChanges({ cwd })).changes, []);
});
