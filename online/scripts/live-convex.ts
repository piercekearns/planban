// Checks that a board server watching an Online Board on a local Convex
// backend is told about another machine's change through the Convex
// subscription, within about a second rather than a polling interval.
// Uses a temporary PLANBAN_HOME and project; touches no real board.
//
//   PLANBAN_HOME=$(mktemp -d) PLANBAN_ONLINE_URL=http://127.0.0.1:3211 node --import tsx/esm online/scripts/live-convex.ts
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PLANBAN_HOME?.startsWith(tmpdir()) && !process.env.PLANBAN_HOME?.startsWith("/var/folders") && !process.env.PLANBAN_HOME?.startsWith("/tmp")) {
  throw new Error("Run with PLANBAN_HOME set to a temporary folder.");
}
const url = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3211").replace(/\/+$/, "");
const { initializeProject, createCard, updateCard, loadState } = await import("../../src/core/storage");
const { onlineLogin } = await import("../../src/core/online/login");
const { takeOnline } = await import("../../src/core/online/transfers");
const { startServer } = await import("../../src/server/server");

const cwd = await mkdtemp(join(tmpdir(), "planban-live-"));
const repoId = `live-${Date.now().toString(36)}`;
await initializeProject({ cwd, title: "Live check", repoId, updateAgents: false });
await createCard({ cwd, title: "Watched card" });
await onlineLogin(url, { devUser: "owner" });
await takeOnline(url, cwd);

const port = await new Promise<number>((resolve) => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address() as { port: number };
    probe.close(() => resolve(port));
  });
});
const server = await startServer({ cwd, port, useVite: false });
try {
  const live = async () => (await (await fetch(`${server.url}/api/live?repoId=${repoId}`)).json()) as { stateVersion: number };
  await live();
  // Let the board server open its subscription (it checks every 3 seconds).
  await new Promise((resolve) => setTimeout(resolve, 4500));
  for (const summary of ["First remote change", "Second remote change"]) {
    const before = (await live()).stateVersion;
    const state = await loadState(cwd);
    const started = Date.now();
    await updateCard({ cwd, cardId: state.roadmap.roadmapItems[0]!.id, summary, baseRevision: state.roadmap.revision });
    let after = before;
    while (after === before && Date.now() - started < 2500) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      after = (await live()).stateVersion;
    }
    const elapsed = Date.now() - started;
    assert.ok(after > before, `board server was not told about "${summary}"`);
    assert.ok(elapsed < 2500, `took ${elapsed} ms`);
    console.log(`  ok - board server signalled "${summary}" after ${elapsed} ms`);
  }
} finally {
  await server.close();
}
console.log("Live updates through the Convex subscription work.");
