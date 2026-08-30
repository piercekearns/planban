import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { ensureDemoBoard } from "../src/core/demo";
import { eventsPath, historyRoot, registryPath } from "../src/core/paths";
import { roadmapV1Schema } from "../src/core/schema";
import { queryWorkItems } from "../src/core/workItemQuery";
import { groupRollup } from "../src/web/mainBoardProjection";
import { archiveBoard, deleteBoard, duplicateBoard, listAllBoards, listBoards, restoreBoard } from "../src/core/registry";
import {
  createCard,
  createCards,
  createGroup as createGroupCore,
  deleteArchivedCard,
  historyPayload,
  initializeProject,
  loadState,
  loadHistoryState,
  moveCard,
  normalizeRoadmap,
  pathExists,
  PlanbanConflictError,
  PlanbanValidationError,
  exportFlatVersion1,
  reconstructHierarchy,
  readDoc,
  readHistoryDoc,
  reorderCards,
  restoreBoardVersion,
  restoreCardVersion,
  restoreDocVersion,
  saveRoadmap,
  setCardStatus,
  setCardParent,
  cardAncestry,
  updateCard,
  writeDoc,
} from "../src/core/storage";

function createGroup(input: Omit<Parameters<typeof createGroupCore>[0], "summary"> & { summary?: string }) {
  return createGroupCore({ ...input, summary: input.summary ?? `${input.title} objective` });
}

const repoId = "planban-storage-test";
const testRoot = join(tmpdir(), `planban-storage-${process.pid}`);
const cwd = join(testRoot, "repo");
const planbanHome = join(testRoot, "home");
const planningRoot = join(planbanHome, "repos", repoId);
const execFileAsync = promisify(execFile);
const repoRoot = resolve(".");

test.beforeEach(async () => {
  process.env.PLANBAN_HOME = planbanHome;
  await rm(cwd, { recursive: true, force: true });
  await rm(planbanHome, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true });
});

test.afterEach(() => {
  delete process.env.PLANBAN_HOME;
});

test("atomically creates multiple Items inside one Group", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "MIMEeq Capability", status: "in-progress" });
  const before = await loadState(cwd);

  const created = await createCards({
    cwd,
    titles: ["Product Authoring", "R-Logo", "Panel-Aware Interiors"],
    status: "pending",
    parentId: "mimeeq-capability",
    baseRevision: before.roadmap.revision,
    actor: "agent",
  });

  assert.equal(created.roadmap.revision, before.roadmap.revision + 1);
  assert.deepEqual(created.createdCards.map((item) => item.id), ["product-authoring", "r-logo", "panel-aware-interiors"]);
  assert.deepEqual(created.createdCards.map((item) => item.groupRank), [1, 2, 3]);
  assert.equal(created.roadmap.roadmapItems.find((item) => item.id === "mimeeq-capability")?.isGroup, true);
  const history = await historyPayload(cwd);
  assert.equal(history.entries[0]?.operation, "cards.create");
  assert.deepEqual(history.entries[0]?.affectedCards, ["product-authoring", "r-logo", "panel-aware-interiors", "mimeeq-capability"]);
});

test("exports a history-backed flat version-1 board without mutating live hierarchy", async () => {
  await initializeProject({ cwd, title: "Revival", repoId, updateAgents: false });
  await createGroup({ cwd, title: "MIMEeq", status: "in-progress" });
  await createCard({ cwd, title: "R-logo", status: "up-next", parentId: "mimeeq" });
  await writeDoc({ cwd, cardId: "r-logo", kind: "spec", markdown: "# R-logo evidence\n" });
  const before = await loadState(cwd);

  const exported = await exportFlatVersion1({ cwd, exportId: "revival-flat-v1", actor: "agent" });
  const flat = JSON.parse(await readFile(exported.roadmapPath, "utf8")) as { version: number; revision: number; roadmapItems: Array<Record<string, unknown>> };
  const recovery = JSON.parse(await readFile(exported.recoveryPath, "utf8")) as { historyVersion: number; items: Array<{ id: string; parentId: string | null }> };

  assert.equal(flat.version, 1);
  assert.equal(flat.revision, before.roadmap.revision);
  assert.deepEqual(flat.roadmapItems.map((item) => item.id), ["mimeeq", "r-logo"]);
  assert.equal(flat.roadmapItems.some((item) => "parentId" in item || "isGroup" in item), false);
  assert.deepEqual(recovery.items.map((item) => [item.id, item.parentId]), [["mimeeq", null], ["r-logo", "mimeeq"]]);
  assert.equal(recovery.historyVersion, exported.historyVersion);
  assert.equal(flat.roadmapItems.find((item) => item.id === "r-logo")?.specDoc, "documents/id-r-logo/spec.md");
  assert.equal(await readFile(join(exported.exportRoot, "documents", "id-r-logo", "spec.md"), "utf8"), "# R-logo evidence\n");
  assert.equal(await pathExists(join(exported.exportRoot, "history", "index.json")), true);
  const after = await loadState(cwd);
  assert.equal(after.roadmap.revision, before.roadmap.revision);
  assert.equal(after.roadmap.roadmapItems.find((item) => item.id === "r-logo")?.parentId, "mimeeq");
  assert.equal((await historyPayload(cwd)).entries[0]?.operation, "roadmap.export.flat-v1.snapshot");
  assert.equal(roadmapV1Schema.safeParse(before.roadmap).success, false, "an old version-1 writer must reject the live version-2 roadmap");

  const downgradedCwd = join(cwd, "downgraded-client-repo");
  await mkdir(join(downgradedCwd, ".planban"), { recursive: true });
  await writeFile(join(downgradedCwd, ".planban", "project.json"), JSON.stringify({ version: 1, repoId: "revival-flat-v1", enabled: true, storage: { kind: "local", root: exported.exportRoot } }), "utf8");
  const flatState = await loadState(downgradedCwd);
  assert.equal(flatState.roadmap.version, 1);
  assert.equal(flatState.roadmap.roadmapItems.every((item) => item.parentId === null), true);
  const recovered = await restoreBoardVersion({ cwd: downgradedCwd, version: exported.historyVersion });
  assert.equal(recovered.roadmap.version, 2);
  assert.equal(recovered.roadmap.roadmapItems.find((item) => item.id === "r-logo")?.parentId, "mimeeq");
  await assert.rejects(exportFlatVersion1({ cwd, exportId: "revival-flat-v1" }), PlanbanConflictError);
  await assert.rejects(exportFlatVersion1({ cwd, exportId: "../escape" }), PlanbanValidationError);
});

test("isolates exported documents from structural files even when a live document path collides", async () => {
  await initializeProject({ cwd, title: "Collision Proof", repoId, updateAgents: false });
  const created = await createCard({ cwd, title: "Structural Reference", status: "pending" });
  await saveRoadmap(created, {
    ...created.roadmap,
    roadmapItems: created.roadmap.roadmapItems.map((item) => ({ ...item, specDoc: "roadmap.json" })),
  }, false);

  const exported = await exportFlatVersion1({ cwd, exportId: "collision-proof" });
  const flatBytes = await readFile(exported.roadmapPath, "utf8");
  const flat = JSON.parse(flatBytes) as { version: number; roadmapItems: Array<{ specDoc: string | null }> };
  assert.equal(flat.version, 1);
  assert.equal(flat.roadmapItems[0]?.specDoc, "documents/id-structural-reference/spec.md");
  assert.equal(JSON.parse(await readFile(join(exported.exportRoot, "documents", "id-structural-reference", "spec.md"), "utf8")).version, 2);
  assert.equal(await readFile(exported.roadmapPath, "utf8"), flatBytes, "document copying must not overwrite export structure");
});

test("fails closed before export when referenced evidence is missing or unsafe", async () => {
  await initializeProject({ cwd, title: "Evidence Guard", repoId, updateAgents: false });
  const created = await createCard({ cwd, title: "Missing Evidence", status: "pending" });
  const historyBefore = await historyPayload(cwd);
  await rm(join(planningRoot, "items", "missing-evidence", "spec.md"));
  await assert.rejects(exportFlatVersion1({ cwd, exportId: "missing-evidence" }), /does not exist/u);
  assert.equal((await historyPayload(cwd)).currentVersion, historyBefore.currentVersion);

  await saveRoadmap(created, {
    ...created.roadmap,
    roadmapItems: created.roadmap.roadmapItems.map((item) => ({ ...item, specDoc: "../outside.md" })),
  }, false);
  await assert.rejects(exportFlatVersion1({ cwd, exportId: "unsafe-evidence" }), /inside the planning root/u);
  assert.equal((await historyPayload(cwd)).currentVersion, historyBefore.currentVersion);
});

