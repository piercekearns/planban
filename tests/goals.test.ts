// A board's goals (owner decisions, 16 October 2026): people change them;
// agents only suggest; every change is a revision with a history entry; the
// same clash rules as other fields; and goals travel with the board.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import { addSuggestion, decideSuggestion, emptyGoals, goalsBlock, type GoalsFile } from "../src/core/goals";
import { onlineLogin } from "../src/core/online/login";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { backupRoot, refreshBackup } from "../src/core/online/backup";
import { restoreBackup, takeLocal, takeOnline } from "../src/core/online/transfers";
import { serviceBridge } from "./service-bridge";

let root: string;
let cwd: string;
const savedHome = process.env.PLANBAN_HOME;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-goals-"));
  process.env.PLANBAN_HOME = join(root, "home");
  cwd = join(root, "revival");
  await storage.initializeProject({ cwd, repoId: "revival", title: "Revival", updateAgents: false });
  await storage.createCard({ cwd, title: "Alpha" });
  resetCopyChecks();
});

test.afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
});

const revision = async () => (await storage.loadState(cwd)).roadmap.revision;
const statements = async () => (await storage.readGoals({ cwd })).page.goals.map((goal) => goal.statement);
const edit = async (change: Record<string, unknown>, baseRevision?: number) => storage.editGoals({ cwd, edit: change, baseRevision: baseRevision ?? await revision() });

async function revivalGoals() {
  for (const statement of ["Win clubs", "Onboard and deliver without the owner", "Keep clubs for life", "Faster building"]) await edit({ kind: "add", statement });
}

test("people add, reword, reorder, retire and restore goals and set the context; each change is a revision with a history entry", async () => {
  const before = await revision();
  await revivalGoals();
  assert.deepEqual(await statements(), ["Win clubs", "Onboard and deliver without the owner", "Keep clubs for life", "Faster building"]);
  const [win, onboard, , faster] = (await storage.readGoals({ cwd })).page.goals;
  await edit({ kind: "reword", goalId: onboard!.id, notes: "Log every step of the next order." });
  await edit({ kind: "move", goalId: faster!.id, afterId: win!.id });
  assert.deepEqual(await statements(), ["Win clubs", "Faster building", "Onboard and deliver without the owner", "Keep clubs for life"]);
  await edit({ kind: "retire", goalId: faster!.id });
  await edit({ kind: "context", context: "Constraints. The owner is part-time until June 2027." });
  let page = (await storage.readGoals({ cwd })).page;
  assert.equal(page.retired[0]!.statement, "Faster building");
  assert.equal(page.goals[1]!.notes, "Log every step of the next order.");
  assert.match(page.context, /part-time/);
  await edit({ kind: "restore", goalId: faster!.id });
  page = (await storage.readGoals({ cwd })).page;
  assert.equal(page.goals.at(-1)!.statement, "Faster building");
  assert.equal(await revision(), before + 9);
  const history = (await storage.historyPayload(cwd)).entries.filter((entry) => entry.operation === "goals.edit").map((entry) => entry.summary);
  assert.equal(history.length, 9);
  assert.ok(history.includes('Goals: retired "Faster building"'));
  // Goals never touch the cards.
  assert.deepEqual((await storage.loadState(cwd)).roadmap.roadmapItems.map((item) => item.title), ["Alpha"]);
});

