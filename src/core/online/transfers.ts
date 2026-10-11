import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeRoadmap, PlanbanValidationError } from "../boardOperations";
import { listHistory } from "../history";
import { agentContextPath, defaultPlanbanRoot, historyDocPath, historyIndexPath, historyRoadmapPath, manifestPath, resolveInsideRoot } from "../paths";
import { atomicWriteFile, withBoardWriteLock } from "../persistence";
import { registerBoardFromState } from "../registry";
import { roadmapSchema } from "../schema";
import { loadState, pathExists, readDoc, readManifest, resolveProjectCwd, resolvePlanningRoot } from "../storage";
import type { PlanbanProjectManifest, PlanbanResolvedState } from "../types";
import { loadOnlineState, onlineState } from "./adapter";
import { boardPath, onlineRequest, requireCredentials } from "./client";
import { serviceUrl } from "./credentials";
import { buildAgentContext } from "../protocol";

const historyEntrySchema = z.object({
  version: z.number().int().positive(), roadmapRevision: z.number().int().nonnegative(),
  createdAt: z.string(), actor: z.enum(["user", "agent", "import", "system"]),
  operation: z.string(), summary: z.string(), affectedCards: z.array(z.string()),
  affectedDocs: z.array(z.object({ cardId: z.string(), kind: z.enum(["spec", "plan"]), path: z.string().nullable() })),
}).passthrough();

export const bundleSchema = z.object({
  format: z.literal("planban-board-bundle"), version: z.literal(1), roadmap: roadmapSchema,
  docs: z.array(z.object({ cardId: z.string(), kind: z.enum(["spec", "plan"]), markdown: z.string() })),
  history: z.array(z.object({ entry: historyEntrySchema, roadmap: roadmapSchema })),
  historyDocs: z.array(z.object({ version: z.number().int().positive(), cardId: z.string(), kind: z.enum(["spec", "plan"]), markdown: z.string() })).optional(),
});
export type BoardBundle = z.infer<typeof bundleSchema>;

async function writeJson(path: string, value: unknown) {
  await atomicWriteFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function publishManifest(cwd: string, manifest: PlanbanProjectManifest, state: PlanbanResolvedState) {
  await writeJson(manifestPath(cwd), manifest);
  await atomicWriteFile(agentContextPath(cwd), buildAgentContext({
    repoId: manifest.repoId, planningRoot: state.planningRoot, roadmapPath: state.roadmapPath, manifestPath: state.manifestPath,
    online: manifest.storage?.kind === "online" ? manifest.storage : undefined,
  }));
  await registerBoardFromState(state);
}

export async function buildLocalBundle(cwd: string): Promise<BoardBundle> {
  const state = await loadState(cwd);
  if (state.manifest.storage?.kind === "online") throw new PlanbanValidationError("This board is already online. Use online export.");
  const docs: BoardBundle["docs"] = [];
  for (const card of state.roadmap.roadmapItems) {
    for (const kind of ["spec", "plan"] as const) {
      const doc = await readDoc({ cwd, cardId: card.id, kind });
      if (doc.exists) docs.push({ cardId: card.id, kind, markdown: doc.markdown });
    }
  }
  const history = await listHistory(state);
  const historyDocs: NonNullable<BoardBundle["historyDocs"]> = [];
  for (const entry of history.entries) {
    for (const doc of entry.affectedDocs) {
      const path = historyDocPath(state.planningRoot, entry.version, doc.cardId, doc.kind);
      if (await pathExists(path)) historyDocs.push({ version: entry.version, cardId: doc.cardId, kind: doc.kind, markdown: await readFile(path, "utf8") });
    }
  }
  return bundleSchema.parse({ format: "planban-board-bundle", version: 1, roadmap: state.roadmap, docs,
    historyDocs,
    history: await Promise.all(history.entries.map(async (entry) => ({
      entry, roadmap: JSON.parse(await readFile(historyRoadmapPath(state.planningRoot, entry.version), "utf8")),
    }))),
  });
}

export async function takeOnline(urlInput: string, cwdInput: string) {
  const url = serviceUrl(urlInput);
  await requireCredentials(url);
  const cwd = resolveProjectCwd(cwdInput);
  const initial = await loadState(cwd);
  if (initial.manifest.storage?.kind === "online") throw new PlanbanValidationError("This board is already online.");
  return withBoardWriteLock(initial.planningRoot, async () => {
    const state = await loadState(cwd);
    const bundle = await buildLocalBundle(cwd);
    const boardId = state.manifest.repoId;
    bundle.roadmap.project.id = boardId;
    const imported = await onlineRequest<{ boardId: string; roadmap: PlanbanResolvedState["roadmap"] }>(url, "/api/v1/boards/import", bundle);
    // Retain every local byte, but remove the live filename so other checkouts
    // with an old local manifest cannot continue editing the uploaded board.
    const snapshot = join(state.planningRoot, `roadmap.local-before-online-${Date.now()}.json`);
    await rename(state.roadmapPath, snapshot);
    await atomicWriteFile(join(state.planningRoot, "ONLINE-BOARD.txt"), `Authority moved to ${url}, board ${boardId}.\nThe roadmap snapshot, documents and history here are recovery evidence. Do not edit them.\n`);
    const manifest: PlanbanProjectManifest = { ...state.manifest, storage: { kind: "online", url, boardId } };
    await publishManifest(cwd, manifest, onlineState(cwd, manifest, imported.roadmap));
    return { boardId, url, localSnapshot: snapshot };
  });
}

async function requireOnline(cwdInput: string) {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled || manifest.storage?.kind !== "online") throw new PlanbanValidationError("This project does not point to an Online Board.");
  return { cwd, manifest, storage: manifest.storage };
}