test("rejects symlinked export evidence that resolves outside the planning root", async () => {
  await initializeProject({ cwd, title: "Symlink Guard", repoId, updateAgents: false });
  await createCard({ cwd, title: "Linked Evidence", status: "pending" });
  const externalPath = join(cwd, "external-secret.md");
  const sourcePath = join(planningRoot, "items", "linked-evidence", "spec.md");
  await writeFile(externalPath, "must not be exported\n", "utf8");
  await rm(sourcePath);
  await symlink(externalPath, sourcePath);
  const historyBefore = await historyPayload(cwd);

  await assert.rejects(exportFlatVersion1({ cwd, exportId: "symlink-evidence" }), /resolves outside the planning root/u);
  assert.equal((await historyPayload(cwd)).currentVersion, historyBefore.currentVersion);
  assert.equal(await pathExists(join(planningRoot, "exports", "symlink-evidence")), false);
});

test("rejects imported card ids whose history document paths would collide", async () => {
  await initializeProject({ cwd, title: "Imported IDs", repoId, updateAgents: false });
  let state = await createCard({ cwd, title: "First Imported", status: "pending" });
  state = await createCard({ cwd, title: "Second Imported", status: "pending" });
  await saveRoadmap(state, {
    ...state.roadmap,
    roadmapItems: state.roadmap.roadmapItems.map((item, index) => ({ ...item, id: index === 0 ? "a b" : "a-b" })),
  }, false);
  const historyBefore = await historyPayload(cwd);
  await assert.rejects(exportFlatVersion1({ cwd, exportId: "colliding-ids" }), /collide after safe path encoding/u);
  assert.equal((await historyPayload(cwd)).currentVersion, historyBefore.currentVersion);
});

test("encodes imported card ids injectively in export document paths", async () => {
  await initializeProject({ cwd, title: "Imported Path IDs", repoId, updateAgents: false });
  let state = await createCard({ cwd, title: "Traversal Shaped", status: "pending" });
  state = await createCard({ cwd, title: "Plain A", status: "pending" });
  await writeDoc({ cwd, cardId: "traversal-shaped", kind: "spec", markdown: "first evidence\n" });
  await writeDoc({ cwd, cardId: "plain-a", kind: "spec", markdown: "second evidence\n" });
  state = await loadState(cwd);
  await saveRoadmap(state, {
    ...state.roadmap,
    roadmapItems: state.roadmap.roadmapItems.map((item, index) => ({ ...item, id: index === 0 ? "x/../a" : "a" })),
  }, false);

  const exported = await exportFlatVersion1({ cwd, exportId: "encoded-ids" });
  const flat = JSON.parse(await readFile(exported.roadmapPath, "utf8")) as { roadmapItems: Array<{ id: string; specDoc: string }> };
  assert.deepEqual(flat.roadmapItems.map((item) => [item.id, item.specDoc]), [
    ["x/../a", "documents/id-x%2F..%2Fa/spec.md"],
    ["a", "documents/id-a/spec.md"],
  ]);
  assert.equal(await readFile(join(exported.exportRoot, flat.roadmapItems[0]!.specDoc), "utf8"), "first evidence\n");
  assert.equal(await readFile(join(exported.exportRoot, flat.roadmapItems[1]!.specDoc), "utf8"), "second evidence\n");
});

test("atomically reconstructs the Revival hierarchy without identity, status, document, blocker, or history churn", async () => {
  await initializeProject({ cwd, title: "Revival", repoId, updateAgents: false });
  const fixture = [
    ["MIMEeq Capability & Product Authoring Group", "in-progress"],
    ["MIMEeq Panel-Aware White Garment Interiors", "in-progress"],
    ["MIMEeq Static Sublimated Rashguard Inner Label", "archived"],
    ["MIMEeq R-Logo Mesh Resizing and Authoring", "complete"],
    ["Mimeeq Dashboard Capability Discovery", "archived"],
    ["MIMEeq Uploaded Artwork Colour Fidelity", "archived"],
    ["MIMEeq Uploaded Artwork Lighting & Shadow Parity", "archived"],
    ["MIMEeq Uploaded Artwork Edge Contour", "archived"],
  ] as const;
  for (const [title, status] of fixture) {
    if (title === "MIMEeq Capability & Product Authoring Group") await createGroup({ cwd, title, status });
    else await createCard({ cwd, title, status });
  }
  const innerLabelId = "mimeeq-static-sublimated-rashguard-inner-label";
  const withCards = await loadState(cwd);
  for (const item of withCards.roadmap.roadmapItems) {
    await writeDoc({ cwd, cardId: item.id, kind: "spec", markdown: `# ${item.title}\n\nCanonical spec evidence for ${item.id}.\n` });
    if (item.id !== innerLabelId) await writeDoc({ cwd, cardId: item.id, kind: "plan", markdown: `# ${item.title} plan\n\nCanonical plan evidence for ${item.id}.\n` });
  }
  const before = await loadState(cwd);
  const beforeHistory = await historyPayload(cwd);
  const evidence = new Map(await Promise.all(before.roadmap.roadmapItems.map(async (item) => [item.id, {
    status: item.status,
    specDoc: item.specDoc,
    planDoc: item.planDoc,
    blockedBy: item.blockedBy,
    specBytes: (await readDoc({ cwd, cardId: item.id, kind: "spec" })).markdown,
    planBytes: item.planDoc ? (await readDoc({ cwd, cardId: item.id, kind: "plan" })).markdown : null,
  }] as const)));
  const rootId = "mimeeq-capability-product-authoring-group";
  const panelId = "mimeeq-panel-aware-white-garment-interiors";

  const reconstructed = await reconstructHierarchy({
    cwd,
    groups: [
      { id: rootId, childIds: [
        panelId,
        innerLabelId,
        "mimeeq-r-logo-mesh-resizing-and-authoring",
        "mimeeq-dashboard-capability-discovery",
        "mimeeq-uploaded-artwork-colour-fidelity",
        "mimeeq-uploaded-artwork-lighting-shadow-parity",
        "mimeeq-uploaded-artwork-edge-contour",
      ] },
    ],
    baseRevision: before.roadmap.revision,
    actor: "agent",
  });

  assert.equal(reconstructed.roadmap.revision, before.roadmap.revision + 1);
  assert.deepEqual(Object.fromEntries(reconstructed.roadmap.roadmapItems.map((item) => [item.id, item.parentId])), {
    [rootId]: null,
    [panelId]: rootId,
    [innerLabelId]: rootId,
    "mimeeq-r-logo-mesh-resizing-and-authoring": rootId,
    "mimeeq-dashboard-capability-discovery": rootId,
    "mimeeq-uploaded-artwork-colour-fidelity": rootId,
    "mimeeq-uploaded-artwork-lighting-shadow-parity": rootId,
    "mimeeq-uploaded-artwork-edge-contour": rootId,
  });
  assert.equal(reconstructed.roadmap.roadmapItems.find((item) => item.id === rootId)?.isGroup, true);
  assert.equal(reconstructed.roadmap.roadmapItems.find((item) => item.id === panelId)?.isGroup, false);
  for (const item of reconstructed.roadmap.roadmapItems) {
    const retained = evidence.get(item.id)!;
    assert.deepEqual({ status: item.status, specDoc: item.specDoc, planDoc: item.planDoc, blockedBy: item.blockedBy }, {
      status: retained.status, specDoc: retained.specDoc, planDoc: retained.planDoc, blockedBy: retained.blockedBy,
    });
    assert.equal((await readDoc({ cwd, cardId: item.id, kind: "spec" })).markdown, retained.specBytes);
    if (retained.planDoc) assert.equal((await readDoc({ cwd, cardId: item.id, kind: "plan" })).markdown, retained.planBytes);
  }
  const afterHistory = await historyPayload(cwd);
  assert.equal(afterHistory.entries[0]?.operation, "hierarchy.reconstruct");
  assert.equal(afterHistory.currentVersion, beforeHistory.currentVersion + 1);
  assert.deepEqual(afterHistory.entries.slice(1), beforeHistory.entries, "reconstruction must append one event without replacing prior evidence");
});

