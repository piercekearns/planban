import assert from "node:assert/strict";
import test from "node:test";
import { queryWorkItems, workItemQueryFromSearchParams } from "../src/core/workItemQuery";
import type { PlanbanRoadmapItem } from "../src/core/types";

function item(input: Partial<PlanbanRoadmapItem> & Pick<PlanbanRoadmapItem, "id" | "title">): PlanbanRoadmapItem {
  return {
    id: input.id,
    title: input.title,
    status: input.status ?? "pending",
    priority: input.priority ?? 1,
    summary: input.summary ?? null,
    nextAction: input.nextAction ?? null,
    tags: input.tags ?? [],
    icon: null,
    blockedBy: input.blockedBy ?? null,
    specDoc: null,
    planDoc: null,
    completedAt: null,
    updatedAt: null,
    isGroup: input.isGroup ?? false,
    parentId: input.parentId ?? null,
    boardRank: input.parentId ? null : input.boardRank ?? 1,
    groupRank: input.parentId ? input.groupRank ?? 1 : null,
  };
}

const items = [
  item({ id: "mimeeq", title: "MIMEeq Capability", status: "in-progress", isGroup: true }),
  item({ id: "authoring", title: "Product Authoring", summary: "MIME type authoring", tags: ["editor"], parentId: "mimeeq" }),
  item({ id: "panels", title: "Panel-Aware Interiors", parentId: "mimeeq", groupRank: 2 }),
  item({ id: "logo", title: "R-Logo", nextAction: "Validate panel render", tags: ["editor", "visual"], parentId: "mimeeq", groupRank: 3, blockedBy: "authoring" }),
  item({ id: "launch", title: "Standalone Launch", status: "up-next", tags: ["marketing"], boardRank: 1 }),
];

test("searches owned Items and retains Group context in deterministic order", () => {
  const result = queryWorkItems(items, { search: "panel" });
  assert.deepEqual(result.matches.map((entry) => entry.item.id), ["panels", "logo"]);
  assert.deepEqual(result.context.map((entry) => entry.item.id), ["mimeeq"]);
  assert.deepEqual(result.visible.map((entry) => [entry.item.id, entry.kind]), [
    ["mimeeq", "context"],
    ["panels", "match"],
    ["logo", "match"],
  ]);
  assert.deepEqual(result.visible.at(-1)?.ancestry.map((entry) => entry.id), ["mimeeq"]);
});

test("composes hierarchy, Group role, status, blocker, and tag filters", () => {
  const result = queryWorkItems(items, {
    projection: "flattened",
    hierarchyScope: "owned",
    groupRole: "item-only",
    statuses: ["pending"],
    blocked: "blocked",
    tags: ["editor", "visual"],
  });
  assert.deepEqual(result.matches.map((entry) => entry.item.id), ["logo"]);
  assert.deepEqual(result.context.map((entry) => entry.item.id), ["mimeeq"]);
  assert.equal(result.counts.pending, 1);
  assert.equal(result.wip, 0);
});

test("scopes Group queries to direct Items and leaves the supplied roadmap untouched", () => {
  const before = structuredClone(items);
  const result = queryWorkItems(items, {
    projection: "group",
    groupId: "mimeeq",
    hierarchyScope: "leaf",
  });
  assert.deepEqual(result.matches.map((entry) => entry.item.id), ["authoring", "panels", "logo"]);
  assert.deepEqual(result.context.map((entry) => entry.item.id), []);
  assert.deepEqual(items, before);
});

test("defaults each projection to its ordinary scope when no query criteria are active", () => {
  assert.deepEqual(queryWorkItems(items, { projection: "main" }).matches.map((entry) => entry.item.id), ["mimeeq", "launch"]);
  assert.deepEqual(queryWorkItems(items, { projection: "group", groupId: "mimeeq" }).matches.map((entry) => entry.item.id), ["authoring", "panels", "logo"]);
  assert.deepEqual(queryWorkItems(items, { projection: "flattened" }).matches.map((entry) => entry.item.id), ["mimeeq", "launch", "authoring", "panels", "logo"]);
});

test("rejects unknown query values instead of broadening results", () => {
  assert.throws(() => queryWorkItems(items, { statuses: ["pendng" as never] }), /Invalid status: pendng/);
  assert.throws(() => queryWorkItems(items, { groupRole: "folder" as never }), /Invalid Group role: folder/);
});

test("normalizes deprecated Programme query parameters", () => {
  assert.deepEqual(
    workItemQueryFromSearchParams(new URLSearchParams("projection=programme&programmeId=mimeeq&scope=selected-programme&programmeRole=deliverable-only")),
    {
      search: "",
      projection: "group",
      groupId: "mimeeq",
      hierarchyScope: "selected-group",
      groupRole: "item-only",
      statuses: [],
      blocked: "any",
      tags: [],
    },
  );
});
