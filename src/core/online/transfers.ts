import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { normalizeRoadmap, PlanbanConflictError, PlanbanValidationError } from "../boardOperations";
import { listHistory } from "../history";
import { agentContextPath, defaultPlanbanRoot, historyDocPath, historyIndexPath, historyRoadmapPath, manifestPath, resolveInsideRoot } from "../paths";
import { atomicWriteFile, withBoardWriteLock } from "../persistence";
import { registerBoardFromState } from "../registry";
import { roadmapSchema } from "../schema";
import { loadState, pathExists, readDoc, readManifest, resolveProjectCwd, resolvePlanningRoot, saveRoadmap } from "../storage";
import type { PlanbanProjectManifest, PlanbanResolvedState } from "../types";
import { loadOnlineState, onlineState } from "./adapter";
import { boardPath, onlineRequest, requireCredentials } from "./client";
import { markIndependent, readStaleMarker, type StaleCopy } from "./copyCheck";
import { readBackup, refreshBackup } from "./backup";
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
  retiredIds: z.array(z.string()).optional(),
  /** Local history retention settings, so Take Local restores them. */
  retention: z.record(z.string(), z.unknown()).optional(),
});
export type BoardBundle = z.infer<typeof bundleSchema>;

/** Upload parts stay well inside one request; Revival's history alone is 126 MB. */
const PART_BYTES = 4 * 1024 * 1024;
const HISTORY_PAGE = 8;
const DOCS_PAGE = 100;

/**
 * Test hook: the crash tests set PLANBAN_TEST_CRASH_AT to a step name to kill
 * this process at that exact point, the way a power cut would.
 */
function crashPoint(name: string) {
  if (process.env.PLANBAN_TEST_CRASH_AT === name) process.kill(process.pid, "SIGKILL");
}

const journalSchema = z.object({
  version: z.literal(1),
  direction: z.enum(["online", "local"]),
  transferId: z.string(),
  url: z.string(),
  boardId: z.string(),
  /** Take Online: the local revision the upload was built from. */
  localRevision: z.number().optional(),
  /** Take Local: the fresh folder the board is being written into. */
  root: z.string().optional(),
  phase: z.enum(["uploading", "committed", "fenced"]),
  startedAt: z.string(),
});
type TransferJournal = z.infer<typeof journalSchema>;

/** The journal records an unfinished transfer so the next attempt resumes it safely. */
export function transferJournalPath(planningRoot: string) {
  return join(planningRoot, "online-transfer.json");
}

async function readJournal(planningRoot: string): Promise<TransferJournal | null> {
  try {
    return journalSchema.parse(JSON.parse(await readFile(transferJournalPath(planningRoot), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new PlanbanValidationError(`The unfinished transfer record at ${transferJournalPath(planningRoot)} is unreadable. Move it aside and retry.`);
  }
}

async function writeJournal(planningRoot: string, journal: TransferJournal) {
  await atomicWriteFile(transferJournalPath(planningRoot), JSON.stringify(journal, null, 2) + "\n");
}

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
    historyDocs, retention: history.retention,
    history: await Promise.all(history.entries.map(async (entry) => ({
      entry, roadmap: JSON.parse(await readFile(historyRoadmapPath(state.planningRoot, entry.version), "utf8")),
    }))),
  });
}

interface UploadPart {
  docs?: BoardBundle["docs"];
  history?: BoardBundle["history"];
  historyDocs?: NonNullable<BoardBundle["historyDocs"]>;
}