test("keeps the three-Group eight-card regression coherent across ranks, Rollups, search, reparent, and lifecycle", async () => {
  await initializeProject({ cwd, title: "Three Groups", repoId, updateAgents: false });
  for (const [title, status] of [["Group A", "in-progress"], ["Group B", "in-progress"], ["Group C", "pending"], ["Panel Proof", "pending"], ["Authoring", "pending"], ["Labels", "up-next"], ["Colour", "up-next"], ["Release", "pending"]] as const) {
    if (title.startsWith("Group ")) await createGroup({ cwd, title, status });
    else await createCard({ cwd, title, status });
  }
  const flat = await loadState(cwd);
  await assert.rejects(reconstructHierarchy({ cwd, groups: [{ id: "group-a", childIds: ["panel-proof"] }] }), /baseRevision is required/u);
  const reconstructed = await reconstructHierarchy({
    cwd,
    groups: [
      { id: "group-a", childIds: ["panel-proof", "authoring"] },
      { id: "group-b", childIds: ["labels", "colour"] },
      { id: "group-c", childIds: ["release"] },
    ],
    baseRevision: flat.roadmap.revision,
  });
  assert.equal(reconstructed.roadmap.roadmapItems.length, 8);
  assert.deepEqual(reconstructed.roadmap.roadmapItems.filter((item) => item.parentId === null && item.status === "in-progress").map((item) => item.boardRank), [1, 2]);
  assert.deepEqual(reconstructed.roadmap.roadmapItems.filter((item) => item.parentId === "group-a" && item.status === "pending").map((item) => item.groupRank), [1, 2]);
  assert.deepEqual(groupRollup(reconstructed.roadmap.roadmapItems, "group-a").statusMix, { pending: 2 });
  assert.equal(groupRollup(reconstructed.roadmap.roadmapItems, "group-a").total, 2);
  const searched = queryWorkItems(reconstructed.roadmap.roadmapItems, { search: "panel", projection: "main" });
  assert.deepEqual(searched.matches.map((entry) => entry.item.id), ["panel-proof"]);
  assert.deepEqual(searched.context.map((entry) => entry.item.id), ["group-a"]);

  const moved = await moveCard({ cwd, cardId: "panel-proof", parentId: "group-b", baseRevision: reconstructed.roadmap.revision });
  assert.equal(moved.roadmap.roadmapItems.find((item) => item.id === "panel-proof")?.parentId, "group-b");
  assert.deepEqual(groupRollup(moved.roadmap.roadmapItems, "group-a").statusMix, { pending: 1 });
  assert.equal(groupRollup(moved.roadmap.roadmapItems, "group-a").total, 1);
  assert.deepEqual(groupRollup(moved.roadmap.roadmapItems, "group-b").statusMix, { pending: 1, "up-next": 2 });
  assert.equal(groupRollup(moved.roadmap.roadmapItems, "group-b").total, 3);
  assert.deepEqual(moved.roadmap.roadmapItems.filter((item) => item.parentId === "group-b" && item.status === "up-next").map((item) => item.groupRank), [1, 2]);
  await assert.rejects(moveCard({ cwd, cardId: "group-b", status: "complete", baseRevision: moved.roadmap.revision }), /Item/iu);
});

test("rolls back every batch-created card and document when a later spec write fails", async () => {
  const initial = await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  const historyBefore = await historyPayload(cwd);
  const orphanSpec = join(planningRoot, "items", "first", "spec.md");
  await mkdir(join(planningRoot, "items", "first"), { recursive: true });
  await writeFile(orphanSpec, "orphan content\n", "utf8");
  const eventsBefore = await readFile(eventsPath(planningRoot), "utf8").catch(() => "");
  let writes = 0;

  await assert.rejects(
    createCards({
      cwd,
      titles: ["First", "Second"],
      baseRevision: initial.roadmap.revision,
      writeSpecFile: async (path, markdown) => {
        writes += 1;
        if (writes === 2) throw new Error("injected second spec failure");
        await writeFile(path, markdown, "utf8");
      },
    }),
    /injected second spec failure/i,
  );

  const after = await loadState(cwd);
  assert.equal(after.roadmap.revision, initial.roadmap.revision);
  assert.deepEqual(after.roadmap.roadmapItems, initial.roadmap.roadmapItems);
  assert.equal(await pathExists(join(planningRoot, "items", "first-2")), false);
  assert.equal(await readFile(orphanSpec, "utf8"), "orphan content\n");
  assert.equal(await readFile(eventsPath(planningRoot), "utf8").catch(() => ""), eventsBefore);
  assert.equal((await historyPayload(cwd)).currentVersion, historyBefore.currentVersion);
});

test("blocks Group completion and archive while Items remain open without cascading", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "MIMEeq Capability", status: "in-progress" });
  await createCard({
    cwd,
    title: "Product Authoring",
    status: "up-next",
    parentId: "mimeeq-capability",
  });

  await assert.rejects(
    setCardStatus(cwd, "mimeeq-capability", "complete"),
    /Item.*Product Authoring/i,
  );
  await assert.rejects(
    setCardStatus(cwd, "mimeeq-capability", "archived"),
    /Item.*Product Authoring/i,
  );

  const unchanged = await loadState(cwd);
  assert.equal(unchanged.roadmap.roadmapItems.find((item) => item.id === "mimeeq-capability")?.status, "in-progress");
  assert.equal(unchanged.roadmap.roadmapItems.find((item) => item.id === "product-authoring")?.status, "up-next");
});

test("blocks reorder from moving a Group past an open Item", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "MIMEeq Capability", status: "in-progress" });
  await createCard({ cwd, title: "Product Authoring", status: "pending", parentId: "mimeeq-capability" });
  const before = await loadState(cwd);
  await assert.rejects(reorderCards({
    cwd,
    items: before.roadmap.roadmapItems.map((item) => ({
      id: item.id,
      status: item.id === "mimeeq-capability" ? "complete" : item.status,
    })),
  }), /Item.*Product Authoring/i);
});

test("rejects creating or reparenting open work beneath a closed Group", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "Closed Group", status: "complete" });
  await createCard({ cwd, title: "Standalone", status: "pending" });

  await assert.rejects(
    createCard({ cwd, title: "New Open Child", status: "pending", parentId: "closed-group" }),
    /Item.*New Open Child/i,
  );
  await assert.rejects(
    setCardParent({ cwd, cardId: "standalone", parentId: "closed-group" }),
    /Item.*Standalone/i,
  );
});

test("rejects history restore that would close a Group over an open Item", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "MIMEeq Capability", status: "pending" });
  await setCardStatus(cwd, "mimeeq-capability", "complete");
  const closedVersion = (await historyPayload(cwd)).currentVersion;
  await setCardStatus(cwd, "mimeeq-capability", "in-progress");
  await createCard({ cwd, title: "Product Authoring", status: "pending", parentId: "mimeeq-capability" });

  await assert.rejects(
    restoreCardVersion({ cwd, version: closedVersion, cardId: "mimeeq-capability" }),
    /Item.*Product Authoring/i,
  );
});

test("initializes repo protocol files and device-local state", async () => {
  const state = await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });

  assert.equal(state.manifest.repoId, repoId);
  assert.equal(state.roadmap.project.title, "Storage Test");
  assert.equal(state.roadmap.roadmapItems.length, 0);
  assert.equal(state.roadmap.version, 2);
  assert.equal(JSON.parse(await readFile(join(cwd, ".planban", "project.json"), "utf8")).repoId, repoId);
  assert.equal(JSON.parse(await readFile(join(planningRoot, "roadmap.json"), "utf8")).project.title, "Storage Test");
  assert.equal(JSON.parse(await readFile(registryPath(), "utf8")).boards[0].repoId, repoId);
});

test("loads version-1 boards as flat roots without rewriting the roadmap", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  const roadmapFile = join(planningRoot, "roadmap.json");
  const versionOneRoadmap = {
    version: 1,
    revision: 7,
    updatedAt: "2026-08-25T00:00:00.000Z",
    project: {
      id: repoId,
      title: "Storage Test",
      status: "active",
      description: "",
      tags: [],
    },
    columns: [],
    roadmapItems: [{
      id: "legacy-root",
      title: "Legacy Root",
      status: "pending",
      priority: 1,
    }],
  };
  await writeFile(roadmapFile, JSON.stringify(versionOneRoadmap, null, 2) + "\n", "utf8");

  const state = await loadState(cwd);

  assert.equal(state.roadmap.version, 1);
  assert.equal(state.roadmap.roadmapItems[0]?.isGroup, false);
  assert.equal(state.roadmap.roadmapItems[0]?.parentId, null);
  assert.equal(state.roadmap.roadmapItems[0]?.boardRank, 1);
  assert.deepEqual(JSON.parse(await readFile(roadmapFile, "utf8")), versionOneRoadmap);
});

