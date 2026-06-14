import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ensureDemoBoard } from "../src/core/demo";
import { registryPath } from "../src/core/paths";
import { archiveBoard, deleteBoard, listAllBoards, listBoards, restoreBoard } from "../src/core/registry";
import {
  createCard,
  deleteArchivedCard,
  historyPayload,
  initializeProject,
  loadHistoryState,
  PlanbanConflictError,
  readDoc,
  readHistoryDoc,
  reorderCards,
  restoreBoardVersion,
  restoreCardVersion,
  restoreDocVersion,
  saveRoadmap,
  setCardStatus,
  writeDoc,
} from "../src/core/storage";

const repoId = "planban-storage-test";
const cwd = "/tmp/planban-storage-test";
const planbanHome = "/tmp/planban-storage-home";
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

test("initializes repo protocol files and device-local state", async () => {
  const state = await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });

  assert.equal(state.manifest.repoId, repoId);
  assert.equal(state.roadmap.project.title, "Storage Test");
  assert.equal(state.roadmap.roadmapItems.length, 0);
  assert.equal(JSON.parse(await readFile(join(cwd, ".planban", "project.json"), "utf8")).repoId, repoId);
  assert.equal(JSON.parse(await readFile(join(planningRoot, "roadmap.json"), "utf8")).project.title, "Storage Test");
  assert.equal(JSON.parse(await readFile(registryPath(), "utf8")).boards[0].repoId, repoId);
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

test("creates cards with linked docs and persists exact reorder", async () => {
  await initializeProject({ cwd, title: "Storage Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
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

  const plan = await readDoc({ cwd, cardId: "alpha", kind: "plan" });
  assert.equal(plan.exists, false);
  assert.equal(plan.path, null);
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

  await setCardStatus(cwd, "alpha", "complete");
  history = await historyPayload(cwd);
  assert.equal(history.currentVersion, 3);
  assert.match(history.entries[0]?.summary ?? "", /Moved Alpha to Complete/);

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
