import assert from "node:assert/strict";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { createCard, initializeProject, readDoc, saveRoadmap, setCardStatus } from "../src/core/storage";
import { PLANBAN_VERSION } from "../src/core/version";
import { startServer } from "../src/server/server";

const repoId = "planban-server-test";
const otherRepoId = "planban-server-test-other";
const cwd = "/tmp/planban-server-test";
const otherCwd = "/tmp/planban-server-test-other";
const planbanHome = "/tmp/planban-server-home";
const planningRoot = join(planbanHome, "repos", repoId);
const otherPlanningRoot = join(planbanHome, "repos", otherRepoId);

function nextPatchVersion(version: string) {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
  return `${major}.${minor}.${patch + 1}`;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.json() as Promise<T>;
}

async function freePort() {
  const server = createHttpServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  assert.equal(typeof address, "object");
  return address.port;
}

test.beforeEach(async () => {
  process.env.PLANBAN_HOME = planbanHome;
  await rm(cwd, { recursive: true, force: true });
  await rm(otherCwd, { recursive: true, force: true });
  await rm(planbanHome, { recursive: true, force: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(otherCwd, { recursive: true });
});

test.afterEach(() => {
  delete process.env.PLANBAN_HOME;
  delete process.env.CODEX_HOME;
  delete process.env.PLANBAN_UPDATE_MANIFEST_URL;
});

test("serves the built app and exposes state APIs", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    const html = await fetch(server.url);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Planban/);

    const status = await jsonFetch<{ initialized: boolean; repoId: string; version: { version: string } }>(`${server.url}/api/status`);
    assert.equal(status.initialized, true);
    assert.equal(status.repoId, repoId);
    assert.equal(status.version.version, PLANBAN_VERSION);

    const state = await jsonFetch<{ roadmap: { roadmapItems: Array<{ id: string }> } }>(`${server.url}/api/state`);
    assert.deepEqual(
      state.roadmap.roadmapItems.map((item) => item.id),
      ["alpha"],
    );
  } finally {
    await server.close();
  }
});