/** Splits a bundle into parts of bounded size, in a stable order so a resumed upload sends the same parts. */
export function uploadParts(bundle: BoardBundle): UploadPart[] {
  const parts: UploadPart[] = [];
  let current: UploadPart = {};
  let size = 0;
  const add = <K extends keyof UploadPart>(key: K, value: NonNullable<UploadPart[K]>[number]) => {
    const bytes = JSON.stringify(value).length;
    if (size > 0 && size + bytes > PART_BYTES) {
      parts.push(current);
      current = {};
      size = 0;
    }
    ((current[key] ??= []) as unknown[]).push(value);
    size += bytes;
  };
  for (const doc of bundle.docs) add("docs", doc);
  // History versions go before the documents that belong to them.
  const sorted = [...bundle.history].sort((a, b) => a.entry.version - b.entry.version);
  const docsByVersion = new Map<number, NonNullable<BoardBundle["historyDocs"]>>();
  for (const doc of bundle.historyDocs ?? []) docsByVersion.set(doc.version, [...(docsByVersion.get(doc.version) ?? []), doc]);
  for (const version of sorted) {
    add("history", version);
    for (const doc of docsByVersion.get(version.entry.version) ?? []) add("historyDocs", doc);
  }
  if (size > 0 || parts.length === 0) parts.push(current);
  return parts;
}

function historyAfter(bundle: BoardBundle, revision: number) {
  return bundle.history
    .filter(({ entry }) => entry.roadmapRevision > revision)
    .map(({ entry }) => ({ version: entry.version, createdAt: entry.createdAt, summary: entry.summary }));
}

/**
 * Take Online. Survives being killed at any point: a journal in the board's
 * folder records the upload, every step is idempotent under one transfer id,
 * and the board only becomes live online at commit. Running it again resumes.
 */
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
    let journal = await readJournal(state.planningRoot);
    if (journal && (journal.direction !== "online" || journal.url !== url || journal.boardId !== boardId)) {
      throw new PlanbanValidationError(`An unfinished transfer of this board to ${journal.url} is recorded at ${transferJournalPath(state.planningRoot)}. Finish it first.`);
    }
    if (journal?.phase === "uploading" && journal.localRevision !== bundle.roadmap.revision) {
      // The board changed locally since the interrupted upload: cancel it and upload the current board.
      // If the service says that upload already finished, the board is online:
      // keep the journal so the local changes since then are reported below.
      const finished = await onlineRequest(url, `/api/v1/transfers/${encodeURIComponent(journal.transferId)}/abort`, {})
        .then(() => false, (error) => error instanceof PlanbanConflictError);
      if (!finished) journal = null;
    }
    if (!journal) {
      journal = { version: 1, direction: "online", transferId: randomUUID(), url, boardId, localRevision: bundle.roadmap.revision, phase: "uploading", startedAt: new Date().toISOString() };
      await writeJournal(state.planningRoot, journal);
    }
    crashPoint("take-online:after-journal");
    let committedRoadmap: PlanbanResolvedState["roadmap"] | null = null;
    const begun = await onlineRequest<{ state: string; receivedParts: number[] }>(url, "/api/v1/transfers", {
      transferId: journal.transferId, roadmap: bundle.roadmap, retiredIds: bundle.retiredIds ?? [],
      ...(bundle.retention ? { retention: bundle.retention } : {}),
    });
    if (begun.state !== "committed") {
      const parts = uploadParts(bundle);
      const received = new Set(begun.receivedParts);
      for (const [seq, part] of parts.entries()) {
        if (received.has(seq)) continue;
        await onlineRequest(url, `/api/v1/transfers/${encodeURIComponent(journal.transferId)}/parts`, { seq, ...part });
        crashPoint("take-online:after-part");
      }
      committedRoadmap = (await onlineRequest<{ roadmap: PlanbanResolvedState["roadmap"] }>(url, `/api/v1/transfers/${encodeURIComponent(journal.transferId)}/commit`, { partCount: parts.length })).roadmap;
    }
    crashPoint("take-online:after-commit");
    // Edits made locally after an upload that had already committed are not online.
    const unsyncedLocalChanges = journal.localRevision === undefined ? [] : historyAfter(bundle, journal.localRevision);
    journal = { ...journal, phase: "committed" };
    await writeJournal(state.planningRoot, journal);
    committedRoadmap ??= (await onlineRequest<{ roadmap: PlanbanResolvedState["roadmap"] }>(url, boardPath(boardId))).roadmap;
    // Retain every local byte, but remove the live filename so other checkouts
    // with an old local manifest cannot continue editing the uploaded board.
    const snapshot = join(state.planningRoot, `roadmap.local-before-online-${Date.now()}.json`);
    if (await pathExists(state.roadmapPath)) await rename(state.roadmapPath, snapshot);
    await atomicWriteFile(join(state.planningRoot, "ONLINE-BOARD.txt"), `Authority moved to ${url}, board ${boardId}.\nThe roadmap snapshot, documents and history here are recovery evidence. Do not edit them.\n`);
    const manifest: PlanbanProjectManifest = { ...state.manifest, storage: { kind: "online", url, boardId } };
    await publishManifest(cwd, manifest, onlineState(cwd, manifest, committedRoadmap));
    crashPoint("take-online:after-publish");
    await rm(transferJournalPath(state.planningRoot), { force: true });
    await refreshBackup(url, boardId, { force: true });
    return { boardId, url, localSnapshot: snapshot, ...(unsyncedLocalChanges.length ? { unsyncedLocalChanges } : {}) };
  });
}

