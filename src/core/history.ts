import { cp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  historyDocPath,
  historyIndexPath,
  historyRoadmapPath,
  historyRoot,
  historyVersionRoot,
  PlanbanPathError,
  resolveInsideRoot,
} from "./paths";
import { atomicWriteFile, withBoardWriteLock } from "./persistence";
import { roadmapSchema } from "./schema";
import type {
  PlanbanDocPayload,
  PlanbanHistoryActor,
  PlanbanHistoryDocRef,
  PlanbanHistoryEntry,
  PlanbanHistoryIndex,
  PlanbanHistoryPayload,
  PlanbanResolvedState,
  PlanbanRoadmap,
  PlanbanRoadmapItem,
} from "./types";

const HISTORY_RETENTION = {
  boardVersions: 100,
  cardVersions: 25,
  documentVersions: 25,
  maxAgeDays: 90,
};

export interface PlanbanHistoryMeta {
  actor?: PlanbanHistoryActor | undefined;
  operation: string;
  summary: string;
  affectedCards?: string[] | undefined;
  affectedDocs?: PlanbanHistoryDocRef[] | undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeHistoryRoadmap(input: unknown): PlanbanRoadmap {
  const parsed = roadmapSchema.parse(input);
  return {
    ...parsed,
    roadmapItems: parsed.roadmapItems.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      summary: item.summary,
      nextAction: item.nextAction,
      tags: item.tags,
      icon: item.icon,
      blockedBy: item.blockedBy,
      specDoc: item.specDoc,
      planDoc: item.planDoc,
      completedAt: item.completedAt,
      updatedAt: item.updatedAt,
      ...(item.metadata ? { metadata: item.metadata } : {}),
    })),
  };
}

function emptyIndex(): PlanbanHistoryIndex {
  return {
    version: 1,
    latestVersion: 0,
    retention: HISTORY_RETENTION,
    entries: [],
  };
}

async function readHistoryIndex(planningRoot: string): Promise<PlanbanHistoryIndex> {
  const path = historyIndexPath(planningRoot);
  if (!(await pathExists(path))) return emptyIndex();
  const payload = (await readJson(path)) as PlanbanHistoryIndex;
  return {
    version: 1,
    latestVersion: payload.latestVersion ?? 0,
    retention: { ...HISTORY_RETENTION, ...(payload.retention ?? {}) },
    entries: Array.isArray(payload.entries) ? payload.entries : [],
  };
}

async function writeHistoryIndex(planningRoot: string, index: PlanbanHistoryIndex) {
  await mkdir(dirname(historyIndexPath(planningRoot)), { recursive: true });
  await atomicWriteFile(historyIndexPath(planningRoot), JSON.stringify(index, null, 2) + "\n");
}

function docRefsForRoadmap(roadmap: PlanbanRoadmap): PlanbanHistoryDocRef[] {
  return roadmap.roadmapItems.flatMap((item) => {
    const refs: PlanbanHistoryDocRef[] = [];
    if (item.specDoc) refs.push({ cardId: item.id, kind: "spec", path: item.specDoc });
    if (item.planDoc) refs.push({ cardId: item.id, kind: "plan", path: item.planDoc });
    return refs;
  });
}

async function copyHistoryDoc(state: PlanbanResolvedState, version: number, doc: PlanbanHistoryDocRef) {
  if (!doc.path) return;
  let source: string;
  try {
    source = resolveInsideRoot(state.planningRoot, doc.path, `${doc.kind} history document path for ${doc.cardId}`);
  } catch (error) {
    if (error instanceof PlanbanPathError) return;
    throw error;
  }
  if (!(await pathExists(source))) return;
  const target = historyDocPath(state.planningRoot, version, doc.cardId, doc.kind);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { force: true });
}

async function writeVersionFiles(
  state: PlanbanResolvedState,
  version: number,
  roadmap: PlanbanRoadmap,
  docs: PlanbanHistoryDocRef[],
) {
  await mkdir(historyVersionRoot(state.planningRoot, version), { recursive: true });
  await atomicWriteFile(historyRoadmapPath(state.planningRoot, version), JSON.stringify(roadmap, null, 2) + "\n");
  for (const doc of docs) await copyHistoryDoc(state, version, doc);
}

async function pruneHistory(planningRoot: string, index: PlanbanHistoryIndex): Promise<PlanbanHistoryIndex> {
  const cutoff = Date.now() - index.retention.maxAgeDays * 24 * 60 * 60 * 1000;
  const byVersionDesc = [...index.entries].sort((a, b) => b.version - a.version);
  const kept = byVersionDesc
    .filter((entry, position) => position < index.retention.boardVersions || Date.parse(entry.createdAt) >= cutoff)
    .sort((a, b) => a.version - b.version);
  const keptVersions = new Set(kept.map((entry) => entry.version));

  for (const entry of index.entries) {
    if (!keptVersions.has(entry.version)) {
      await rm(historyVersionRoot(planningRoot, entry.version), { recursive: true, force: true });
    }
  }

  return {
    ...index,
    latestVersion: kept.at(-1)?.version ?? 0,
    entries: kept,
  };
}

