import assert from "node:assert/strict";
import test from "node:test";
import { boardViewPreferencesKey, normalizeBoardViewPreferences, resolveBoardQueryState } from "../src/web/boardPreferences";

test("defaults the complete column cards to hidden for fresh board views", () => {
  const preferences = normalizeBoardViewPreferences();

  assert.deepEqual(preferences.collapsed, {});
  assert.equal(preferences.hiddenCards.complete, true);
  assert.equal(preferences.showArchived, false);
});

test("preserves explicit complete column card visibility preferences", () => {
  const preferences = normalizeBoardViewPreferences({
    hiddenCards: {
      complete: false,
      pending: true,
    },
    showArchived: true,
  });

  assert.equal(preferences.hiddenCards.complete, false);
  assert.equal(preferences.hiddenCards.pending, true);
  assert.equal(preferences.showArchived, true);
});

test("uses a stable board view preference key per repo id", () => {
  assert.equal(boardViewPreferencesKey("planban"), "planban:board-view:planban:v1");
});

test("persists expanded Group branches", () => {
  assert.deepEqual(normalizeBoardViewPreferences({ expandedGroupIds: ["mimeeq", "authoring"] }).expandedGroupIds, ["mimeeq", "authoring"]);
});

test("persists the selected Group Workspace", () => {
  assert.equal(normalizeBoardViewPreferences({ groupId: "mimeeq" }).groupId, "mimeeq");
  assert.equal(normalizeBoardViewPreferences().groupId, null);
});

test("migrates deprecated Programme view preferences", () => {
  const preferences = normalizeBoardViewPreferences({
    expandedProgrammeIds: ["mimeeq"],
    programmeId: "mimeeq",
  });
  assert.deepEqual(preferences.expandedGroupIds, ["mimeeq"]);
  assert.equal(preferences.groupId, "mimeeq");
});

test("persists the selected root projection", () => {
  assert.equal(normalizeBoardViewPreferences({ projection: "flattened" }).projection, "flattened");
  assert.equal(normalizeBoardViewPreferences({ projection: "unknown" as never }).projection, "main");
});

test("persists composable hierarchy filters while leaving search out of preferences", () => {
  const preferences = normalizeBoardViewPreferences({
    hierarchyScope: "owned",
    groupRole: "item-only",
    filterStatuses: ["pending", "in-progress"],
    blockedFilter: "blocked",
    filterTags: ["editor", "visual"],
  });
  assert.equal(preferences.hierarchyScope, "owned");
  assert.equal(preferences.groupRole, "item-only");
  assert.deepEqual(preferences.filterStatuses, ["pending", "in-progress"]);
  assert.equal(preferences.blockedFilter, "blocked");
  assert.deepEqual(preferences.filterTags, ["editor", "visual"]);
  assert.equal("search" in preferences, false);
});

test("treats any query-bearing URL as a complete deterministic override", () => {
  const stored = {
    hierarchyScope: "owned" as const,
    groupRole: "item-only" as const,
    filterStatuses: ["pending" as const],
    blockedFilter: "blocked" as const,
    filterTags: ["visual"],
  };
  assert.deepEqual(resolveBoardQueryState(stored, new URLSearchParams("projection=flattened&q=Panel")), {
    search: "Panel",
    hierarchyScope: "projection",
    groupRole: "any",
    statuses: [],
    blocked: "any",
    tags: [],
    error: null,
  });
  assert.deepEqual(resolveBoardQueryState(stored, new URLSearchParams()), {
    search: "",
    hierarchyScope: "owned",
    groupRole: "item-only",
    statuses: ["pending"],
    blocked: "blocked",
    tags: ["visual"],
    error: null,
  });
});

test("surfaces invalid URL filters without inheriting or broadening stored filters", () => {
  const state = resolveBoardQueryState({ filterStatuses: ["pending"] }, new URLSearchParams("status=pendng"));
  assert.match(state.error ?? "", /Invalid status: pendng/);
  assert.deepEqual(state.statuses, []);
});

test("ignores malformed persisted tags instead of failing board initialization", () => {
  const preferences = normalizeBoardViewPreferences({ filterTags: ["visual", null, 42, "  editor  "] as never });
  assert.deepEqual(preferences.filterTags, ["visual", "editor"]);
});