test("agents can't change goals; they suggest, and the person accepts or dismisses", async () => {
  await revivalGoals();
  await assert.rejects(storage.editGoals({ cwd, edit: { kind: "add", statement: "Mine" }, actor: "agent" }), /Only people change a board's goals/);
  await assert.rejects(storage.decideGoalSuggestion({ cwd, suggestionId: "x", decision: "accept", actor: "agent" }), /Only people change a board's goals/);
  const suggested = await storage.suggestGoalChange({ cwd, change: { kind: "add", statement: "Win back lapsed clubs", position: 4 }, reason: "Three clubs from last year haven't reordered.", agentName: "Claude" });
  assert.equal(suggested.page.suggestions[0]!.summary, 'add "Win back lapsed clubs" as goal 4');
  assert.equal(suggested.page.suggestions[0]!.by, "Claude");
  // The same suggestion again is not added twice.
  assert.match((await storage.suggestGoalChange({ cwd, change: { kind: "add", statement: "win back lapsed clubs!" }, reason: "Again." })).notAdded!, /already waiting/);
  await storage.decideGoalSuggestion({ cwd, suggestionId: suggested.page.suggestions[0]!.id, decision: "dismiss" });
  const again = await storage.suggestGoalChange({ cwd, change: { kind: "add", statement: "Win back lapsed clubs" }, reason: "Still true." });
  assert.match(again.notAdded!, /was dismissed on .* isn't shown again until 30 days after that/);
  assert.equal(again.page.recentlyDismissed[0]!.summary, 'add "Win back lapsed clubs" as goal 4');
  // Accepting makes the change, as the person's.
  const retire = await storage.suggestGoalChange({ cwd, change: { kind: "retire", goal: "4" }, reason: "No work on it for six weeks." });
  const accepted = await storage.decideGoalSuggestion({ cwd, suggestionId: retire.page.suggestions[0]!.id, decision: "accept" });
  assert.deepEqual(accepted.page.goals.map((goal) => goal.statement), ["Win clubs", "Onboard and deliver without the owner", "Keep clubs for life"]);
  assert.equal(accepted.page.suggestions.length, 0);
});

test("a dismissed suggestion can come back once 30 days have passed", () => {
  let file: GoalsFile = { ...emptyGoals(), goals: [{ id: "g1", statement: "Win clubs", notes: "", createdAt: "", updatedAt: "" }] };
  const stamp = (now: string) => ({ revision: 2, by: "Claude", now, id: now });
  const first = addSuggestion(file, { change: { kind: "retire", goal: "1" }, reason: "Quiet." }, stamp("2026-10-01T00:00:00.000Z"));
  assert.ok(first.goals);
  file = decideSuggestion(first.goals!, { suggestionId: first.suggestion.id, decision: "dismiss" }, stamp("2026-10-01T01:00:00.000Z")).goals;
  assert.equal(addSuggestion(file, { change: { kind: "retire", goal: "1" }, reason: "Quiet." }, stamp("2026-10-30T00:00:00.000Z")).goals, null);
  assert.ok(addSuggestion(file, { change: { kind: "retire", goal: "1" }, reason: "Quiet still." }, stamp("2026-11-01T00:00:00.000Z")).goals);
});

test("edits clash only over the same part, changed since it was read; moves never clash", async () => {
  await revivalGoals();
  const read = await revision();
  const [win, onboard] = (await storage.readGoals({ cwd })).page.goals;
  await edit({ kind: "reword", goalId: win!.id, statement: "Win clubs this term" }, read);
  // Another goal, the same goal's notes, and moves go through.
  await edit({ kind: "reword", goalId: onboard!.id, statement: "Deliver without the owner" }, read);
  await edit({ kind: "reword", goalId: win!.id, notes: "Pitch each club with its own design." }, read);
  await edit({ kind: "move", goalId: win!.id, afterId: onboard!.id }, read);
  // The same statement, changed since: refused, saying who and what it is now.
  await assert.rejects(edit({ kind: "reword", goalId: win!.id, statement: "Win more clubs" }, read), /Not saved: goal "Win clubs this term" was changed by you since you read it\. It is now: "Win clubs this term"/);
  // The same value is no clash.
  await edit({ kind: "reword", goalId: win!.id, statement: "Win clubs this term" }, read);
  await edit({ kind: "context", context: "First." }, read);
  await assert.rejects(edit({ kind: "context", context: "Second." }, read), /the goals' context was changed/);
});

test("the agents' Goals block lists the statements only, and only when there are goals", async () => {
  assert.equal(goalsBlock(emptyGoals()), null);
  assert.equal(await storage.readGoalsBlock(cwd), null);
  await revivalGoals();
  await edit({ kind: "reword", goalId: "g1", notes: "Secret detail" });
  const block = (await storage.readGoalsBlock(cwd))!;
  assert.match(block, /^Goals, most important first:\n1\. Win clubs\n2\. Onboard and deliver without the owner\n3\. Keep clubs for life\n4\. Faster building\nRead the Goals page for notes and context/);
  assert.doesNotMatch(block, /Secret detail/);
});

test("goals are text only and one line each", async () => {
  await assert.rejects(edit({ kind: "add", statement: "" }), /can't be empty/);
  await assert.rejects(edit({ kind: "add", statement: "x".repeat(201) }), /one line of at most 200 characters/);
  await assert.rejects(edit({ kind: "add", statement: "Logo", notes: `data:image/png;base64,${"A".repeat(400)}` }), /text only|Planban/);
});

test("online: the same rules on the service, and goals move with the board, into backups and back", async () => {
  const bridge = await serviceBridge([["ana", "Ana"], ["ben", "Ben"]]);
  try {
    await revivalGoals();
    await edit({ kind: "context", context: "Ambition. Win the club-only market." });
    await onlineLogin(bridge.url, { devUser: "ana" });
    await takeOnline(bridge.url, cwd);
    assert.deepEqual(await statements(), ["Win clubs", "Onboard and deliver without the owner", "Keep clubs for life", "Faster building"]);
    await edit({ kind: "reword", goalId: "g4", statement: "Faster building, when apt" });
    await assert.rejects(storage.editGoals({ cwd, edit: { kind: "add", statement: "Mine" }, actor: "agent" }), /Only people change a board's goals/);
    // An agent going straight to the service is refused too.
    const { onlineRequest, boardPath } = await import("../src/core/online/client");
    await assert.rejects(onlineRequest(bridge.url, boardPath("revival", "/ops/editGoals"), { edit: { kind: "add", statement: "Mine" }, actor: "agent" }), /Only people change a board's goals/);
    const suggested = await storage.suggestGoalChange({ cwd, change: { kind: "reorder", goal: "3", position: 1 }, reason: "Two clubs churned this month.", agentName: "Codex" });
    assert.equal(suggested.page.suggestions[0]!.by, "Ana's agent (Codex)");
    const history = (await storage.historyPayload(cwd)).entries.filter((entry) => entry.operation === "goals.edit");
    assert.ok(history.some((entry) => /Ana's agent \(Codex\) suggested to move goal 3/.test(entry.summary)));
    await storage.decideGoalSuggestion({ cwd, suggestionId: suggested.page.suggestions[0]!.id, decision: "accept" });
    assert.equal((await statements())[0], "Keep clubs for life");
    // The computer's backup keeps the goals, and a restored copy has them.
    await refreshBackup(bridge.url, "revival", { force: true });
    const restored = join(root, "restored");
    await restoreBackup(join(backupRoot(bridge.url, "revival"), "latest"), restored, "revival-restored");
    assert.equal((await storage.readGoals({ cwd: restored })).page.goals[0]!.statement, "Keep clubs for life");
    // Back to this computer, goals and all.
    await takeLocal(cwd);
    const back = (await storage.readGoals({ cwd })).page;
    assert.equal(back.goals[0]!.statement, "Keep clubs for life");
    assert.match(back.context, /club-only market/);
    assert.match(await readFile(join((await storage.loadState(cwd)).planningRoot, "goals.json"), "utf8"), /Faster building, when apt/);
  } finally {
    await bridge.close();
  }
});