export async function ensureHistoryBaseline(state: PlanbanResolvedState): Promise<PlanbanHistoryIndex> {
  return withBoardWriteLock(state.planningRoot, async () => {
  let index = await readHistoryIndex(state.planningRoot);
  if (index.entries.length > 0) return index;

  const docs = docRefsForRoadmap(state.roadmap);
  const entry: PlanbanHistoryEntry = {
    version: 1,
    roadmapRevision: state.roadmap.revision,
    createdAt: nowIso(),
    actor: "system",
    operation: "baseline",
    summary: "Initial Planban history baseline",
    affectedCards: state.roadmap.roadmapItems.map((item) => item.id),
    affectedDocs: docs,
  };
  await writeVersionFiles(state, 1, state.roadmap, docs);
  index = {
    ...index,
    latestVersion: 1,
    entries: [entry],
  };
  await writeHistoryIndex(state.planningRoot, index);
  return index;
  });
}

export async function recordHistoryVersion(
  state: PlanbanResolvedState,
  roadmap: PlanbanRoadmap,
  meta: PlanbanHistoryMeta,
): Promise<PlanbanHistoryEntry> {
  return withBoardWriteLock(state.planningRoot, async () => {
  const baseline = await ensureHistoryBaseline(state);
  let index = await readHistoryIndex(state.planningRoot);
  const nextVersion = Math.max(baseline.latestVersion, index.latestVersion) + 1;
  const affectedDocs = meta.affectedDocs ?? [];
  const entry: PlanbanHistoryEntry = {
    version: nextVersion,
    roadmapRevision: roadmap.revision,
    createdAt: nowIso(),
    actor: meta.actor ?? "user",
    operation: meta.operation,
    summary: meta.summary,
    affectedCards: [...new Set(meta.affectedCards ?? [])],
    affectedDocs,
  };

  await writeVersionFiles(state, nextVersion, roadmap, affectedDocs);
  index = {
    ...index,
    latestVersion: nextVersion,
    entries: [...index.entries, entry],
  };
  index = await pruneHistory(state.planningRoot, index);
  await writeHistoryIndex(state.planningRoot, index);
  return entry;
  });
}

export async function listHistory(state: PlanbanResolvedState): Promise<PlanbanHistoryPayload> {
  const index = await ensureHistoryBaseline(state);
  return {
    currentVersion: index.latestVersion,
    retention: index.retention,
    entries: [...index.entries].sort((a, b) => b.version - a.version),
  };
}

export async function readHistoryRoadmap(state: PlanbanResolvedState, version: number): Promise<PlanbanRoadmap> {
  await ensureHistoryBaseline(state);
  const path = historyRoadmapPath(state.planningRoot, version);
  if (!(await pathExists(path))) throw new Error(`History version not found: v${version}`);
  return normalizeHistoryRoadmap(await readJson(path));
}

export async function resolveHistoryDoc(
  state: PlanbanResolvedState,
  version: number,
  cardId: string,
  kind: "spec" | "plan",
): Promise<PlanbanDocPayload> {
  const history = await listHistory(state);
  const candidates = history.entries
    .filter((entry) => entry.version <= version)
    .filter((entry) => entry.affectedDocs.some((doc) => doc.cardId === cardId && doc.kind === kind))
    .sort((a, b) => b.version - a.version)
    .slice(0, history.retention.documentVersions);

  for (const entry of candidates) {
    const path = historyDocPath(state.planningRoot, entry.version, cardId, kind);
    if (!(await pathExists(path))) continue;
    const stats = await stat(path);
    return {
      cardId,
      kind,
      path,
      exists: true,
      markdown: await readFile(path, "utf8"),
      mtimeMs: stats.mtimeMs,
    };
  }

  return { cardId, kind, path: null, exists: false, markdown: "", mtimeMs: null };
}

export async function restoreRoadmapFromHistory(input: {
  state: PlanbanResolvedState;
  version: number;
  actor?: PlanbanHistoryActor | undefined;
}): Promise<PlanbanRoadmap> {
  const snapshot = await readHistoryRoadmap(input.state, input.version);
  return {
    ...snapshot,
    revision: input.state.roadmap.revision,
  };
}

export async function restoreCardFromHistory(input: {
  state: PlanbanResolvedState;
  version: number;
  cardId: string;
}): Promise<PlanbanRoadmapItem> {
  const snapshot = await readHistoryRoadmap(input.state, input.version);
  const item = snapshot.roadmapItems.find((entry) => entry.id === input.cardId);
  if (!item) throw new Error(`Card ${input.cardId} does not exist in v${input.version}`);
  return item;
}
