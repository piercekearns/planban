// Taking a board online sends it in parts, each small enough for the online
// service's one second of work per request (staging rehearsal, 16 October
// 2026: Revival's 800 KB board versions ran out of time in 4 MB parts).
import assert from "node:assert/strict";
import test from "node:test";
test("taking a large board online sends its history in parts small enough for the service's time limit", async () => {
  const { uploadParts, PART_BYTES } = await import("../src/core/online/transfers");
  const { createEmptyRoadmap } = await import("../src/core/boardOperations");
  // Board versions the size of Revival's (about 800 KB each).
  const big = { ...createEmptyRoadmap({ repoId: "big", title: "Big", now: "2026-10-16T00:00:00.000Z" }), project: { id: "big", title: "Big", status: "active", description: "x".repeat(800 * 1024), tags: [] } };
  const history = Array.from({ length: 6 }, (_, i) => ({ entry: { version: i + 1, roadmapRevision: i + 1, createdAt: "2026-10-16T00:00:00.000Z", actor: "user" as const, operation: "x", summary: "x", affectedCards: [], affectedDocs: [] }, roadmap: big }));
  const parts = uploadParts({ format: "planban-board-bundle", version: 1, roadmap: big, docs: [], history } as never);
  assert.equal(parts.length, 6);
  for (const part of parts) assert.ok((part.history ?? []).length <= 1 && JSON.stringify(part).length <= PART_BYTES * 1.2);
});

test("a board with a thousand cards created in one go still goes online; that entry lists as many as fit", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const storage = await import("../src/core/storage");
  const { onlineLogin } = await import("../src/core/online/login");
  const { takeOnline } = await import("../src/core/online/transfers");
  const { serviceBridge } = await import("./service-bridge");
  const root = await mkdtemp(join(tmpdir(), "planban-bulk-"));
  const saved = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = join(root, "home");
  const bridge = await serviceBridge([["ana", "Ana"]]);
  try {
    const cwd = join(root, "bulk");
    await storage.initializeProject({ cwd, repoId: "bulk", title: "Bulk", updateAgents: false });
    await storage.createCards({ cwd, titles: Array.from({ length: 1_000 }, (_, i) => `Card ${i}`) });
    await onlineLogin(bridge.url, { devUser: "ana" });
    await takeOnline(bridge.url, cwd);
    const history = await storage.historyPayload(cwd);
    const bulk = history.entries.find((entry) => / more cards\)/.test(entry.summary));
    assert.ok(bulk, "the bulk entry says how many more cards it changed");
    assert.equal((await storage.loadState(cwd)).roadmap.roadmapItems.length, 1_000);
  } finally {
    await bridge.close();
    if (saved === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = saved;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a history version holding more documents than one response comes back over several pages", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { onlineLogin } = await import("../src/core/online/login");
  const { exportOnline, attachOnline } = await import("../src/core/online/transfers");
  const { onlineRequest } = await import("../src/core/online/client");
  const { createEmptyRoadmap, planCreateCards } = await import("../src/core/boardOperations");
  const { serviceBridge } = await import("./service-bridge");
  const root = await mkdtemp(join(tmpdir(), "planban-bigversion-"));
  const saved = process.env.PLANBAN_HOME;
  process.env.PLANBAN_HOME = join(root, "home");
  const bridge = await serviceBridge([["ana", "Ana"]]);
  try {
    await onlineLogin(bridge.url, { devUser: "ana" });
    const now = new Date().toISOString();
    const planned = planCreateCards(createEmptyRoadmap({ repoId: "big", title: "Big", now }), { titles: Array.from({ length: 8 }, (_, i) => `Card ${i}`) } as never, { now });
    const roadmap = { ...planned.roadmap, roadmapItems: planned.roadmap.roadmapItems.map((item: any) => ({ ...item, specDoc: `items/${item.id}/spec.md` })) };
    // About 900 KB of ordinary prose per Spec, eight of them in one history version: over 6 MB.
    const prose = (n: number) => Array.from({ length: 9_000 }, (_, i) => `Line ${i} of card ${n}: the club wants the kit in navy and gold, with names on the back.`).join("\n").slice(0, 900_000);
    const docs = roadmap.roadmapItems.map((item: any, n: number) => ({ cardId: item.id, kind: "spec", markdown: prose(n) }));
    const entry = { version: 1, roadmapRevision: roadmap.revision, createdAt: now, actor: "user", operation: "x", summary: "Specs", affectedCards: roadmap.roadmapItems.map((item: any) => item.id), affectedDocs: roadmap.roadmapItems.map((item: any) => ({ cardId: item.id, kind: "spec", path: item.specDoc })) };
    await onlineRequest(bridge.url, "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap, docs, history: [{ entry, roadmap }], historyDocs: docs.map((doc: any) => ({ ...doc, version: 1 })) });
    const cwd = join(root, "big");
    await attachOnline(bridge.url, "big", cwd);
    const bundle = await exportOnline(cwd);
    assert.equal((bundle.historyDocs ?? []).filter((doc) => doc.version === 1).length, 8);
  } finally {
    await bridge.close();
    if (saved === undefined) delete process.env.PLANBAN_HOME;
    else process.env.PLANBAN_HOME = saved;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
