import assert from "node:assert/strict";
import test from "node:test";
import {
  groupItems,
  previewCrossStatusDragOver,
  previewDragOver,
  reorderItemsForDrop,
  resolveDropTargetId,
  statusForDropTarget,
  type BoardOrderItem,
} from "../src/web/boardOrdering";

function item(id: string, status: BoardOrderItem["status"], priority: number | null = null): BoardOrderItem {
  return { id, status, priority };
}

test("groups by status priority for board rendering", () => {
  const grouped = groupItems([
    item("beta", "pending", 2),
    item("alpha", "pending", 1),
    item("gamma", "up-next", null),
  ]);

  assert.deepEqual(grouped.pending.map((entry) => entry.id), ["alpha", "beta"]);
  assert.deepEqual(grouped["up-next"].map((entry) => entry.id), ["gamma"]);
});

test("reorders cards within the same status without changing other columns", () => {
  const next = reorderItemsForDrop(
    [
      item("alpha", "pending", 1),
      item("beta", "pending", 2),
      item("gamma", "up-next"),
    ],
    "beta",
    "alpha",
  );

  assert.deepEqual(next.map((entry) => [entry.id, entry.status]), [
    ["gamma", "up-next"],
    ["beta", "pending"],
    ["alpha", "pending"],
  ]);
  assert.deepEqual(next.filter((entry) => entry.status === "pending").map((entry) => [entry.id, entry.priority]), [
    ["beta", 1],
    ["alpha", 2],
  ]);
});

test("same-column drag preview carries priorities that match visual order", () => {
  const next = previewDragOver(
    [
      item("alpha", "pending", 1),
      item("beta", "pending", 2),
      item("gamma", "pending", 3),
    ],
    "gamma",
    "alpha",
  );

  assert.deepEqual(groupItems(next).pending.map((entry) => [entry.id, entry.priority]), [
    ["gamma", 1],
    ["alpha", 2],
    ["beta", 3],
  ]);
});

test("final same-column drop from drag-start order is not double-applied after preview", () => {
  const dragStartItems = [
    item("alpha", "pending", 1),
    item("beta", "pending", 2),
    item("gamma", "pending", 3),
  ];
  const previewItems = previewDragOver(dragStartItems, "gamma", "alpha");
  const committedFromStart = reorderItemsForDrop(dragStartItems, "gamma", "alpha");
  const committedFromPreview = reorderItemsForDrop(previewItems, "gamma", "alpha");

  assert.deepEqual(committedFromStart.map((entry) => entry.id), ["gamma", "alpha", "beta"]);
  assert.deepEqual(committedFromPreview.map((entry) => entry.id), ["alpha", "gamma", "beta"]);
});

test("moves cards into another status before the hovered card", () => {
  const next = reorderItemsForDrop(
    [
      item("alpha", "pending"),
      item("beta", "up-next"),
      item("gamma", "up-next"),
    ],
    "alpha",
    "gamma",
  );

  assert.deepEqual(next.map((entry) => [entry.id, entry.status]), [
    ["beta", "up-next"],
    ["alpha", "up-next"],
    ["gamma", "up-next"],
  ]);
});

test("moves cards to the end of a status when dropped on a column", () => {
  const next = reorderItemsForDrop(
    [
      item("alpha", "pending"),
      item("beta", "up-next"),
      item("gamma", "pending"),
    ],
    "beta",
    "pending",
  );

  assert.deepEqual(next.map((entry) => [entry.id, entry.status]), [
    ["alpha", "pending"],
    ["gamma", "pending"],
    ["beta", "pending"],
  ]);
});

test("preview drag-over updates cross-column status but ignores same-column column hover", () => {
  const items = [
    item("alpha", "pending"),
    item("beta", "pending"),
  ];

  assert.equal(statusForDropTarget(items, "pending"), "pending");
  assert.equal(previewDragOver(items, "alpha", "pending"), items);

  const next = previewDragOver(items, "alpha", "up-next");
  assert.deepEqual(next.map((entry) => [entry.id, entry.status]), [
    ["alpha", "up-next"],
    ["beta", "pending"],
  ]);
});

test("cross-status-only preview leaves same-column ordering to the sortable layer", () => {
  const items = [
    item("alpha", "pending", 1),
    item("beta", "pending", 2),
    item("gamma", "pending", 3),
  ];

  assert.equal(previewCrossStatusDragOver(items, "gamma", "alpha"), items);
});

test("cross-status-only preview inserts the dragged card before the hovered destination card", () => {
  const dragStartItems = [
    item("alpha", "pending", 1),
    item("beta", "up-next", 1),
    item("gamma", "up-next", 2),
  ];
  const firstPreview = previewCrossStatusDragOver(dragStartItems, "alpha", "gamma");
  const secondPreview = previewCrossStatusDragOver(dragStartItems, "alpha", "gamma");

  assert.deepEqual(firstPreview.map((entry) => [entry.id, entry.status, entry.priority]), [
    ["beta", "up-next", 1],
    ["alpha", "up-next", 2],
    ["gamma", "up-next", 3],
  ]);
  assert.deepEqual(secondPreview, firstPreview);
});

test("cross-status-only preview moves the dragged card to the end of a hovered column", () => {
  const next = previewCrossStatusDragOver(
    [
      item("alpha", "pending", 1),
      item("beta", "up-next", 1),
      item("gamma", "pending", 2),
    ],
    "beta",
    "pending",
  );

  assert.deepEqual(next.map((entry) => [entry.id, entry.status, entry.priority]), [
    ["alpha", "pending", 1],
    ["gamma", "pending", 2],
    ["beta", "pending", 3],
  ]);
});

test("drop target resolver preserves the last real target when preview makes the active card self-hover", () => {
  const dragStartItems = [
    item("alpha", "pending", 1),
    item("beta", "up-next", 1),
    item("gamma", "up-next", 2),
  ];

  const resolved = resolveDropTargetId(dragStartItems, "alpha", "alpha", "gamma");
  const next = resolved ? reorderItemsForDrop(dragStartItems, "alpha", resolved) : dragStartItems;

  assert.equal(resolved, "gamma");
  assert.deepEqual(next.map((entry) => [entry.id, entry.status, entry.priority]), [
    ["beta", "up-next", 1],
    ["alpha", "up-next", 2],
    ["gamma", "up-next", 3],
  ]);
});

test("drop target resolver keeps a direct non-self drop target over the fallback", () => {
  const dragStartItems = [
    item("alpha", "pending", 1),
    item("beta", "pending", 2),
    item("gamma", "up-next", 1),
  ];

  assert.equal(resolveDropTargetId(dragStartItems, "alpha", "beta", "gamma"), "beta");
});