test("loads recoverable legacy fields and removes them on the next writer upgrade", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  const roadmapFile = join(planningRoot, "roadmap.json");
  const legacyRoadmap = {
    version: 2,
    writerVersion: 3,
    revision: 3,
    updatedAt: "2026-08-30T00:00:00.000Z",
    project: { id: repoId, title: "Storage Test", status: "active", description: "", tags: [] },
    columns: [],
    roadmapItems: [
      {
        id: "legacy-item", title: "Legacy Item", status: "pending", priority: 2,
        summary: null, nextAction: null, tags: [], icon: null, blockedBy: null,
        specDoc: null, planDoc: null, completedAt: null, reviewState: null, updatedAt: null,
        isProgramme: false, parentId: null, boardRank: 2, programmeRank: null,
      },
      {
        id: "legacy-peer", title: "Legacy Peer", status: "pending", priority: 3,
        summary: null, nextAction: null, tags: [], icon: null, blockedBy: null,
        specDoc: null, planDoc: null, completedAt: null, reviewState: "not-ready", updatedAt: null,
        isProgramme: false, parentId: null, boardRank: 2, programmeRank: null,
      },
    ],
  };
  await writeFile(roadmapFile, JSON.stringify(legacyRoadmap, null, 2) + "\n", "utf8");

  const loaded = await loadState(cwd);
  assert.equal(loaded.roadmap.writerVersion, 3);
  assert.equal(loaded.roadmap.roadmapItems[0]?.id, "legacy-item");
  assert.deepEqual(loaded.roadmap.roadmapItems.map((item) => item.boardRank), [1, 2]);
  assert.deepEqual(JSON.parse(await readFile(roadmapFile, "utf8")), legacyRoadmap);

  const updated = await updateCard({ cwd, cardId: "legacy-item", summary: "Recovered legacy Item" });
  const persisted = JSON.parse(await readFile(roadmapFile, "utf8"));
  assert.equal(updated.roadmap.writerVersion, 6);
  assert.equal(persisted.writerVersion, 6);
  assert.equal("reviewState" in persisted.roadmapItems[0], false);
});

test("loads writer-5 Programme fields and rewrites them as writer-6 Group fields on mutation", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  const roadmapFile = join(planningRoot, "roadmap.json");
  const legacyRoadmap = {
    version: 2,
    writerVersion: 5,
    revision: 3,
    updatedAt: "2026-08-29T00:00:00.000Z",
    project: { id: repoId, title: "Storage Test", status: "active", description: "", tags: [] },
    columns: [],
    roadmapItems: [
      {
        id: "legacy-programme", title: "Legacy Programme", status: "in-progress", priority: 1,
        summary: "Legacy objective", nextAction: null, tags: [], icon: null, blockedBy: null,
        specDoc: null, planDoc: null, completedAt: null, updatedAt: null,
        isProgramme: true, parentId: null, boardRank: 1, programmeRank: null,
      },
      {
        id: "legacy-deliverable", title: "Legacy Deliverable", status: "pending", priority: 1,
        summary: null, nextAction: null, tags: [], icon: null, blockedBy: null,
        specDoc: null, planDoc: null, completedAt: null, updatedAt: null,
        isProgramme: false, parentId: "legacy-programme", boardRank: null, programmeRank: 1,
      },
    ],
  };
  await writeFile(roadmapFile, JSON.stringify(legacyRoadmap, null, 2) + "\n", "utf8");
  await rm(historyRoot(planningRoot), { recursive: true, force: true });

  const loaded = await loadState(cwd);
  assert.equal(loaded.roadmap.writerVersion, 5);
  assert.equal(loaded.roadmap.roadmapItems[0]?.isGroup, true);
  assert.equal(loaded.roadmap.roadmapItems[1]?.groupRank, 1);

  const updated = await updateCard({ cwd, cardId: "legacy-deliverable", summary: "Current language" });
  const persisted = JSON.parse(await readFile(roadmapFile, "utf8"));
  assert.equal(updated.roadmap.writerVersion, 6);
  assert.equal(persisted.writerVersion, 6);
  assert.equal(persisted.roadmapItems[0].isGroup, true);
  assert.equal(persisted.roadmapItems[1].groupRank, 1);
  assert.equal("isProgramme" in persisted.roadmapItems[0], false);
  assert.equal("programmeRank" in persisted.roadmapItems[1], false);

  const legacyHistory = await loadHistoryState({ cwd, version: 1 });
  assert.equal(legacyHistory.roadmap.roadmapItems[0]?.isGroup, true);
  assert.equal(legacyHistory.roadmap.roadmapItems[1]?.groupRank, 1);
});

test("atomically upgrades a version-1 board when creating an empty Group", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  const created = await createCard({ cwd, title: "Alpha", status: "pending" });
  const roadmapFile = join(planningRoot, "roadmap.json");
  const legacyRoadmap = JSON.parse(await readFile(roadmapFile, "utf8"));
  legacyRoadmap.version = 1;
  delete legacyRoadmap.writerVersion;
  for (const item of legacyRoadmap.roadmapItems) delete item.isGroup;
  await writeFile(roadmapFile, JSON.stringify(legacyRoadmap, null, 2) + "\n", "utf8");

  const promoted = await createGroup({
    cwd,
    title: "New Group",
    baseRevision: created.roadmap.revision,
    actor: "agent",
  });

  assert.equal(promoted.roadmap.version, 2);
  assert.equal(promoted.roadmap.writerVersion, 6);
  assert.equal(roadmapV1Schema.safeParse(promoted.roadmap).success, false);
  assert.equal(promoted.createdGroup.isGroup, true);
  assert.equal(promoted.roadmap.roadmapItems.find((item) => item.id === "alpha")?.isGroup, false);
  assert.equal(JSON.parse(await readFile(roadmapFile, "utf8")).version, 2);
  assert.equal((await historyPayload(cwd)).entries[0]?.operation, "group.create");

  await assert.rejects(
    createGroup({
      cwd,
      title: "Stale Group",
      baseRevision: created.roadmap.revision,
    }),
    PlanbanConflictError,
  );

  assert.throws(
    () => normalizeRoadmap({ ...promoted.roadmap, writerVersion: 7 }),
    /writerVersion/u,
  );
  const incompleteWriterTwo = structuredClone(promoted.roadmap);
  delete (incompleteWriterTwo.roadmapItems[0] as Partial<(typeof incompleteWriterTwo.roadmapItems)[number]>).parentId;
  assert.throws(() => normalizeRoadmap(incompleteWriterTwo), /parentId/u);
});

test("upgrades a version-1 board on an ordinary first mutation", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  const roadmapFile = join(planningRoot, "roadmap.json");
  const legacyRoadmap = JSON.parse(await readFile(roadmapFile, "utf8"));
  legacyRoadmap.version = 1;
  delete legacyRoadmap.writerVersion;
  for (const item of legacyRoadmap.roadmapItems) delete item.isGroup;
  await writeFile(roadmapFile, JSON.stringify(legacyRoadmap, null, 2) + "\n", "utf8");

  const updated = await updateCard({ cwd, cardId: "alpha", summary: "Ordinary mutation" });

  assert.equal(updated.roadmap.version, 2);
  assert.equal(updated.roadmap.writerVersion, 6);
  assert.equal(updated.roadmap.roadmapItems[0]?.isGroup, false);
});

test("normalizes legacy ranks and rejects malformed current rank scopes", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  await createCard({ cwd, title: "Beta", status: "pending" });
  const roadmapFile = join(planningRoot, "roadmap.json");
  const legacy = JSON.parse(await readFile(roadmapFile, "utf8"));
  legacy.version = 1;
  delete legacy.writerVersion;
  for (const item of legacy.roadmapItems) {
    item.priority = null;
    delete item.isGroup;
    delete item.parentId;
    delete item.boardRank;
    delete item.groupRank;
  }
  await writeFile(roadmapFile, JSON.stringify(legacy, null, 2) + "\n", "utf8");
  const loaded = await loadState(cwd);
  assert.deepEqual(loaded.roadmap.roadmapItems.map((item) => item.boardRank), [1, 2]);
  const upgraded = await updateCard({ cwd, cardId: "alpha", summary: "upgrade" });
  assert.deepEqual(upgraded.roadmap.roadmapItems.map((item) => item.boardRank), [1, 2]);

  const malformed = structuredClone(upgraded.roadmap);
  malformed.roadmapItems[1]!.boardRank = 1;
  assert.throws(() => normalizeRoadmap(malformed), /unique and contiguous/i);
  malformed.roadmapItems[1]!.boardRank = null;
  malformed.roadmapItems[1]!.groupRank = 2;
  assert.throws(() => normalizeRoadmap(malformed), /Board Rank/i);

  const blankParent = structuredClone(upgraded.roadmap);
  blankParent.roadmapItems[0]!.parentId = "";
  assert.throws(() => normalizeRoadmap(blankParent), /parentId/i);
  const duplicateId = structuredClone(upgraded.roadmap);
  duplicateId.roadmapItems[1]!.id = duplicateId.roadmapItems[0]!.id;
  assert.throws(() => normalizeRoadmap(duplicateId), /unique/i);
});

