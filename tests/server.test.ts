import assert from "node:assert/strict";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createCard, initializeProject, readDoc, setCardStatus } from "../src/core/storage";
import { startServer } from "../src/server/server";

const repoId = "planban-server-test";
const otherRepoId = "planban-server-test-other";
const cwd = "/tmp/planban-server-test";
const otherCwd = "/tmp/planban-server-test-other";
const planbanHome = "/tmp/planban-server-home";
const planningRoot = join(planbanHome, "repos", repoId);
const otherPlanningRoot = join(planbanHome, "repos", otherRepoId);

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  assert.equal(response.ok, true, `${url} returned ${response.status}`);
  return response.json() as Promise<T>;
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
});

test("serves the built app and exposes state APIs", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  const server = await startServer({ cwd, port: 4322, useVite: false });

  try {
    const html = await fetch(server.url);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Planban/);

    const status = await jsonFetch<{ initialized: boolean; repoId: string }>(`${server.url}/api/status`);
    assert.equal(status.initialized, true);
    assert.equal(status.repoId, repoId);

    const state = await jsonFetch<{ roadmap: { roadmapItems: Array<{ id: string }> } }>(`${server.url}/api/state`);
    assert.deepEqual(
      state.roadmap.roadmapItems.map((item) => item.id),
      ["alpha"],
    );
  } finally {
    await server.close();
  }
});

test("lists registered boards and serves board-specific state APIs", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  await initializeProject({ cwd: otherCwd, title: "Other Board", repoId: otherRepoId, updateAgents: false });
  await createCard({ cwd: otherCwd, title: "Beta", status: "up-next" });
  const server = await startServer({ cwd, port: 4325, useVite: false });

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

test("persists reorder and rejects stale API writes", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  await createCard({ cwd, title: "Beta", status: "pending" });
  const server = await startServer({ cwd, port: 4323, useVite: false });

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

test("persists markdown saves and rejects stale markdown API writes", async () => {
  await initializeProject({ cwd, title: "Server Test", repoId, updateAgents: false });
  await createCard({ cwd, title: "Alpha", status: "pending" });
  const server = await startServer({ cwd, port: 4324, useVite: false });

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
  const server = await startServer({ cwd, port: 4326, useVite: false });

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
  const server = await startServer({ cwd, port: 4328, useVite: false });

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
  const server = await startServer({ cwd, port: 4327, useVite: false });

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