test("reports update status from public version metadata", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  const latestVersion = nextPatchVersion(PLANBAN_VERSION);
  let manifestRequestUrl: string | undefined;
  const manifestServer = createHttpServer((req, res) => {
    manifestRequestUrl = req.url;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      schemaVersion: 1,
      version: latestVersion,
      pluginVersion: latestVersion,
      mcpVersion: latestVersion,
      storageSchemaVersion: 1,
      minimumStorageSchemaVersion: 1,
      publishedAt: "2026-06-10T01:30:00.000Z",
      sourceUrl: "https://github.com/piercekearns/planban",
      releaseNotesUrl: `https://github.com/piercekearns/planban/releases/tag/v${latestVersion}`,
      summary: "Test update",
      updatePrompt: "Update Planban.",
      postUpdateRoute: "board-with-changelog",
      changelogTitle: "Test changelog",
      changelogSummary: "A richer test update.",
      showTutorialWhenUpdatingFromBefore: PLANBAN_VERSION,
    }));
  });
  await new Promise<void>((resolveListen) => manifestServer.listen(0, resolveListen));
  const address = manifestServer.address();
  assert.equal(typeof address, "object");
  process.env.PLANBAN_UPDATE_MANIFEST_URL = `http://127.0.0.1:${address?.port}/latest.json`;
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    const status = await jsonFetch<{
      current: { version: string };
      latest: { version: string; postUpdateRoute?: string; changelogTitle?: string } | null;
      updateAvailable: boolean;
      compatible: boolean;
      checkError: string | null;
    }>(`${server.url}/api/update-status`);
    assert.equal(status.current.version, PLANBAN_VERSION);
    assert.equal(status.latest?.version, latestVersion);
    assert.equal(status.updateAvailable, true);
    assert.equal(status.compatible, true);
    assert.equal(status.checkError, null);
    assert.equal(status.latest?.postUpdateRoute, "board-with-changelog");
    assert.equal(status.latest?.changelogTitle, "Test changelog");
    assert.match(manifestRequestUrl ?? "", /[?&]_/u);
  } finally {
    await server.close();
    await new Promise<void>((resolveClose, rejectClose) => {
      manifestServer.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
});

test("starts update jobs and records preflight failure for blocked installs", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  const latestVersion = nextPatchVersion(PLANBAN_VERSION);
  const manifestServer = createHttpServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      schemaVersion: 1,
      version: latestVersion,
      pluginVersion: latestVersion,
      mcpVersion: latestVersion,
      storageSchemaVersion: 1,
      minimumStorageSchemaVersion: 1,
      publishedAt: "2026-06-12T00:00:00.000Z",
      sourceUrl: "https://github.com/piercekearns/planban",
      releaseNotesUrl: `https://github.com/piercekearns/planban/releases/tag/v${latestVersion}`,
      targetRef: "main",
      targetCommit: "def456",
      summary: "Test update",
      updatePrompt: "Update Planban.",
      postUpdateRoute: "board-with-changelog",
      changelogTitle: "Test changelog",
      changelogSummary: "A richer test update.",
    }));
  });
  await new Promise<void>((resolveListen) => manifestServer.listen(0, resolveListen));
  const address = manifestServer.address();
  assert.equal(typeof address, "object");
  process.env.PLANBAN_UPDATE_MANIFEST_URL = `http://127.0.0.1:${address?.port}/latest.json`;
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    const job = await jsonFetch<{ id: string; status: string }>(`${server.url}/api/update-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentBoardUrl: `${server.url}/boards/${repoId}` }),
    });
    assert.equal(job.status, "pending");

    let finalJob: { status: string; error: string | null } | null = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      finalJob = await jsonFetch<{ status: string; error: string | null }>(`${server.url}/api/update-run/${job.id}`);
      if (finalJob.status === "failed") break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }

    assert.equal(finalJob?.status, "failed");
    assert.match(finalJob?.error ?? "", /not eligible|not identify|local changes|development checkout/u);
  } finally {
    await server.close();
    await new Promise<void>((resolveClose, rejectClose) => {
      manifestServer.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }
});

test("lists registered boards and serves board-specific state APIs", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  await initializeProject({ cwd: otherCwd, title: "Other Board", repoId: otherRepoId, updateAgents: false });
  await createCard({ cwd: otherCwd, title: "Beta", status: "up-next" });
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    const boards = await jsonFetch<{ boards: Array<{ repoId: string; title: string }> }>(`${server.url}/api/boards`);
    assert.deepEqual(
      boards.boards.map((board) => board.repoId).sort(),
      [otherRepoId, repoId].sort(),
    );

    const first = await jsonFetch<{ roadmap: { project: { title: string }; roadmapItems: Array<{ id: string }> } }>(
      `${server.url}/api/boards/${repoId}/state`,
    );
    const second = await jsonFetch<{ roadmap: { project: { title: string }; roadmapItems: Array<{ id: string }> } }>(
      `${server.url}/api/boards/${otherRepoId}/state`,
    );
    assert.equal(first.roadmap.project.title, "Server Test");
    assert.equal(first.roadmap.roadmapItems[0]?.id, "alpha");
    assert.equal(second.roadmap.project.title, "Other Board");
    assert.equal(second.roadmap.roadmapItems[0]?.id, "beta");
  } finally {
    await server.close();
  }
});

test("archives, restores, and deletes whole boards through the board API", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await initializeProject({ cwd: otherCwd, title: "Other Board", repoId: otherRepoId, updateAgents: false });
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    await jsonFetch<{ board: { repoId: string; archivedAt: string } }>(`${server.url}/api/boards/${repoId}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const active = await jsonFetch<{ boards: Array<{ repoId: string }> }>(`${server.url}/api/boards`);
    assert.deepEqual(active.boards.map((board) => board.repoId), [otherRepoId]);

    const all = await jsonFetch<{ boards: Array<{ repoId: string; archivedAt?: string | null }> }>(
      `${server.url}/api/boards?includeArchived=true`,
    );
    assert.equal(all.boards.find((board) => board.repoId === repoId)?.archivedAt !== null, true);

    await jsonFetch<{ board: { repoId: string; archivedAt: null } }>(`${server.url}/api/boards/${repoId}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    const rejected = await fetch(`${server.url}/api/boards/${repoId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmRepoId: "wrong" }),
    });
    assert.equal(rejected.status, 422);

    const deleted = await jsonFetch<{ repoId: string; backupPath: string }>(`${server.url}/api/boards/${repoId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmRepoId: repoId }),
    });
    assert.equal(deleted.repoId, repoId);
    assert.equal(JSON.parse(await readFile(join(deleted.backupPath, "roadmap.json"), "utf8")).project.title, "Server Test");
  } finally {
    await server.close();
  }
});

test("persists reorder and rejects stale API writes", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  await createCard({ cwd, title: "Beta", status: "pending" });
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    const initial = await jsonFetch<{
      roadmap: { revision: number; roadmapItems: Array<{ id: string; status: string }> };
    }>(`${server.url}/api/state`);

    const items = [...initial.roadmap.roadmapItems]
      .reverse()
      .map((item) => ({ id: item.id, status: item.status }));

    const reordered = await jsonFetch<{
      roadmap: { revision: number; roadmapItems: Array<{ id: string }> };
    }>(`${server.url}/api/cards/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: initial.roadmap.revision, items }),
    });
    assert.equal(reordered.roadmap.roadmapItems[0]?.id, "beta");

    const stale = await fetch(`${server.url}/api/cards/reorder`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: initial.roadmap.revision, items }),
    });
    assert.equal(stale.status, 409);
  } finally {
    await server.close();
  }
});

