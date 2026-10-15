// Editing at the same time (Spec point 20): edits check only the fields they
// touch, and positions never clash.
import assert from "node:assert/strict";
import test from "node:test";
import { createEmptyRoadmap, planCreateCard, planMoveCard, planReorderCards, planUpdateCard, committedRoadmap } from "../src/core/boardOperations";
import { rebaseEdit } from "../src/core/concurrent";
import type { PlanbanRoadmap } from "../src/core/types";

const now = "2026-10-15T20:00:00.000Z";
function board(...titles: string[]): PlanbanRoadmap {
  let roadmap = createEmptyRoadmap({ repoId: "b", title: "B", now });
  for (const title of titles) roadmap = committedRoadmap(planCreateCard(roadmap, { title }, { now }).roadmap, now);
  return roadmap;
}
const update = (roadmap: PlanbanRoadmap, input: Record<string, unknown>) => committedRoadmap(planUpdateCard(roadmap, input as never, { now }).roadmap, now);
const move = (roadmap: PlanbanRoadmap, input: Record<string, unknown>) => committedRoadmap(planMoveCard(roadmap, input as never, { now }).roadmap, now);
const order = (roadmap: PlanbanRoadmap, status = "pending") => roadmap.roadmapItems.filter((item) => item.status === status).map((item) => item.id);

test("different cards: no clash", () => {
  const read = board("Alpha", "Beta");
  const current = update(read, { cardId: "alpha", summary: "Theirs" });
  const result = rebaseEdit("updateCard", { cardId: "beta", summary: "Mine" }, read, current);
  assert.equal(result.ok, true);
});

test("different fields of the same card: no clash, and both survive", () => {
  const read = board("Alpha");
  const current = update(read, { cardId: "alpha", summary: "Theirs" });
  const result = rebaseEdit("updateCard", { cardId: "alpha", nextAction: "Mine" }, read, current);
  assert.ok(result.ok);
  const applied = update(current, result.input);
  assert.deepEqual([applied.roadmapItems[0]!.summary, applied.roadmapItems[0]!.nextAction], ["Theirs", "Mine"]);
});

test("the same field: a clash that says what was read, what it is now, and what this edit wanted", () => {
  const read = board("Alpha");
  const current = update(read, { cardId: "alpha", summary: "Theirs" });
  const result = rebaseEdit("updateCard", { cardId: "alpha", summary: "Mine" }, read, current);
  assert.equal(result.ok, false);
  assert.deepEqual("clashes" in result && result.clashes, [{ cardId: "alpha", field: "summary", read: null, current: "Theirs", yours: "Mine" }]);
});

test("the same field changed to the same value is already covered, not a clash", () => {
  const read = board("Alpha");
  const current = update(read, { cardId: "alpha", summary: "Same" });
  assert.equal(rebaseEdit("updateCard", { cardId: "alpha", summary: "Same" }, read, current).ok, true);
});

test("metadata clashes per key, and an edit to another key keeps theirs", () => {
  const read = update(board("Alpha"), { cardId: "alpha", metadata: { a: 1, b: 1 } });
  const current = update(read, { cardId: "alpha", metadata: { a: 2, b: 1 } });
  const other = rebaseEdit("updateCard", { cardId: "alpha", metadata: { a: 1, b: 3 } }, read, current);
  assert.ok(other.ok);
  assert.deepEqual(update(current, other.input).roadmapItems[0]!.metadata, { a: 2, b: 3 });
  const same = rebaseEdit("updateCard", { cardId: "alpha", metadata: { a: 5, b: 1 } }, read, current);
  assert.equal(same.ok, false);
  assert.deepEqual("clashes" in same && same.clashes.map((clash) => clash.field), ["metadata.a"]);
});

test("moves never clash: two agents rearranging different cards both land", () => {
  const read = board("A", "B", "C", "D");
  // One agent puts D first; another, from the same read, puts A after C.
  const current = move(read, { cardId: "d", afterId: null });
  const result = rebaseEdit("moveCard", { cardId: "a", afterId: "c" }, read, current);
  assert.ok(result.ok);
  assert.deepEqual(order(move(current, result.input)), ["d", "b", "c", "a"]);
});

test("a move after a neighbour that has gone elsewhere lands at the end of the column", () => {
  const read = board("A", "B", "C");
  const current = move(read, { cardId: "b", status: "up-next" });
  const result = rebaseEdit("moveCard", { cardId: "a", afterId: "b" }, read, current);
  assert.ok(result.ok);
  assert.deepEqual(order(move(current, result.input)), ["c", "a"]);
});

test("two agents moving the same card to different columns clash on its column", () => {
  const read = board("A");
  const current = move(read, { cardId: "a", status: "up-next" });
  const result = rebaseEdit("moveCard", { cardId: "a", status: "in-progress" }, read, current);
  assert.equal(result.ok, false);
});

test("a whole-board reorder from an older read keeps cards added since, at the end of their column", () => {
  const read = board("A", "B");
  const current = committedRoadmap(planCreateCard(read, { title: "New" }, { now }).roadmap, now);
  const items = [{ id: "b", status: "pending" }, { id: "a", status: "pending" }];
  const result = rebaseEdit("reorderCards", { items }, read, current);
  assert.ok(result.ok);
  const applied = committedRoadmap(planReorderCards(current, result.input as never, { now }).roadmap, now);
  assert.deepEqual(order(applied), ["b", "a", "new"]);
});

test("deleting a card someone changed since is a clash", () => {
  const read = move(board("A"), { cardId: "a", status: "archived" });
  const current = update(read, { cardId: "a", summary: "Kept for a reason" });
  assert.equal(rebaseEdit("deleteArchivedCard", { cardId: "a" }, read, current).ok, false);
});

test("restoring the whole board still needs the current revision", () => {
  const read = board("A");
  assert.deepEqual(rebaseEdit("restoreBoard", { version: 1 }, read, update(read, { cardId: "a", summary: "x" })), { ok: false, boardWide: true });
});