test("creates an idempotent demo board with tutorial cards", async () => {
  const demo = await ensureDemoBoard();

  assert.equal(demo.manifest.repoId, "planban-demo");
  assert.equal(demo.roadmap.project.title, "Planban Demo");
  assert.deepEqual(
    demo.roadmap.roadmapItems.map((item) => [item.title, item.status]),
    [
      ["Drag this card to In Progress", "up-next"],
      ["Open this roadmap item in Codex", "up-next"],
      ["Mark a card Complete when you are done", "in-progress"],
      ["Send feedback from the toolbar", "pending"],
      ["Ask Codex to create roadmap items from your plans", "pending"],
    ],
  );
  const codexCard = demo.roadmap.roadmapItems.find((item) => item.id === "open-this-roadmap-item-in-codex");
  assert.equal(codexCard?.metadata?.demoCodexPrompt, true);

  const spec = await readDoc({
    cwd: demo.cwd,
    cardId: "ask-codex-to-create-roadmap-items-from-your-plans",
    kind: "spec",
  });
  assert.match(spec.markdown, /Notion, Jira, Linear/);

  const feedbackSpec = await readDoc({
    cwd: demo.cwd,
    cardId: "send-feedback-from-the-toolbar",
    kind: "spec",
  });
  assert.match(feedbackSpec.markdown, /feedback button in the board toolbar/);

  const second = await ensureDemoBoard();
  assert.equal(second.roadmap.roadmapItems.length, 5);
  assert.equal((await listAllBoards()).find((board) => board.repoId === "planban-demo")?.kind, "demo");
});

test("archives, restores, and deletes whole boards with a backup", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });

  const archived = await archiveBoard(repoId);
  assert.equal(archived.archivedAt !== null, true);
  assert.deepEqual(await listBoards(), []);
  assert.equal((await listAllBoards()).find((board) => board.repoId === repoId)?.archivedAt, archived.archivedAt);

  const restored = await restoreBoard(repoId);
  assert.equal(restored.archivedAt, null);
  assert.equal((await listBoards()).map((board) => board.repoId)[0], repoId);

  const deleted = await deleteBoard(repoId);
  assert.equal(deleted.repoId, repoId);
  assert.equal(typeof deleted.backupPath, "string");
  assert.equal((await listAllBoards()).find((board) => board.repoId === repoId), undefined);
  await assert.rejects(stat(planningRoot));
  assert.equal(JSON.parse(await readFile(join(deleted.backupPath!, "roadmap.json"), "utf8")).project.title, "Storage Test");
});

test("duplicates whole boards into independent local planning state", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({
    cwd,
    title: "Alpha",
    status: "up-next",
    summary: "Copied summary",
    specMarkdown: "# Alpha Spec\n\nCopied spec.\n",
  });

  const duplicated = await duplicateBoard({
    sourceRepoId: repoId,
    repoId: "planban-storage-test-copy",
    title: "Storage Test Copy",
  });

  assert.equal(duplicated.source.repoId, repoId);
  assert.equal(duplicated.board.repoId, "planban-storage-test-copy");
  assert.equal(basename(duplicated.board.cwd), "planban-storage-test-copy");
  assert.equal(basename(dirname(duplicated.board.cwd)), "detached");
  assert.equal((await listAllBoards()).some((board) => board.repoId === duplicated.board.repoId), true);

  const duplicateState = await loadState(duplicated.board.cwd);
  assert.equal(duplicateState.roadmap.project.id, "planban-storage-test-copy");
  assert.equal(duplicateState.roadmap.project.title, "Storage Test Copy");
  assert.deepEqual(
    duplicateState.roadmap.roadmapItems.map((item) => [item.id, item.title, item.summary]),
    [["alpha", "Alpha", "Copied summary"]],
  );
  assert.equal((await readDoc({ cwd: duplicated.board.cwd, cardId: "alpha", kind: "spec" })).markdown, "# Alpha Spec\n\nCopied spec.\n");

  const duplicateHistory = await historyPayload(duplicated.board.cwd);
  assert.equal(duplicateHistory.entries[0]?.operation, "board.duplicate");

  await createCard({ cwd: duplicated.board.cwd, title: "Only On Copy", status: "pending" });
  assert.equal((await loadState(cwd)).roadmap.roadmapItems.some((item) => item.id === "only-on-copy"), false);
});

test("upgrades a duplicated version-1 board to the current writer capability", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  const roadmapFile = join(planningRoot, "roadmap.json");
  const legacyRoadmap = JSON.parse(await readFile(roadmapFile, "utf8"));
  legacyRoadmap.version = 1;
  delete legacyRoadmap.writerVersion;
  for (const item of legacyRoadmap.roadmapItems) delete item.isGroup;
  await writeFile(roadmapFile, JSON.stringify(legacyRoadmap, null, 2) + "\n", "utf8");

  const duplicated = await duplicateBoard({
    sourceRepoId: repoId,
    repoId: "planban-storage-v1-copy",
  });
  const duplicateState = await loadState(duplicated.board.cwd);

  assert.equal(duplicateState.roadmap.version, 2);
  assert.equal(duplicateState.roadmap.writerVersion, 6);
  assert.equal(duplicateState.roadmap.roadmapItems[0]?.isGroup, false);
});

test("refuses to duplicate a writer-2 board with invalid hierarchy", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  const roadmapFile = join(planningRoot, "roadmap.json");
  const malformed = JSON.parse(await readFile(roadmapFile, "utf8"));
  malformed.roadmapItems[0].parentId = "missing-parent";
  malformed.roadmapItems[0].boardRank = null;
  malformed.roadmapItems[0].groupRank = 1;
  await writeFile(roadmapFile, JSON.stringify(malformed, null, 2) + "\n", "utf8");

  await assert.rejects(duplicateBoard({ sourceRepoId: repoId, repoId: "malformed-copy" }), /Parent not found/i);
  assert.equal(await pathExists(join(planbanHome, "repos", "malformed-copy")), false);
});