export async function exportOnline(cwd: string, out?: string): Promise<BoardBundle> {
  const { storage } = await requireOnline(cwd);
  const bundle = bundleSchema.parse(await onlineRequest(storage.url, boardPath(storage.boardId, "/export")));
  if (out) await writeJson(resolve(out), bundle);
  return bundle;
}

async function stageBundle(root: string, bundle: BoardBundle) {
  const roadmap = normalizeRoadmap(bundle.roadmap);
  const docKeys = new Set<string>();
  const paths = new Set<string>();
  for (const doc of bundle.docs) {
    const item = roadmap.roadmapItems.find((item) => item.id === doc.cardId);
    if (!item) throw new PlanbanValidationError(`Export contains a document for an unknown card: ${doc.cardId}`);
    const key = `${doc.cardId}/${doc.kind}`;
    if (docKeys.has(key)) throw new PlanbanValidationError(`Export contains a duplicate document: ${key}`);
    docKeys.add(key);
    const configured = doc.kind === "spec" ? item.specDoc : item.planDoc;
    if (!configured) throw new PlanbanValidationError(`Export document has no roadmap reference: ${key}`);
    const destination = resolveInsideRoot(root, configured);
    const protectedPaths = [join(root, "roadmap.json"), join(root, "history"), join(root, ".planban-write.lock")];
    if (protectedPaths.some((path) => destination === path || destination.startsWith(path + sep)) || paths.has(destination)) {
      throw new PlanbanValidationError(`Export contains a conflicting document path: ${configured}`);
    }
    paths.add(destination);
    await atomicWriteFile(destination, doc.markdown);
  }
  const versions = new Set<number>();
  for (const version of bundle.history) {
    if (versions.has(version.entry.version)) throw new PlanbanValidationError("Export contains duplicate history versions.");
    versions.add(version.entry.version);
    await writeJson(historyRoadmapPath(root, version.entry.version), version.roadmap);
  }
  const historyPaths = new Set<string>();
  for (const doc of bundle.historyDocs ?? []) {
    if (!versions.has(doc.version)) throw new PlanbanValidationError("Export contains a document for an unknown history version.");
    const path = historyDocPath(root, doc.version, doc.cardId, doc.kind);
    if (historyPaths.has(path)) throw new PlanbanValidationError("Export contains conflicting historical document paths.");
    historyPaths.add(path);
    await atomicWriteFile(path, doc.markdown);
  }
  await writeJson(historyIndexPath(root), { version: 1, latestVersion: Math.max(0, ...versions),
    retention: { boardVersions: 100, cardVersions: 25, documentVersions: 25, hourlyDays: 2, maxAgeDays: 90 },
    entries: bundle.history.map(({ entry }) => entry).sort((a, b) => a.version - b.version),
  });
  await writeJson(join(root, "roadmap.json"), roadmap);
  return roadmap;
}

export async function takeLocal(cwdInput: string) {
  const { cwd, manifest, storage } = await requireOnline(cwdInput);
  return withBoardWriteLock(resolvePlanningRoot(manifest), async () => {
    const current = await requireOnline(cwd);
    if (current.storage.url !== storage.url || current.storage.boardId !== storage.boardId) {
      throw new PlanbanValidationError("Board authority changed while waiting. Reload before taking it local.");
    }
    // Fence first: after this succeeds, every export describes a frozen board.
    // A failed download leaves the manifest online and may be retried safely.
    const root = join(defaultPlanbanRoot(), "repos", `online-return-${randomUUID()}`);
    await onlineRequest(storage.url, boardPath(storage.boardId, "/authority"), { state: "returned-local" });
    const roadmap = await stageBundle(root, await exportOnline(cwd));
    const localManifest: PlanbanProjectManifest = { ...manifest, storage: { kind: "local", root } };
    const state: PlanbanResolvedState = { cwd, manifest: localManifest, manifestPath: manifestPath(cwd),
      agentContextPath: agentContextPath(cwd), planningRoot: root, roadmapPath: join(root, "roadmap.json"), roadmap };
    await publishManifest(cwd, localManifest, state);
    return { boardId: storage.boardId, planningRoot: root };
  });
}

export async function attachOnline(urlInput: string, boardId: string, cwdInput: string) {
  const url = serviceUrl(urlInput);
  const cwd = resolve(cwdInput);
  const existing = await readManifest(cwd);
  if (existing && (existing.storage?.kind !== "online" || existing.storage.url !== url || existing.storage.boardId !== boardId)) {
    throw new PlanbanValidationError("This directory already has a different board. Use an empty directory or its existing board transfer command.");
  }
  if (!boardId.trim()) throw new PlanbanValidationError("boardId is required.");
  const manifest: PlanbanProjectManifest = { version: 1, enabled: true, repoId: boardId, storage: { kind: "online", url, boardId } };
  const state = await loadOnlineState(cwd, manifest);
  await mkdir(dirname(manifestPath(cwd)), { recursive: true });
  await publishManifest(cwd, manifest, state);
  return { boardId, url, cwd };
}
