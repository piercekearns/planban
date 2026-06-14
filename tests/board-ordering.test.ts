import assert from "node:assert/strict";
import test from "node:test";
import {
  groupItems,
  previewDragOver,
  reorderItemsForDrop,
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
      item("alpha", "pending"),
      item("beta", "pending"),
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