test("creates cards with linked docs and persists exact reorder", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({
    cwd,
    title: "Alpha",
    status: "pending",
    summary: "Alpha is ready for implementation.",
    nextAction: "Implement Alpha, then stop for review.",
  });
  const state = await createCard({ cwd, title: "Beta", status: "up-next" });

  const reordered = await reorderCards({
    cwd,
    baseRevision: state.roadmap.revision,
    items: [
      { id: "beta", status: "pending" },
      { id: "alpha", status: "up-next" },
    ],
  });

  assert.deepEqual(
    reordered.roadmap.roadmapItems.map((item) => [item.id, item.status, item.priority]),
    [
      ["alpha", "up-next", 1],
      ["beta", "pending", 1],
    ],
  );

  const spec = await readDoc({ cwd, cardId: "alpha", kind: "spec" });
  assert.equal(spec.exists, true);
  assert.match(spec.markdown, /# Alpha Spec/);
  assert.match(spec.markdown, /## Purpose/u);
  assert.match(spec.markdown, /## Target outcome/u);
  assert.match(spec.markdown, /## Current state/u);
  assert.match(spec.markdown, /## Agent reference/u);
  assert.doesNotMatch(spec.markdown, /Alpha is ready for implementation/u);
  assert.doesNotMatch(spec.markdown, /Implement Alpha, then stop for review/u);

  const plan = await readDoc({ cwd, cardId: "alpha", kind: "plan" });
  assert.equal(plan.exists, false);
  assert.equal(plan.path, null);
});

test("creates an owned Item only inside an existing Group and exposes ownership", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  const parent = await createGroup({ cwd, title: "MIMEeq Capability", status: "in-progress" });
  const child = await createCard({
    cwd,
    title: "Product Authoring",
    status: "up-next",
    parentId: parent.createdGroup.id,
  });

  const parentItem = child.roadmap.roadmapItems.find((item) => item.id === parent.createdGroup.id);
  const childItem = child.roadmap.roadmapItems.find((item) => item.id === child.createdCard.id);
  assert.equal(child.roadmap.writerVersion, 6);
  assert.equal(parentItem?.isGroup, true);
  assert.equal(parentItem?.parentId, null);
  assert.equal(parentItem?.boardRank, 1);
  assert.equal(childItem?.parentId, parent.createdGroup.id);
  assert.equal(childItem?.boardRank, null);
  assert.equal(childItem?.groupRank, 1);
  assert.deepEqual(cardAncestry(child.roadmap, child.createdCard.id).map((item) => item.id), [parent.createdGroup.id]);
  assert.deepEqual((await historyPayload(cwd)).entries[0]?.affectedCards, [child.createdCard.id, parent.createdGroup.id]);
  await assert.rejects(createCard({ cwd, title: "Stale Child", parentId: parent.createdGroup.id, baseRevision: parent.roadmap.revision }), PlanbanConflictError);
});

test("rejects treating an Item as an existing Group destination", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Destination", status: "pending" });
  await createCard({ cwd, title: "Moving", status: "pending" });

  await assert.rejects(createCard({ cwd, title: "Nested", parentId: "destination" }), /destination must be an existing Group/iu);
  await assert.rejects(createCards({ cwd, titles: ["Nested A", "Nested B"], parentId: "destination" }), /destination must be an existing Group/iu);
  await assert.rejects(moveCard({ cwd, cardId: "moving", parentId: "destination" }), /destination must be an existing Group/iu);
});

test("creates a Group without requiring its objective up front", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  const created = await createGroupCore({ cwd, title: "Objective Later" });

  assert.equal(created.createdGroup.summary, null);
  const spec = (await readDoc({ cwd, cardId: created.createdGroup.id, kind: "spec" })).markdown;
  assert.match(spec, /## Purpose/u);
  assert.match(spec, /## Current state/u);
  assert.doesNotMatch(spec, /## Goal/u);
  assert.doesNotMatch(spec, /## Next Action/u);
});

test("creates a distinct Group from root Items without changing their identities or documents", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Panel-Aware Interiors", status: "in-progress", summary: "Prove panel-aware behaviour", specMarkdown: "# Panel proof\n" });
  const before = await createCard({ cwd, title: "R-Logo Authoring", status: "up-next", summary: "Author the R logo", specMarkdown: "# R-logo proof\n" });

  const created = await createGroup({
    cwd,
    title: "MIMEeq Capability & Product Authoring",
    summary: "Prove the complete MIMEeq authoring capability",
    status: "in-progress",
    itemIds: ["panel-aware-interiors", "r-logo-authoring"],
    anchorId: "panel-aware-interiors",
    baseRevision: before.roadmap.revision,
    actor: "agent",
  });

  assert.equal(created.createdGroup.isGroup, true);
  assert.equal(created.createdGroup.parentId, null);
  assert.equal(created.createdGroup.summary, "Prove the complete MIMEeq authoring capability");
  assert.deepEqual(
    created.roadmap.roadmapItems.filter((item) => item.parentId === created.createdGroup.id).map((item) => [item.id, item.status, item.isGroup]),
    [
      ["panel-aware-interiors", "in-progress", false],
      ["r-logo-authoring", "up-next", false],
    ],
  );
  assert.equal((await readDoc({ cwd, cardId: "panel-aware-interiors", kind: "spec" })).markdown, "# Panel proof\n");
  assert.equal((await readDoc({ cwd, cardId: "r-logo-authoring", kind: "spec" })).markdown, "# R-logo proof\n");
  const groupSpec = (await readDoc({ cwd, cardId: created.createdGroup.id, kind: "spec" })).markdown;
  assert.match(groupSpec, /## Current state/u);
  assert.doesNotMatch(groupSpec, /Prove the complete MIMEeq authoring capability/u);
  assert.equal((await historyPayload(cwd)).entries[0]?.operation, "group.create");
  assert.deepEqual((await historyPayload(cwd)).entries[0]?.affectedCards, [created.createdGroup.id, "panel-aware-interiors", "r-logo-authoring"]);
});

test("allows only root Groups to own Items", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "Group", status: "in-progress" });
  await createCard({ cwd, title: "Owned Item", parentId: "group" });
  const prepared = await createGroup({ cwd, title: "Other Group", status: "pending" });

  await assert.rejects(
    createGroup({ cwd, title: "Nested Group", itemIds: ["owned-item"], baseRevision: prepared.roadmap.revision }),
    /already owned by a Group/iu,
  );
  await assert.rejects(
    moveCard({ cwd, cardId: "other-group", parentId: "group", baseRevision: prepared.roadmap.revision }),
    /Group cannot be placed inside another Group/iu,
  );
  await assert.rejects(
    createCard({ cwd, title: "Too Deep", parentId: "owned-item", baseRevision: prepared.roadmap.revision }),
    /owned Item cannot own another Work Item/iu,
  );

  const recursiveRoadmap = structuredClone(prepared.roadmap);
  recursiveRoadmap.roadmapItems = recursiveRoadmap.roadmapItems.map((item) => item.id === "other-group"
    ? { ...item, parentId: "group", boardRank: null, groupRank: 2 }
    : item);
  assert.throws(
    () => normalizeRoadmap(recursiveRoadmap),
    /Group other-group must remain on the Main Board/iu,
  );
});

test("places a Work Item across status, ownership, and scoped rank in one mutation", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "Group", status: "in-progress" });
  await createCard({ cwd, title: "First", status: "pending", parentId: "group" });
  await createCard({ cwd, title: "Second", status: "pending", parentId: "group" });
  const loose = await createCard({ cwd, title: "Loose", status: "up-next" });

  const placed = await moveCard({
    cwd,
    cardId: "loose",
    status: "pending",
    parentId: "group",
    afterId: "first",
    baseRevision: loose.roadmap.revision,
  });

  const group = placed.roadmap.roadmapItems.find((item) => item.id === "group");
  const children = placed.roadmap.roadmapItems
    .filter((item) => item.parentId === "group" && item.status === "pending")
    .sort((a, b) => (a.groupRank ?? 0) - (b.groupRank ?? 0));
  assert.equal(group?.isGroup, true);
  assert.deepEqual(children.map((item) => [item.id, item.groupRank]), [["first", 1], ["loose", 2], ["second", 3]]);
});

test("keeps root rank scope distinct from a Group whose id is board", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "Board", status: "pending" });
  await createCard({ cwd, title: "Root Item", status: "pending" });
  const nested = await createCard({ cwd, title: "Nested Item", status: "pending", parentId: "board" });
  assert.deepEqual(
    nested.roadmap.roadmapItems.filter((item) => item.parentId === null).map((item) => item.boardRank),
    [1, 2],
  );
  assert.equal(nested.createdCard.groupRank, 1);
});

test("reparents and detaches Items without implicit Group demotion", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "Group A", status: "in-progress" });
  await createGroup({ cwd, title: "Group B", status: "pending" });
  await createCard({ cwd, title: "Existing B Child", status: "pending", parentId: "group-b" });
  await createCard({ cwd, title: "Item", parentId: "group-a" });
  await createCard({ cwd, title: "Second Item", parentId: "group-a" });

  const moved = await setCardParent({ cwd, cardId: "item", parentId: "group-b", actor: "agent" });
  assert.equal(moved.roadmap.roadmapItems.find((item) => item.id === "item")?.parentId, "group-b");
  assert.equal(moved.roadmap.roadmapItems.find((item) => item.id === "group-a")?.isGroup, true);
  assert.equal(moved.roadmap.roadmapItems.find((item) => item.id === "second-item")?.groupRank, 1);
  assert.equal(moved.roadmap.roadmapItems.find((item) => item.id === "existing-b-child")?.groupRank, 1);
  assert.equal(moved.roadmap.roadmapItems.find((item) => item.id === "item")?.groupRank, 2);

  const detached = await setCardParent({ cwd, cardId: "item", parentId: null });
  const detachedItem = detached.roadmap.roadmapItems.find((item) => item.id === "item");
  assert.equal(detachedItem?.parentId, null);
  assert.equal(detachedItem?.groupRank, null);
  assert.equal(typeof detachedItem?.boardRank, "number");
  assert.equal((await historyPayload(cwd)).entries[0]?.operation, "card.parent.update");
  await assert.rejects(setCardParent({ cwd, cardId: "item", parentId: "group-a", baseRevision: moved.roadmap.revision }), PlanbanConflictError);
});

test("rejects invalid ownership and dependency graphs", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "Alpha" });
  await createCard({ cwd, title: "Beta", parentId: "alpha" });
  await createCard({ cwd, title: "Gamma" });

  await assert.rejects(setCardParent({ cwd, cardId: "alpha", parentId: "gamma" }), /Group cannot be placed/i);
  await assert.rejects(setCardParent({ cwd, cardId: "gamma", parentId: "beta" }), /owned Item cannot own/i);
  await assert.rejects(setCardParent({ cwd, cardId: "alpha", parentId: "missing" }), /not found/i);
  await assert.rejects(setCardParent({ cwd, cardId: "alpha", parentId: "alpha" }), /itself/i);
  await assert.rejects(updateCard({ cwd, cardId: "alpha", blockedBy: "alpha" }), /itself/i);
  await assert.rejects(updateCard({ cwd, cardId: "alpha", blockedBy: "missing" }), /not found/i);
  await updateCard({ cwd, cardId: "alpha", blockedBy: "gamma" });
  await assert.rejects(updateCard({ cwd, cardId: "gamma", blockedBy: "alpha" }), /cycle/i);
});