async function requireOnline(cwdInput: string) {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled || manifest.storage?.kind !== "online") throw new PlanbanValidationError("This project does not point to an Online Board.");
  return { cwd, manifest, storage: manifest.storage };
}

/** Downloads a board page by page; large boards do not fit in one response. */
export async function exportOnline(cwd: string, out?: string): Promise<BoardBundle> {
  const { storage } = await requireOnline(cwd);
  const base = boardPath(storage.boardId, "/export");
  const meta = await onlineRequest<{ roadmap: unknown; retiredIds: string[]; retention?: Record<string, unknown> }>(storage.url, `${base}/meta`);
  const docs: BoardBundle["docs"] = [];
  for (let offset: number | null = 0; offset !== null;) {
    const page: { docs: BoardBundle["docs"]; nextOffset: number | null } = await onlineRequest(storage.url, `${base}/docs?offset=${offset}&limit=${DOCS_PAGE}`);
    docs.push(...page.docs);
    offset = page.nextOffset;
  }
  const history: BoardBundle["history"] = [];
  const historyDocs: NonNullable<BoardBundle["historyDocs"]> = [];
  for (let after = 0; ;) {
    const page: { history: BoardBundle["history"]; historyDocs: NonNullable<BoardBundle["historyDocs"]> } = await onlineRequest(storage.url, `${base}/history?after=${after}&limit=${HISTORY_PAGE}`);
    if (page.history.length === 0) break;
    history.push(...page.history);
    historyDocs.push(...page.historyDocs);
    after = page.history.at(-1)!.entry.version;
    crashPoint("take-local:mid-download");
  }
  const bundle = bundleSchema.parse({
    format: "planban-board-bundle", version: 1, roadmap: meta.roadmap, docs, history, historyDocs, retiredIds: meta.retiredIds,
    ...(meta.retention ? { retention: meta.retention } : {}),
  });
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
    retention: { boardVersions: 100, cardVersions: 25, documentVersions: 25, hourlyDays: 2, maxAgeDays: 90, ...(bundle.retention ?? {}) },
    entries: bundle.history.map(({ entry }) => entry).sort((a, b) => a.version - b.version),
  });
  await writeJson(join(root, "roadmap.json"), roadmap);
  return roadmap;
}

/**
 * Take Local. The online board is frozen first, so no edit can land after the
 * download; then the board is written into a fresh local folder and only then
 * does the project switch to it. Killed at any point, running it again
 * resumes from the journal; the online board stays intact and read-only.
 */
