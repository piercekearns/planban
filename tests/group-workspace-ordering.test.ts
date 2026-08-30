import assert from "node:assert/strict";
import test from "node:test";
import {
  canPlaceItemInside,
  groupPlacementDecision,
  groupPlacementMove,
  previewGroupWorkspaceMove,
  groupWorkspaceDropOutcome,
  groupWorkspaceMoveForDrop,
  type GroupWorkspaceItem,
} from "../src/web/groupWorkspaceOrdering";

const items: GroupWorkspaceItem[] = [
  { id: "group", status: "in-progress", parentId: null, groupRank: null },
  { id: "first", status: "up-next", parentId: "group", groupRank: 1 },
  { id: "second", status: "up-next", parentId: "group", groupRank: 2 },
];

test("does not allow Group rail Items to contain one another", () => {
  assert.equal(groupWorkspaceDropOutcome(items, "first", "group-inside:second"), null);
});

test("rejects self-placement before mutation", () => {
  assert.equal(groupWorkspaceMoveForDrop(items, "first", "group-inside:first"), null);
});

test("keeps ordinary Group rail drops scoped to status and rank", () => {
  assert.deepEqual(groupWorkspaceMoveForDrop(items, "second", "group-item:first"), { status: "up-next", afterId: null });
  assert.deepEqual(groupWorkspaceMoveForDrop(items, "first", "group-item:second"), { status: "up-next", afterId: "second" });
  assert.deepEqual(groupWorkspaceMoveForDrop(items, "first", "group-status:pending"), { status: "pending" });
});

test("makes before and after rail intent explicit", () => {
  assert.deepEqual(groupWorkspaceMoveForDrop(items, "second", "group-before:first"), { status: "up-next", afterId: null });
  assert.deepEqual(groupWorkspaceMoveForDrop(items, "first", "group-after:second"), { status: "up-next", afterId: "second" });
});

test("uses Board Rank rather than storage order for root before placement", () => {
  const roots: GroupWorkspaceItem[] = [
    { id: "third", status: "pending", parentId: null, boardRank: 3 },
    { id: "first", status: "pending", parentId: null, boardRank: 1 },
    { id: "moving", status: "in-progress", parentId: null, boardRank: 1 },
    { id: "second", status: "pending", parentId: null, boardRank: 2 },
  ];
  assert.deepEqual(groupWorkspaceMoveForDrop(roots, "moving", "group-before:third"), {
    status: "pending",
    afterId: "second",
  });
});

test("keeps the committed hierarchy reorder visible while persistence is pending", () => {
  const roots: GroupWorkspaceItem[] = [
    { id: "first", status: "pending", parentId: null, boardRank: 1 },
    { id: "second", status: "pending", parentId: null, boardRank: 2 },
    { id: "moving", status: "pending", parentId: null, boardRank: 3 },
  ];

  const preview = previewGroupWorkspaceMove(roots, "moving", { status: "pending", afterId: "first" });
  const displayed = [...preview]
    .sort((a, b) => (a.boardRank ?? Number.MAX_SAFE_INTEGER) - (b.boardRank ?? Number.MAX_SAFE_INTEGER))
    .map((entry) => entry.id);

  assert.deepEqual(displayed, ["first", "moving", "second"]);
  assert.deepEqual(roots.map((entry) => entry.boardRank), [1, 2, 3]);
});

test("turns confirmed Placement choices into one atomic move", () => {
  assert.deepEqual(groupPlacementMove("second", "pending", { kind: "first" }), { parentId: "second", status: "pending", afterId: null });
  assert.deepEqual(groupPlacementMove("second", "pending", { kind: "last" }), { parentId: "second", status: "pending" });
  assert.deepEqual(groupPlacementMove("second", "pending", { kind: "after", siblingId: "existing" }), { parentId: "second", status: "pending", afterId: "existing" });
  assert.deepEqual(
    groupPlacementDecision({ activeId: "first", parentId: "second" }, "pending", { kind: "first" }),
    { activeId: "first", move: { parentId: "second", status: "pending", afterId: null } },
  );
  assert.equal(groupPlacementDecision({ activeId: "first", parentId: "second" }, "pending", null), null);
});

test("only root Items may be placed inside root Work Items", () => {
  const lifecycleItems: GroupWorkspaceItem[] = [
    ...items,
    { id: "closed-parent", status: "complete", parentId: null, groupRank: null, isGroup: true },
    { id: "closed-child", status: "complete", parentId: "group", groupRank: 3 },
    { id: "root-item", status: "pending", parentId: null, boardRank: 1, isGroup: false },
    { id: "root-target", status: "pending", parentId: null, boardRank: 2, isGroup: false },
  ];
  assert.equal(canPlaceItemInside(lifecycleItems, "first", "closed-parent"), false);
  assert.equal(canPlaceItemInside(lifecycleItems, "closed-child", "closed-parent"), true);
  assert.equal(canPlaceItemInside(lifecycleItems, "root-item", "root-target"), true);
});
