import assert from "node:assert/strict";
import test from "node:test";
import { flattenRoadmapForVersion1, hierarchyRecoveryManifest } from "../src/core/hierarchyMigration";
import type { PlanbanRoadmap } from "../src/core/types";

const roadmap: PlanbanRoadmap = {
  version: 2, writerVersion: 6, revision: 9, updatedAt: "2026-08-25T00:00:00.000Z",
  project: { id: "revival", title: "Revival", status: "active", description: "", tags: [] },
  columns: [],
  roadmapItems: [
    { id: "mimeeq", title: "MIMEeq", status: "in-progress", priority: 1, summary: null, nextAction: null, tags: [], icon: null, blockedBy: null, specDoc: "items/mimeeq/spec.md", planDoc: null, completedAt: null, updatedAt: null, isGroup: true, parentId: null, boardRank: 1, groupRank: null },
    { id: "panel-aware", title: "Panel-Aware", status: "pending", priority: 1, summary: null, nextAction: null, tags: [], icon: null, blockedBy: "r-logo", specDoc: "items/panel-aware/spec.md", planDoc: null, completedAt: null, updatedAt: null, isGroup: false, parentId: "mimeeq", boardRank: null, groupRank: 1 },
    { id: "r-logo", title: "R-logo", status: "up-next", priority: 1, summary: null, nextAction: null, tags: [], icon: null, blockedBy: null, specDoc: "items/r-logo/spec.md", planDoc: null, completedAt: null, updatedAt: null, isGroup: false, parentId: "mimeeq", boardRank: null, groupRank: 1 },
  ],
};

test("flattens hierarchy for version 1 without changing identity, evidence, status, or blockers", () => {
  const flat = flattenRoadmapForVersion1(roadmap);
  assert.equal(flat.version, 1);
  assert.deepEqual(flat.roadmapItems.map((item) => item.id), ["mimeeq", "r-logo", "panel-aware"]);
  assert.deepEqual(flat.roadmapItems.map((item) => [item.id, item.status, item.blockedBy, item.specDoc]), [
    ["mimeeq", "in-progress", null, "items/mimeeq/spec.md"],
    ["r-logo", "up-next", null, "items/r-logo/spec.md"],
    ["panel-aware", "pending", "r-logo", "items/panel-aware/spec.md"],
  ]);
  for (const item of flat.roadmapItems) {
    assert.equal("parentId" in item, false);
    assert.equal("isGroup" in item, false);
    assert.equal("reviewState" in item, false);
  }
  assert.equal(roadmap.roadmapItems[1]?.parentId, "mimeeq");
});

test("records every hierarchy field needed for lossless recovery", () => {
  const recovery = hierarchyRecoveryManifest(roadmap, 12);
  assert.equal(recovery.historyVersion, 12);
  assert.deepEqual(recovery.items[1], { id: "panel-aware", parentId: "mimeeq", isGroup: false, boardRank: null, groupRank: 1 });
});

test("uses canonical lineage status and rank ordering when flattening cross-status branches", () => {
  const common = { priority: 1, summary: null, nextAction: null, tags: [] as string[], icon: null, blockedBy: null, specDoc: null, planDoc: null, completedAt: null, updatedAt: null };
  const crossStatus: PlanbanRoadmap = {
    ...roadmap,
    roadmapItems: [
      { ...common, id: "z-in-progress-root", title: "Z root", status: "in-progress", isGroup: true, parentId: null, boardRank: 2, groupRank: null },
      { ...common, id: "a-up-next-root", title: "A root", status: "up-next", isGroup: true, parentId: null, boardRank: 1, groupRank: null },
      { ...common, id: "z-pending-child", title: "Z child", status: "pending", isGroup: false, parentId: "z-in-progress-root", boardRank: null, groupRank: 1 },
      { ...common, id: "a-pending-child", title: "A child", status: "pending", isGroup: false, parentId: "a-up-next-root", boardRank: null, groupRank: 1 },
    ],
  };

  const flat = flattenRoadmapForVersion1(crossStatus);
  assert.deepEqual(flat.roadmapItems.filter((item) => item.status === "pending").map((item) => item.id), ["z-pending-child", "a-pending-child"]);
  assert.deepEqual(flat.roadmapItems.filter((item) => item.status === "pending").map((item) => item.priority), [1, 2]);
});
