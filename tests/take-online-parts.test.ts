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