test("rejects cross-origin browser-shaped API mutations", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    const rejected = await fetch(`${server.url}/api/cards/alpha/complete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://evil.example",
        "Sec-Fetch-Site": "cross-site",
      },
      body: "{}",
    });
    assert.equal(rejected.status, 403);

    const afterRejected = await jsonFetch<{ roadmap: { roadmapItems: Array<{ id: string; status: string }> } }>(
      `${server.url}/api/state`,
    );
    assert.equal(afterRejected.roadmap.roadmapItems[0]?.status, "pending");

    const accepted = await jsonFetch<{ roadmap: { roadmapItems: Array<{ id: string; status: string }> } }>(
      `${server.url}/api/cards/alpha/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: server.url,
          "Sec-Fetch-Site": "same-origin",
        },
        body: "{}",
      },
    );
    assert.equal(accepted.roadmap.roadmapItems[0]?.status, "complete");
  } finally {
    await server.close();
  }
});

test("creates structured cards through the board API", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    const created = await jsonFetch<{
      createdCard: { id: string; priority: number; tags: string[]; metadata?: Record<string, unknown>; planDoc: string | null };
      roadmap: { roadmapItems: Array<{ id: string }> };
    }>(`${server.url}/api/boards/${repoId}/cards`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: server.url, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({
        title: "API Structured",
        status: "pending",
        position: "top",
        tags: ["api"],
        metadata: { source: "server-test" },
        specMarkdown: "# API Spec\n",
        planMarkdown: "# API Plan\n",
      }),
    });

    assert.equal(created.createdCard.id, "api-structured");
    assert.equal(created.createdCard.priority, 1);
    assert.deepEqual(created.createdCard.tags, ["api"]);
    assert.deepEqual(created.createdCard.metadata, { source: "server-test" });
    assert.equal(created.createdCard.planDoc, "items/api-structured/plan.md");
    assert.deepEqual(created.roadmap.roadmapItems.map((item) => item.id), ["api-structured", "alpha"]);

    const plan = await jsonFetch<{ markdown: string }>(`${server.url}/api/boards/${repoId}/cards/api-structured/docs/plan`);
    assert.equal(plan.markdown, "# API Plan\n");
  } finally {
    await server.close();
  }
});

test("returns a client error for unsafe card document paths", async () => {
  const initial = await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  const created = await createCard({ cwd, title: "Alpha", status: "pending" });
  const alpha = created.roadmap.roadmapItems[0];
  assert.ok(alpha);
  await saveRoadmap(initial, {
    ...created.roadmap,
    roadmapItems: [{ ...alpha, specDoc: "../outside.md" }],
  }, false);
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    const response = await fetch(`${server.url}/api/cards/alpha/docs/spec`);
    assert.equal(response.status, 422);
    assert.match(await response.text(), /inside the planning root/u);
  } finally {
    await server.close();
  }
});

test("persists markdown saves and rejects stale markdown API writes", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    const before = await jsonFetch<{ mtimeMs: number }>(`${server.url}/api/cards/alpha/docs/spec`);
    const saved = await jsonFetch<{ path: string; mtimeMs: number; markdown: string }>(
      `${server.url}/api/cards/alpha/docs/spec`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown: "# Alpha Spec\n\nSaved through API.\n",
          expectedMtimeMs: before.mtimeMs,
        }),
      },
    );
    assert.match(saved.markdown, /Saved through API/);

    await appendFile(saved.path, "\nExternal edit.\n");
    const stale = await fetch(`${server.url}/api/cards/alpha/docs/spec`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        markdown: "# Alpha Spec\n\nStale overwrite.\n",
        expectedMtimeMs: saved.mtimeMs,
      }),
    });
    assert.equal(stale.status, 409);

    const finalDoc = await readDoc({ cwd, cardId: "alpha", kind: "spec" });
    assert.match(finalDoc.markdown, /External edit/);
  } finally {
    await server.close();
  }
});

test("deletes archived cards through the board API", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  await setCardStatus(cwd, "alpha", "archived");
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    const initial = await jsonFetch<{
      roadmap: { revision: number; roadmapItems: Array<{ id: string; status: string }> };
    }>(`${server.url}/api/boards/${repoId}/state`);
    assert.equal(initial.roadmap.roadmapItems[0]?.status, "archived");

    const deleted = await jsonFetch<{
      roadmap: { roadmapItems: Array<{ id: string }> };
    }>(`${server.url}/api/boards/${repoId}/cards/alpha`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: initial.roadmap.revision }),
    });
    assert.deepEqual(deleted.roadmap.roadmapItems, []);
  } finally {
    await server.close();
  }
});