test("creates structured cards with placement, metadata, tags, and plan docs", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  await createCard({ cwd, title: "Beta", status: "pending" });

  const structured = await createCard({
    cwd,
    title: "Structured",
    status: "pending",
    position: "top",
    tags: [" audit ", "", "release"],
    metadata: { source: "storage-test" },
    specMarkdown: "# Structured Spec\n",
    planMarkdown: "# Structured Plan\n",
  });

  assert.deepEqual(
    structured.roadmap.roadmapItems.map((item) => [item.id, item.priority]),
    [
      ["structured", 1],
      ["alpha", 2],
      ["beta", 3],
    ],
  );
  assert.equal(structured.createdCard.id, "structured");
  assert.deepEqual(structured.createdCard.tags, ["audit", "release"]);
  assert.deepEqual(structured.createdCard.metadata, { source: "storage-test" });

  const spec = await readDoc({ cwd, cardId: "structured", kind: "spec" });
  assert.equal(spec.markdown, "# Structured Spec\n");
  const plan = await readDoc({ cwd, cardId: "structured", kind: "plan" });
  assert.equal(plan.markdown, "# Structured Plan\n");

  const history = await historyPayload(cwd);
  assert.equal(history.entries[0]?.operation, "card.create");
  assert.deepEqual(
    history.entries[0]?.affectedDocs.map((doc) => doc.kind),
    ["spec", "plan"],
  );
});

test("CLI creates structured cards with tags, metadata, placement, and doc files", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  const specFile = join(cwd, "cli-spec.md");
  const planFile = join(cwd, "cli-plan.md");
  await writeFile(specFile, "# CLI Spec\n", "utf8");
  await writeFile(planFile, "# CLI Plan\n", "utf8");

  const result = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "src/cli.ts",
      "create-card",
      "CLI Structured",
      "--cwd",
      cwd,
      "--status",
      "pending",
      "--after",
      "alpha",
      "--tag",
      "cli",
      "--metadata-json",
      '{"source":"cli"}',
      "--spec-file",
      specFile,
      "--plan-file",
      planFile,
      "--output",
      "json",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, PLANBAN_HOME: planbanHome },
    },
  );
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.createdCard.id, "cli-structured");
  assert.deepEqual(payload.createdCard.tags, ["cli"]);
  assert.deepEqual(payload.createdCard.metadata, { source: "cli" });
  assert.deepEqual(
    payload.roadmap.roadmapItems.map((item: { id: string }) => item.id),
    ["alpha", "cli-structured"],
  );

  assert.equal((await readDoc({ cwd, cardId: "cli-structured", kind: "spec" })).markdown, "# CLI Spec\n");
  assert.equal((await readDoc({ cwd, cardId: "cli-structured", kind: "plan" })).markdown, "# CLI Plan\n");
});

test("CLI creates a distinct Group from existing Items", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  await createCard({ cwd, title: "Beta", status: "up-next" });
  const result = await execFileAsync(process.execPath, [
    "--import", "tsx/esm", "src/cli.ts", "create-group", "Alpha Beta Group",
    "--item", "alpha", "--item", "beta", "--anchor", "alpha",
    "--cwd", cwd, "--output", "json",
  ], { cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome } });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.createdGroup.isGroup, true);
  assert.equal(payload.createdGroup.summary, null);
  assert.deepEqual(payload.roadmap.roadmapItems.filter((item: { parentId: string | null }) => item.parentId === payload.createdGroup.id).map((item: { id: string }) => item.id).sort(), ["alpha", "beta"]);
});

test("CLI updates and clears a Group objective", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroupCore({ cwd, title: "Objective Group", summary: undefined });
  await execFileAsync(process.execPath, [
    "--import", "tsx/esm", "src/cli.ts", "update-card", "objective-group",
    "--summary", "Coordinate the shared outcome.", "--cwd", cwd,
  ], { cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome } });
  assert.equal((await loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === "objective-group")?.summary, "Coordinate the shared outcome.");

  await execFileAsync(process.execPath, [
    "--import", "tsx/esm", "src/cli.ts", "update-card", "objective-group",
    "--clear-summary", "--cwd", cwd,
  ], { cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome } });
  assert.equal((await loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === "objective-group")?.summary, null);
});

test("CLI renames a card without changing its stable id", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Old title", status: "pending" });
  await execFileAsync(process.execPath, [
    "--import", "tsx/esm", "src/cli.ts", "update-card", "old-title",
    "--title", "New title", "--cwd", cwd,
  ], { cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome } });
  const renamed = (await loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === "old-title");
  assert.equal(renamed?.title, "New title");
  assert.equal(renamed?.id, "old-title");
});

test("CLI preserves the deprecated Programme creation command and option", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Legacy Item", status: "pending" });
  const result = await execFileAsync(process.execPath, [
    "--import", "tsx/esm", "src/cli.ts", "create-programme", "Legacy Group",
    "--summary", "Legacy compatibility", "--deliverable", "legacy-item", "--cwd", cwd, "--output", "json",
  ], { cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome } });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.createdGroup.isGroup, true);
  assert.equal(payload.roadmap.roadmapItems.find((item: { id: string }) => item.id === "legacy-item")?.parentId, "legacy-group");
});

test("CLI creates inside a parent and detaches to the main board", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "Parent" });
  await execFileAsync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", "create-card", "Child", "--cwd", cwd, "--parent", "parent"], {
    cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome },
  });
  assert.equal((await loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === "child")?.parentId, "parent");
  await execFileAsync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", "move-card", "child", "--cwd", cwd, "--board"], {
    cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome },
  });
  assert.equal((await loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === "child")?.parentId, null);
  await execFileAsync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", "move-card", "child", "--cwd", cwd, "--parent", "parent"], {
    cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome },
  });
  assert.equal((await loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === "child")?.parentId, "parent");
});

test("CLI queries hierarchy with the shared read-only contract", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "MIMEeq Capability", status: "in-progress" });
  await createCard({ cwd, title: "R-Logo", status: "pending", parentId: "mimeeq-capability", nextAction: "Validate panel render", tags: ["visual"] });
  const before = await loadState(cwd);
  const result = await execFileAsync(process.execPath, [
    "--import", "tsx/esm", "src/cli.ts", "query-cards",
    "--search", "panel", "--projection", "main", "--scope", "owned", "--tag", "visual",
    "--cwd", cwd, "--output", "json",
  ], { cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome } });
  const payload = JSON.parse(result.stdout);
  assert.deepEqual(payload.matches.map((entry: { item: { id: string } }) => entry.item.id), ["r-logo"]);
  assert.deepEqual(payload.context.map((entry: { item: { id: string } }) => entry.item.id), ["mimeeq-capability"]);
  assert.equal(payload.revision, before.roadmap.revision);
  assert.equal((await loadState(cwd)).roadmap.revision, before.roadmap.revision);
  await assert.rejects(execFileAsync(process.execPath, [
    "--import", "tsx/esm", "src/cli.ts", "query-cards", "--status", "pendng", "--cwd", cwd,
  ], { cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome } }), /Invalid status: pendng/);
});

test("CLI atomically creates multiple Group children", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createGroup({ cwd, title: "MIMEeq Capability", status: "in-progress" });
  await execFileAsync(process.execPath, [
    "--import", "tsx/esm", "src/cli.ts", "create-cards",
    "--title", "Product Authoring", "--title", "R-Logo", "--parent", "mimeeq-capability",
    "--cwd", cwd, "--output", "json",
  ], { cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome } });
  const children = (await loadState(cwd)).roadmap.roadmapItems.filter((item) => item.parentId === "mimeeq-capability");
  assert.deepEqual(children.map((item) => item.title), ["Product Authoring", "R-Logo"]);
});

