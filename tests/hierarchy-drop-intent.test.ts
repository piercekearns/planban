import assert from "node:assert/strict";
import test from "node:test";
import {
  hierarchyColumnDropPreview,
  hierarchyColumnTailTarget,
  hierarchyColumnSpatialTarget,
  hierarchyContainmentLatch,
  hierarchyContainmentCue,
  hierarchyContainmentSourceFootprint,
  hierarchyDropCommitDecision,
  hierarchyDraggedSourceOpacity,
  hierarchyReorderPlaceholderVisible,
  hierarchyDropOperation,
  hierarchyPlacementChanges,
  hierarchyReorderPreviewIndex,
} from "../src/web/hierarchyDropIntent";

const rect = { top: 100, bottom: 200, height: 100 };

test("uses stable top-quarter, middle-half, and bottom-quarter operations", () => {
  assert.equal(hierarchyDropOperation(110, rect), "before");
  assert.equal(hierarchyDropOperation(125, rect), "inside");
  assert.equal(hierarchyDropOperation(150, rect), "inside");
  assert.equal(hierarchyDropOperation(175, rect), "inside");
  assert.equal(hierarchyDropOperation(190, rect), "after");
});

test("splits an ineligible containment target into reorder halves", () => {
  assert.equal(hierarchyDropOperation(140, rect, { canMoveInside: false }), "before");
  assert.equal(hierarchyDropOperation(160, rect, { canMoveInside: false }), "after");
});

test("keeps the previous operation inside a small boundary deadband", () => {
  assert.equal(hierarchyDropOperation(127, rect, { previous: "before", deadbandPx: 3 }), "before");
  assert.equal(hierarchyDropOperation(123, rect, { previous: "inside", deadbandPx: 3 }), "inside");
  assert.equal(hierarchyDropOperation(173, rect, { previous: "after", deadbandPx: 3 }), "after");
  assert.equal(hierarchyDropOperation(177, rect, { previous: "inside", deadbandPx: 3 }), "inside");
});

test("keeps containment latched across small layout shifts and releases on a clear exit", () => {
  const target = { ...rect, left: 300, right: 500, width: 200 };
  assert.equal(hierarchyContainmentLatch({ x: 295, y: 150 }, target, 12), true);
  assert.equal(hierarchyContainmentLatch({ x: 505, y: 205 }, target, 12), true);
  assert.equal(hierarchyContainmentLatch({ x: 280, y: 150 }, target, 12), false);
  assert.equal(hierarchyContainmentLatch({ x: 400, y: 220 }, target, 12), false);
});

test("does not preview before a target while entering its bottom quarter from below", () => {
  assert.equal(hierarchyReorderPreviewIndex(2, 1, "after"), 2);
  assert.equal(hierarchyReorderPreviewIndex(2, 1, "before"), 1);
  assert.equal(hierarchyReorderPreviewIndex(0, 1, "before"), 0);
  assert.equal(hierarchyReorderPreviewIndex(0, 1, "after"), 1);
});

test("marks only before and after placement as provisional reorder placeholders", () => {
  assert.equal(hierarchyReorderPlaceholderVisible(null), false);
  assert.equal(hierarchyReorderPlaceholderVisible("inside"), false);
  assert.equal(hierarchyReorderPlaceholderVisible("before"), true);
  assert.equal(hierarchyReorderPlaceholderVisible("after"), true);
});

test("shows exactly one destination preview while moving inside", () => {
  assert.equal(hierarchyDraggedSourceOpacity(false, true), 0);
  assert.equal(hierarchyDraggedSourceOpacity(true, false), 1);
  assert.equal(hierarchyDraggedSourceOpacity(false, false), 0.45);
  assert.equal(hierarchyDraggedSourceOpacity(false, false, 0.4), 0.4);
});

test("retains the source footprint so containment targets stay fixed in both drag directions", () => {
  assert.equal(hierarchyContainmentSourceFootprint(158, true), 158);
  assert.equal(hierarchyContainmentSourceFootprint(158, false), undefined);
});

test("distinguishes adding to a Group from creating one while grouping", () => {
  assert.deepEqual(hierarchyContainmentCue(true), {
    label: "Add to Group",
    detail: "Release to choose placement",
  });
  assert.deepEqual(hierarchyContainmentCue(false), {
    label: "Create Group",
    detail: "Release to group both Items",
  });
});