export async function takeLocal(cwdInput: string) {
  const { cwd, manifest, storage } = await requireOnline(cwdInput);
  const lockRoot = resolvePlanningRoot(manifest);
  await mkdir(lockRoot, { recursive: true });
  return withBoardWriteLock(lockRoot, async () => {
    const current = await requireOnline(cwd);
    if (current.storage.url !== storage.url || current.storage.boardId !== storage.boardId) {
      throw new PlanbanValidationError("Board authority changed while waiting. Reload before taking it local.");
    }
    let journal = await readJournal(lockRoot);
    if (journal && (journal.direction !== "local" || journal.url !== storage.url || journal.boardId !== storage.boardId)) {
      throw new PlanbanValidationError(`An unfinished transfer is recorded at ${transferJournalPath(lockRoot)}. Finish it first.`);
    }
    if (!journal) {
      journal = { version: 1, direction: "local", transferId: randomUUID(), url: storage.url, boardId: storage.boardId,
        root: join(defaultPlanbanRoot(), "repos", `online-return-${randomUUID()}`), phase: "fenced", startedAt: new Date().toISOString() };
      await writeJournal(lockRoot, journal);
    }
    const root = journal.root!;
    crashPoint("take-local:before-fence");
    // Fence first: after this succeeds, every export describes a frozen board.
    await onlineRequest(storage.url, boardPath(storage.boardId, "/authority"), { state: "returned-local" });
    crashPoint("take-local:after-fence");
    const bundle = await exportOnline(cwd);
    // The folder is this transfer's own; a partial earlier attempt is replaced.
    await rm(root, { recursive: true, force: true });
    const roadmap = await stageBundle(root, bundle);
    crashPoint("take-local:after-stage");
    const localManifest: PlanbanProjectManifest = { ...manifest, storage: { kind: "local", root } };
    const state: PlanbanResolvedState = { cwd, manifest: localManifest, manifestPath: manifestPath(cwd),
      agentContextPath: agentContextPath(cwd), planningRoot: root, roadmapPath: join(root, "roadmap.json"), roadmap };
    await publishManifest(cwd, localManifest, state);
    await rm(transferJournalPath(lockRoot), { force: true });
    return { boardId: storage.boardId, planningRoot: root };
  });
}

export async function attachOnline(urlInput: string, boardId: string, cwdInput: string, options: { replaceStaleCopy?: boolean } = {}) {
  const url = serviceUrl(urlInput);
  const cwd = resolve(cwdInput);
  const existing = await readManifest(cwd);
  if (!boardId.trim()) throw new PlanbanValidationError("boardId is required.");
  let staleCopy: { snapshot: string; report: string; unsyncedChanges: StaleCopy["unsyncedChanges"] } | undefined;
  if (existing && (existing.storage?.kind !== "online" || existing.storage.url !== url || existing.storage.boardId !== boardId)) {
    const planningRoot = existing.storage?.kind === "online" ? null : resolvePlanningRoot(existing);
    const marker = planningRoot ? await readStaleMarker(planningRoot) : null;
    if (!options.replaceStaleCopy || !marker || marker.url !== url || marker.boardId !== boardId) {
      throw new PlanbanValidationError("This directory already has a different board. Use an empty directory or its existing board transfer command.");
    }
    // Check the online board is reachable before setting the local copy aside.
    await loadOnlineState(cwd, { version: 1, enabled: true, repoId: boardId, storage: { kind: "online", url, boardId } });
    staleCopy = await setStaleCopyAside(planningRoot!, marker);
  }
  const manifest: PlanbanProjectManifest = { version: 1, enabled: true, repoId: boardId, storage: { kind: "online", url, boardId } };
  const state = await loadOnlineState(cwd, manifest);
  await mkdir(dirname(manifestPath(cwd)), { recursive: true });
  await publishManifest(cwd, manifest, state);
  await refreshBackup(url, boardId, { force: true });
  return { boardId, url, cwd, ...(staleCopy ? { staleCopy } : {}) };
}

/**
 * The stale copy stays on disk as recovery evidence, with a report of the
 * changes that never reached the online board; its live roadmap file is
 * renamed so nothing edits it by accident.
 */