test("serializes concurrent API creates and replays idempotent mutations", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    await Promise.all(Array.from({ length: 8 }, (_entry, index) =>
      jsonFetch(`${server.url}/api/boards/${repoId}/cards`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `parallel-create-${index + 1}`,
        },
        body: JSON.stringify({ title: `Parallel ${index + 1}`, status: "pending" }),
      }),
    ));

    const afterParallel = await jsonFetch<{
      roadmap: { revision: number; roadmapItems: Array<{ id: string; title: string }> };
    }>(`${server.url}/api/boards/${repoId}/state`);
    assert.equal(afterParallel.roadmap.roadmapItems.length, 8);
    assert.equal(new Set(afterParallel.roadmap.roadmapItems.map((item) => item.id)).size, 8);

    const retryInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "retry-create-once",
      },
      body: JSON.stringify({ title: "Retry Once", status: "pending" }),
    };
    const first = await jsonFetch<{
      roadmap: { revision: number; roadmapItems: Array<{ id: string; title: string }> };
    }>(`${server.url}/api/boards/${repoId}/cards`, retryInit);
    const second = await jsonFetch<{
      roadmap: { revision: number; roadmapItems: Array<{ id: string; title: string }> };
    }>(`${server.url}/api/boards/${repoId}/cards`, retryInit);

    assert.equal(first.roadmap.revision, second.roadmap.revision);
    assert.equal(second.roadmap.roadmapItems.filter((item) => item.title === "Retry Once").length, 1);

    const conflictingRetry = await fetch(`${server.url}/api/boards/${repoId}/cards`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "retry-create-once",
      },
      body: JSON.stringify({ title: "Retry Different", status: "pending" }),
    });
    assert.equal(conflictingRetry.status, 409);

    const history = await jsonFetch<{ currentVersion: number }>(`${server.url}/api/boards/${repoId}/history`);
    assert.equal(history.currentVersion, 10);
  } finally {
    await server.close();
  }
});

test("serves board history and restores through the board API", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  await setCardStatus(cwd, "alpha", "complete");
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    const history = await jsonFetch<{ currentVersion: number; entries: Array<{ version: number; operation: string }> }>(
      `${server.url}/api/boards/${repoId}/history`,
    );
    assert.equal(history.currentVersion, 3);

    const preview = await jsonFetch<{ roadmap: { roadmapItems: Array<{ id: string; status: string }> } }>(
      `${server.url}/api/boards/${repoId}/history/2`,
    );
    assert.equal(preview.roadmap.roadmapItems[0]?.status, "pending");

    const restored = await jsonFetch<{ roadmap: { roadmapItems: Array<{ id: string; status: string }> } }>(
      `${server.url}/api/boards/${repoId}/history/2/cards/alpha/restore`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actor: "user" }),
      },
    );
    assert.equal(restored.roadmap.roadmapItems[0]?.status, "pending");
  } finally {
    await server.close();
  }
});

test("links pending Codex threads from a bounded recent-session scan", async () => {
  const token = "planban:test-token:bounded-session-scan";
  const threadId = "019eae59-4c7f-7e11-8b75-a04066f815b1";
  const codexHome = join(planbanHome, "codex-home");
  const sessionDir = join(codexHome, "sessions", "2026", "06", "13");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `rollout-2026-06-13T22-00-00-${threadId}.jsonl`),
    `${"x".repeat(2 * 1024 * 1024 + 1024)}\n${JSON.stringify({ token })}\n`,
    "utf8",
  );
  process.env.CODEX_HOME = codexHome;

  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  const created = await createCard({ cwd, title: "Alpha", status: "pending" });
  const alpha = created.roadmap.roadmapItems[0];
  assert.ok(alpha);
  await saveRoadmap(created, {
    ...created.roadmap,
    roadmapItems: [
      {
        ...alpha,
        metadata: {
          codexThread: {
            status: "pending",
            launchToken: token,
          },
        },
      },
    ],
  }, false);
  const server = await startServer({ cwd, port: await freePort(), useVite: false });

  try {
    const linked = await jsonFetch<{ linked: boolean; threadId: string; threadUrl: string }>(
      `${server.url}/api/boards/${repoId}/cards/alpha/codex-thread/sync`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    );
    assert.equal(linked.linked, true);
    assert.equal(linked.threadId, threadId);
    assert.equal(linked.threadUrl, `codex://threads/${threadId}`);
  } finally {
    await server.close();
  }
});
