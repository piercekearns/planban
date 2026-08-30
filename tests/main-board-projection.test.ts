import assert from "node:assert/strict";
import test from "node:test";
import { mainBoardProjection, itemsInGroup, groupProgressSegments, groupRollup, workItemRank } from "../src/web/mainBoardProjection";

const items = [
  { id: "mimeeq", title: "MIMEeq Capability", status: "in-progress", parentId: null, boardRank: 1, groupRank: null, isGroup: true, blockedBy: null },
  { id: "authoring", title: "Product Authoring", status: "in-progress", parentId: "mimeeq", boardRank: null, groupRank: 1, isGroup: false, blockedBy: null },
  { id: "ready", title: "Ready Review", status: "pending", parentId: "mimeeq", boardRank: null, groupRank: 1, isGroup: false, blockedBy: null },
  { id: "blocked", title: "Blocked Work", status: "up-next", parentId: "mimeeq", boardRank: null, groupRank: 2, isGroup: false, blockedBy: "ready" },
  { id: "complete", title: "Complete Work", status: "complete", parentId: "mimeeq", boardRank: null, groupRank: 1, isGroup: false, blockedBy: null },
  { id: "fourth", title: "Fourth Work", status: "in-progress", parentId: "mimeeq", boardRank: null, groupRank: 3, isGroup: false, blockedBy: null },
] as const;

test("projects only root Work Items onto the Main Board", () => {
  const projection = mainBoardProjection(items);
  assert.deepEqual(projection.map((item) => item.id), ["mimeeq"]);
  assert.equal(projection.filter((item) => item.status === "in-progress").length, 1);
});

test("renders Main Board rank independently of descendant-inflated legacy priority", () => {
  assert.equal(workItemRank({ ...items[0], boardRank: 2, priority: 7 }), 2);
});

test("rolls up direct Items and snapshots the first three active items in workflow order", () => {
  const rollup = groupRollup(items, "mimeeq");
  assert.equal(rollup.total, 5);
  assert.equal(rollup.complete, 1);
  assert.equal(rollup.blocked, 1);
  assert.deepEqual(rollup.previews.map((item) => item.id), ["authoring", "fourth", "blocked"]);
});

test("fills unused snapshot slots with the most recently completed Items", () => {
  const rollup = groupRollup([
    { id: "group", title: "Group", status: "in-progress", parentId: null, boardRank: 1, groupRank: null, isGroup: true, blockedBy: null, completedAt: null },
    { id: "active", title: "Active", status: "up-next", parentId: "group", boardRank: null, groupRank: 1, isGroup: false, blockedBy: null, completedAt: null },
    { id: "older-complete", title: "Older Complete", status: "complete", parentId: "group", boardRank: null, groupRank: 1, isGroup: false, blockedBy: null, completedAt: "2026-08-26T09:00:00.000Z" },
    { id: "newer-complete", title: "Newer Complete", status: "complete", parentId: "group", boardRank: null, groupRank: 2, isGroup: false, blockedBy: null, completedAt: "2026-08-28T09:00:00.000Z" },
    { id: "archived", title: "Archived", status: "archived", parentId: "group", boardRank: null, groupRank: 1, isGroup: false, blockedBy: null, completedAt: null },
  ] as const, "group");

  assert.deepEqual(rollup.previews.map((item) => item.id), ["active", "newer-complete", "older-complete"]);
});

test("orders expanded Items by workflow status and then Group Rank", () => {
  assert.deepEqual(itemsInGroup(items, "mimeeq").map((item) => item.id), [
    "authoring",
    "fourth",
    "blocked",
    "ready",
    "complete",
  ]);
});

test("projects non-archived Group work into proportional workflow segments", () => {
  const rollup = groupRollup([
    ...items,
    { id: "archived", title: "Archived Work", status: "archived", parentId: "mimeeq", boardRank: null, groupRank: 4, isGroup: false, blockedBy: null },
  ], "mimeeq");

  assert.deepEqual(groupProgressSegments(rollup), [
    { status: "complete", count: 1, fraction: 0.2 },
    { status: "in-progress", count: 2, fraction: 0.4 },
    { status: "up-next", count: 1, fraction: 0.2 },
    { status: "pending", count: 1, fraction: 0.2 },
  ]);
});
