import assert from "node:assert/strict";
import test from "node:test";
import { flattenedExecutionMoveForDrop, flattenedExecutionProjection } from "../src/web/flattenedExecutionProjection";
import type { Status } from "../src/web/boardOrdering";

interface Item {
  id: string;
  title: string;
  status: Status;
  parentId: string | null;
  boardRank: number | null;
  groupRank: number | null;
}

const items: Item[] = [
  { id: "mimeeq", title: "MIMEeq Capability", status: "in-progress", parentId: null, boardRank: 1, groupRank: null },
  { id: "other-root", title: "Other Root", status: "pending", parentId: null, boardRank: 1, groupRank: null },
  { id: "authoring", title: "Product Authoring", status: "pending", parentId: "mimeeq", boardRank: null, groupRank: 2 },
  { id: "panels", title: "Panel-Aware Interiors", status: "pending", parentId: "mimeeq", boardRank: null, groupRank: 1 },
  { id: "logo", title: "R-Logo", status: "in-progress", parentId: "panels", boardRank: null, groupRank: 1 },
];

test("flattens every Work Item once with full ancestry and derived hierarchy ordering", () => {
  const projection = flattenedExecutionProjection(items);

  assert.equal(new Set(projection.items.map((item) => item.id)).size, items.length);
  assert.deepEqual(projection.grouped.pending.map((item) => item.id), ["panels", "authoring", "other-root"]);
  assert.deepEqual(projection.grouped["in-progress"].map((item) => item.id), ["mimeeq", "logo"]);
  assert.deepEqual(projection.ancestryById.get("logo")?.map((item) => item.id), ["mimeeq", "panels"]);
  assert.deepEqual(projection.ancestryById.get("other-root"), []);
  assert.equal(projection.counts.pending, 3);
  assert.equal(projection.wip, 2);
});

test("derives order without mutating the supplied hierarchy", () => {
  const before = structuredClone(items);
  flattenedExecutionProjection(items);
  assert.deepEqual(items, before);
});

test("turns flattened drops into status-only moves across Group boundaries", () => {
  assert.deepEqual(flattenedExecutionMoveForDrop(items, "authoring", "logo"), { status: "in-progress" });
  assert.deepEqual(flattenedExecutionMoveForDrop(items, "logo", "pending"), { status: "pending" });
  assert.equal(flattenedExecutionMoveForDrop(items, "authoring", "panels"), null);
  assert.equal(flattenedExecutionMoveForDrop(items, "missing", "pending"), null);
  assert.equal(flattenedExecutionMoveForDrop(items, "logo", "missing"), null);
});