test("keeps an explicit after-last preview when downward drag reaches column space", () => {
  const items = [
    { id: "group", status: "pending", parentId: null, boardRank: 1 },
    { id: "moving", status: "pending", parentId: null, boardRank: 2 },
    { id: "last", status: "pending", parentId: null, boardRank: 3 },
    { id: "nested", status: "pending", parentId: "group", groupRank: 1 },
  ];

  assert.equal(hierarchyColumnTailTarget(items, "moving", "pending"), "last");
  assert.equal(hierarchyColumnTailTarget(items, "last", "pending"), "moving");
});

test("accepts a different-status column drop without depending on column presentation", () => {
  const items = [
    { id: "moving-group", status: "up-next", parentId: null, boardRank: 1 },
    { id: "first", status: "pending", parentId: null, boardRank: 1 },
    { id: "last", status: "pending", parentId: null, boardRank: 2 },
  ];

  assert.deepEqual(hierarchyColumnDropPreview(items, "moving-group", "pending"), {
    status: "pending",
    targetId: "last",
    operation: "after",
  });
});

test("maps blank column space to the nearest visible card boundary", () => {
  const rects = [
    { id: "first", top: 100, bottom: 180 },
    { id: "second", top: 200, bottom: 280 },
  ];

  assert.equal(hierarchyColumnSpatialTarget(80, rects), "first");
  assert.equal(hierarchyColumnSpatialTarget(188, rects), "first");
  assert.equal(hierarchyColumnSpatialTarget(194, rects), "second");
  assert.equal(hierarchyColumnSpatialTarget(320, rects), "second");
  assert.equal(hierarchyColumnSpatialTarget(120, []), null);
});

test("commits exactly the hierarchy operation whose preview is still active", () => {
  assert.deepEqual(
    hierarchyDropCommitDecision("moving", "pending", "target", "pending", { targetId: "target", operation: "before" }),
    { kind: "hierarchy", targetId: "target", operation: "before" },
  );
  assert.deepEqual(
    hierarchyDropCommitDecision("moving", "pending", "target", "pending", { targetId: "target", operation: "inside" }),
    { kind: "hierarchy", targetId: "target", operation: "inside" },
  );
});

test("commits a visible containment preview when release collision resolves to the dragged source", () => {
  assert.deepEqual(
    hierarchyDropCommitDecision("moving", "pending", "moving", "pending", { targetId: "target", operation: "inside" }),
    { kind: "hierarchy", targetId: "target", operation: "inside" },
  );
});

test("does not commit a stale reorder preview after the pointer returns to the dragged card", () => {
  assert.deepEqual(
    hierarchyDropCommitDecision("moving", "pending", "moving", "pending", { targetId: "target", operation: "after" }),
    { kind: "noop" },
  );
});

test("same-status release without a placement preview is a no-op", () => {
  assert.deepEqual(hierarchyDropCommitDecision("moving", "pending", "pending", "pending", null), { kind: "noop" });
  assert.deepEqual(hierarchyDropCommitDecision("moving", "pending", "target", "pending", null), { kind: "noop" });
});

test("a different-status release remains an implicit column move", () => {
  assert.deepEqual(
    hierarchyDropCommitDecision("moving", "pending", "up-next", "up-next", null),
    { kind: "move", overId: "up-next" },
  );
});

test("recognizes when a placement preview would leave the item in its current slot", () => {
  const items = [
    { id: "first", status: "pending", parentId: null, boardRank: 1 },
    { id: "second", status: "pending", parentId: null, boardRank: 2 },
    { id: "third", status: "pending", parentId: null, boardRank: 3 },
  ];

  assert.equal(hierarchyPlacementChanges(items, "third", "second", "after"), false);
  assert.equal(hierarchyPlacementChanges(items, "third", "second", "before"), true);
  assert.equal(hierarchyPlacementChanges(items, "first", "second", "before"), false);
  assert.equal(hierarchyPlacementChanges(items, "first", "second", "after"), true);
});

test("a placement into another status or Group always changes scope", () => {
  const items = [
    { id: "moving", status: "pending", parentId: null, boardRank: 1 },
    { id: "other-status", status: "up-next", parentId: null, boardRank: 1 },
    { id: "nested", status: "pending", parentId: "group", groupRank: 1 },
  ];

  assert.equal(hierarchyPlacementChanges(items, "moving", "other-status", "before"), true);
  assert.equal(hierarchyPlacementChanges(items, "moving", "nested", "after"), true);
});
