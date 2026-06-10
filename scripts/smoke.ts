import { appendFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCard, initializeProject, readDoc } from "../src/core/storage";
import { startServer } from "../src/server/server";

const cwd = "/tmp/planban-http-smoke";
const repoId = "planban-http-smoke";
const planningRoot = join(homedir(), ".planban", "repos", repoId);

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${url} failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

await rm(cwd, { recursive: true, force: true });
await rm(planningRoot, { recursive: true, force: true });
await mkdir(cwd, { recursive: true });

await initializeProject({ cwd, title: "HTTP Smoke", repoId, updateAgents: false });
await createCard({ cwd, title: "Alpha", status: "pending" });
await createCard({ cwd, title: "Beta", status: "pending" });
await createCard({ cwd, title: "Gamma", status: "up-next" });

const server = await startServer({ cwd, port: 4321, useVite: false });

try {
  const htmlResponse = await fetch(server.url);
  if (!htmlResponse.ok) throw new Error(`Static app failed with ${htmlResponse.status}`);

  const initial = await jsonFetch<{
    roadmap: { revision: number; roadmapItems: Array<{ id: string; status: string }> };
  }>(`${server.url}/api/state`);

  const ordered = [...initial.roadmap.roadmapItems]
    .reverse()
    .map((item) => ({ id: item.id, status: item.status }));

  const reordered = await jsonFetch<{
    roadmap: { revision: number; roadmapItems: Array<{ id: string }> };
  }>(`${server.url}/api/cards/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseRevision: initial.roadmap.revision, items: ordered }),
  });

  const staleReorder = await fetch(`${server.url}/api/cards/reorder`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseRevision: initial.roadmap.revision, items: ordered }),
  });
  if (staleReorder.status !== 409) {
    throw new Error(`Expected stale reorder 409, got ${staleReorder.status}`);
  }

  const docBefore = await jsonFetch<{ mtimeMs: number }>(`${server.url}/api/cards/alpha/docs/spec`);
  const saved = await jsonFetch<{ path: string; markdown: string; mtimeMs: number }>(
    `${server.url}/api/cards/alpha/docs/spec`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        markdown: "# Alpha Spec\n\nSaved through HTTP.\n",
        expectedMtimeMs: docBefore.mtimeMs,
      }),
    },
  );

  await appendFile(saved.path, "\nExternal edit.\n");

  const staleDoc = await fetch(`${server.url}/api/cards/alpha/docs/spec`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      markdown: "# Alpha Spec\n\nStale overwrite.\n",
      expectedMtimeMs: saved.mtimeMs,
    }),
  });
  if (staleDoc.status !== 409) {
    throw new Error(`Expected stale doc 409, got ${staleDoc.status}`);
  }

  const finalDoc = await readDoc({ cwd, cardId: "alpha", kind: "spec" });
  if (!finalDoc.markdown.includes("External edit.")) {
    throw new Error("External doc edit was not preserved after stale save attempt");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        server: server.url,
        htmlStatus: htmlResponse.status,
        initialRevision: initial.roadmap.revision,
        reorderedRevision: reordered.roadmap.revision,
        firstAfterReorder: reordered.roadmap.roadmapItems[0]?.id,
        staleReorderStatus: staleReorder.status,
        docSavedChars: saved.markdown.length,
        staleDocStatus: staleDoc.status,
        externalEditPreserved: true,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
}