async function setStaleCopyAside(planningRoot: string, marker: StaleCopy) {
  return withBoardWriteLock(planningRoot, async () => {
    const stamp = Date.now();
    const snapshot = join(planningRoot, `roadmap.stale-copy-${stamp}.json`);
    if (await pathExists(join(planningRoot, "roadmap.json"))) await rename(join(planningRoot, "roadmap.json"), snapshot);
    const report = join(planningRoot, `STALE-COPY-REPORT-${stamp}.md`);
    await atomicWriteFile(report, [
      "# Stale local copy set aside",
      "",
      `This board was taken online as "${marker.title}" (${marker.boardId} at ${marker.url}). This machine's local copy was set aside on ${new Date(stamp).toISOString()}.`,
      `The roadmap as it was is in ${snapshot}; its documents and history are in this folder.`,
      "",
      marker.unsyncedChanges.length
        ? "Changes made here that never reached the online board (re-apply any you still want):"
        : "Every change in this copy had already reached the online board.",
      ...marker.unsyncedChanges.map((change) => `- v${change.version}, ${change.createdAt}: ${change.summary}`),
      "",
    ].join("\n"));
    await atomicWriteFile(join(planningRoot, "ONLINE-BOARD.txt"), `Authority moved to ${marker.url}, board ${marker.boardId}.\nThe files here are recovery evidence. Do not edit them.\n`);
    return { snapshot, report, unsyncedChanges: marker.unsyncedChanges };
  });
}

/**
 * Keep a stale copy as its own local board, under a new id, never flagged
 * against that online board again. Its changes stay where they are.
 */
export async function keepLocalCopy(cwdInput: string, newId: string, title?: string) {
  const cwd = resolveProjectCwd(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest?.enabled || manifest.storage?.kind === "online") throw new PlanbanValidationError("This project does not hold a local board.");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(newId) || newId === manifest.repoId) throw new PlanbanValidationError("Choose a new board id: lowercase letters, digits and dashes.");
  const planningRoot = resolvePlanningRoot(manifest);
  const marker = await readStaleMarker(planningRoot);
  if (!marker) throw new PlanbanValidationError("This board is not marked as a stale copy of an Online Board.");
  await markIndependent(planningRoot, marker);
  const localManifest: PlanbanProjectManifest = { ...manifest, repoId: newId, storage: { kind: "local", root: planningRoot } };
  await writeJson(manifestPath(cwd), localManifest);
  const state = await loadState(cwd);
  const roadmap = { ...state.roadmap, project: { ...state.roadmap.project, id: newId, title: title ?? `${state.roadmap.project.title} (local copy)` } };
  const saved = await saveRoadmap(state, roadmap, { actor: "user", operation: "board.keep-local-copy", summary: `Kept as a separate local board after ${marker.boardId} went online`, affectedCards: [] });
  await publishManifest(cwd, localManifest, { ...state, roadmap: saved });
  return { repoId: newId, planningRoot, unsyncedChanges: marker.unsyncedChanges };
}

/** Turns a backup folder (its latest copy, or one day's) into a new local board. */
export async function restoreBackup(folder: string, cwdInput: string, repoId: string) {
  const cwd = resolve(cwdInput);
  if (await readManifest(cwd)) throw new PlanbanValidationError("This directory already has a board. Restore into an empty directory.");
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(repoId)) throw new PlanbanValidationError("Choose a board id: lowercase letters, digits and dashes.");
  const root = join(defaultPlanbanRoot(), "repos", repoId);
  if (await pathExists(root)) throw new PlanbanValidationError(`A local board folder already exists at ${root}. Choose another id.`);
  const { roadmap, docs } = await readBackup(folder);
  const restored = await stageBundle(root, bundleSchema.parse({
    format: "planban-board-bundle", version: 1, roadmap: { ...roadmap, project: { ...roadmap.project, id: repoId } }, docs, history: [],
  }));
  const manifest: PlanbanProjectManifest = { version: 1, enabled: true, repoId, storage: { kind: "local", root } };
  await mkdir(dirname(manifestPath(cwd)), { recursive: true });
  await publishManifest(cwd, manifest, { cwd, manifest, manifestPath: manifestPath(cwd), agentContextPath: agentContextPath(cwd), planningRoot: root, roadmapPath: join(root, "roadmap.json"), roadmap: restored });
  return { repoId, planningRoot: root, cards: restored.roadmapItems.length, docs: docs.length };
}
