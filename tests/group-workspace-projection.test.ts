import assert from "node:assert/strict";
import test from "node:test";
import { groupWorkspaceProjection } from "../src/web/groupWorkspaceProjection";

const items = [
  { id: "mimeeq", status: "in-progress", parentId: null, groupRank: null },
  { id: "authoring", status: "in-progress", parentId: "mimeeq", groupRank: 1 },
  { id: "direct-next", status: "up-next", parentId: "mimeeq", groupRank: 1 },
  { id: "direct-pending", status: "pending", parentId: "mimeeq", groupRank: 1 },
] as const;

test("projects direct Group children with scoped counts and WIP", () => {
  const workspace = groupWorkspaceProjection(items, "mimeeq");
  assert.deepEqual(workspace.items.map((item) => item.id), ["authoring", "direct-next", "direct-pending"]);
  assert.equal(workspace.counts["in-progress"], 1);
  assert.equal(workspace.counts["up-next"], 1);
  assert.equal(workspace.counts.pending, 1);
  assert.equal(workspace.wip, 1);
});

test("does not infer a workspace for an Item", () => {
  const workspace = groupWorkspaceProjection(items, "authoring");
  assert.deepEqual(workspace.items, []);
  assert.equal(workspace.counts.pending, 0);
  assert.equal(workspace.wip, 0);
});