test("CLI reconstructs existing hierarchy and exports flat version 1", async () => {
  await initializeProject({ cwd, title: "Revival", repoId, updateAgents: false });
  await createGroup({ cwd, title: "MIMEeq", status: "in-progress" });
  await createCard({ cwd, title: "R-logo", status: "up-next" });
  const before = await loadState(cwd);
  const mappingPath = join(cwd, "revival-hierarchy.json");
  await writeFile(mappingPath, JSON.stringify({ groups: [{ id: "mimeeq", childIds: ["r-logo"] }] }), "utf8");
  await execFileAsync(process.execPath, [
    "--import", "tsx/esm", "src/cli.ts", "reconstruct-hierarchy", "--file", mappingPath,
    "--base-revision", String(before.roadmap.revision), "--cwd", cwd, "--output", "json",
  ], { cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome } });
  assert.equal((await loadState(cwd)).roadmap.roadmapItems.find((item) => item.id === "r-logo")?.parentId, "mimeeq");
  const result = await execFileAsync(process.execPath, [
    "--import", "tsx/esm", "src/cli.ts", "export-flat-v1", "--export-id", "cli-flat-v1", "--cwd", cwd, "--output", "json",
  ], { cwd: repoRoot, env: { ...process.env, PLANBAN_HOME: planbanHome } });
  assert.equal(JSON.parse(result.stdout).exportId, "cli-flat-v1");
});

test("CLI duplicates registered boards through shared board lifecycle", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });

  const result = await execFileAsync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "src/cli.ts",
      "duplicate-board",
      repoId,
      "--repo-id",
      "planban-storage-cli-copy",
      "--title",
      "CLI Copy",
      "--output",
      "json",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, PLANBAN_HOME: planbanHome },
    },
  );
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.board.repoId, "planban-storage-cli-copy");
  assert.equal((await loadState(payload.board.cwd)).roadmap.project.title, "CLI Copy");
});

test("rejects card document paths outside the planning root", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  const created = await createCard({ cwd, title: "Alpha", status: "pending" });
  const alpha = created.roadmap.roadmapItems.find((item) => item.id === "alpha");
  assert.ok(alpha);
  const absoluteEscapePath = join(planbanHome, "planban-storage-escape.md");

  await saveRoadmap(created, {
    ...created.roadmap,
    roadmapItems: [
      {
        ...alpha,
        specDoc: "../outside.md",
        planDoc: absoluteEscapePath,
      },
    ],
  }, false);

  await assert.rejects(
    readDoc({ cwd, cardId: "alpha", kind: "spec" }),
    /inside the planning root/u,
  );
  await assert.rejects(
    writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Outside\n" }),
    /inside the planning root/u,
  );
  await assert.rejects(
    writeDoc({ cwd, cardId: "alpha", kind: "plan", markdown: "# Absolute\n" }),
    /inside the planning root/u,
  );
  await assert.rejects(stat(join(planbanHome, "repos", "outside.md")));
  await assert.rejects(stat(absoluteEscapePath));
});

test("serializes concurrent CLI create-card writes across processes", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });

  await Promise.all(Array.from({ length: 8 }, (_entry, index) =>
    execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx/esm",
        "src/cli.ts",
        "create-card",
        `Parallel ${index + 1}`,
        "--cwd",
        cwd,
        "--status",
        "pending",
        "--output",
        "json",
      ],
      {
        cwd: repoRoot,
        env: { ...process.env, PLANBAN_HOME: planbanHome },
      },
    ),
  ));

  const roadmap = JSON.parse(await readFile(join(planningRoot, "roadmap.json"), "utf8")) as {
    revision: number;
    roadmapItems: Array<{ id: string }>;
  };
  assert.equal(roadmap.roadmapItems.length, 8);
  assert.equal(new Set(roadmap.roadmapItems.map((item) => item.id)).size, 8);
  assert.equal(roadmap.revision, 9);
});

test("records board history and previews historical board versions", async () => {
  const initial = await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  let history = await historyPayload(cwd);
  assert.equal(history.currentVersion, 1);
  assert.equal(history.entries[0]?.operation, "baseline");
  assert.equal(initial.roadmap.revision, 1);

  const created = await createCard({ cwd, title: "Alpha", status: "pending" });
  history = await historyPayload(cwd);
  assert.equal(history.currentVersion, 2);
  assert.equal(history.entries[0]?.summary, "Created Alpha");

  const completed = await setCardStatus(cwd, "alpha", "complete");
  history = await historyPayload(cwd);
  assert.equal(history.currentVersion, 3);
  assert.match(history.entries[0]?.summary ?? "", /Moved Alpha to Complete/);
  assert.ok(completed.roadmap.roadmapItems.find((item) => item.id === "alpha")?.completedAt);

  const versionTwo = await loadHistoryState({ cwd, version: 2 });
  assert.equal(versionTwo.roadmap.roadmapItems[0]?.status, "pending");

  const restored = await restoreBoardVersion({ cwd, version: 2 });
  assert.equal(restored.roadmap.roadmapItems[0]?.status, "pending");
  history = await historyPayload(cwd);
  assert.equal(history.currentVersion, 4);
  assert.equal(history.entries[0]?.operation, "history.restore.board");

  assert.ok(created.roadmap.revision < restored.roadmap.revision);
});

test("restores one card or document from history as a new version", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  await writeDoc({
    cwd,
    cardId: "alpha",
    kind: "spec",
    markdown: "# Alpha Spec\n\nOriginal.\n",
  });
  const originalHistory = await historyPayload(cwd);
  const originalDocVersion = originalHistory.currentVersion;

  await writeDoc({
    cwd,
    cardId: "alpha",
    kind: "spec",
    markdown: "# Alpha Spec\n\nChanged.\n",
  });
  await setCardStatus(cwd, "alpha", "complete");

  const restoredCard = await restoreCardVersion({ cwd, version: 2, cardId: "alpha" });
  assert.equal(restoredCard.roadmap.roadmapItems[0]?.status, "pending");

  await restoreDocVersion({ cwd, version: originalDocVersion, cardId: "alpha", kind: "spec" });
  const doc = await readDoc({ cwd, cardId: "alpha", kind: "spec" });
  assert.match(doc.markdown, /Original/);
  assert.doesNotMatch(doc.markdown, /Changed/);

  const history = await historyPayload(cwd);
  assert.equal(history.entries[0]?.operation, "history.restore.doc");
});

test("finds historical docs after many unrelated board-only document versions", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  await writeDoc({
    cwd,
    cardId: "alpha",
    kind: "spec",
    markdown: "# Alpha Spec\n\nOriginal retained doc.\n",
  });
  const originalVersion = (await historyPayload(cwd)).currentVersion;

  for (let index = 0; index < 30; index += 1) {
    await createCard({ cwd, title: `Unrelated ${index + 1}`, status: "pending" });
  }

  const history = await historyPayload(cwd);
  assert.equal(history.currentVersion > originalVersion + 25, true);

  const historicalDoc = await readHistoryDoc({
    cwd,
    version: history.currentVersion,
    cardId: "alpha",
    kind: "spec",
  });
  assert.equal(historicalDoc.exists, true);
  assert.match(historicalDoc.markdown, /Original retained doc/);
});

test("rejects stale roadmap and markdown saves", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  const state = await createCard({ cwd, title: "Alpha", status: "pending" });

  await assert.rejects(
    reorderCards({
      cwd,
      baseRevision: state.roadmap.revision - 1,
      items: [{ id: "alpha", status: "pending" }],
    }),
    PlanbanConflictError,
  );

  const doc = await readDoc({ cwd, cardId: "alpha", kind: "spec" });
  const path = doc.path;
  assert.ok(path);
  await writeDoc({
    cwd,
    cardId: "alpha",
    kind: "spec",
    markdown: "# Alpha Spec\n\nFresh save.\n",
    expectedMtimeMs: doc.mtimeMs,
  });
  const changedStats = await stat(path);

  await assert.rejects(
    writeDoc({
      cwd,
      cardId: "alpha",
      kind: "spec",
      markdown: "# Alpha Spec\n\nStale save.\n",
      expectedMtimeMs: changedStats.mtimeMs - 1,
    }),
    PlanbanConflictError,
  );
});

test("deletes archived cards and their local docs only after archive", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  const created = await createCard({ cwd, title: "Alpha", status: "pending" });
  const doc = await readDoc({ cwd, cardId: "alpha", kind: "spec" });
  assert.ok(doc.path);

  await assert.rejects(
    deleteArchivedCard({ cwd, cardId: "alpha", baseRevision: created.roadmap.revision }),
    PlanbanConflictError,
  );

  const archived = await setCardStatus(cwd, "alpha", "archived");
  const deleted = await deleteArchivedCard({ cwd, cardId: "alpha", baseRevision: archived.roadmap.revision });

  assert.equal(deleted.roadmap.roadmapItems.some((item) => item.id === "alpha"), false);
  await assert.rejects(stat(doc.path));
});
