import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  agentContextPath,
  boardBackupsRoot,
  defaultPlanningRoot,
  detachedBoardCwd,
  eventsPath,
  expandHome,
  manifestPath,
  registryPath,
  roadmapPath,
  slugify,
} from "./paths";
import { ensureHistoryBaseline, recordHistoryVersion } from "./history";
import { atomicWriteFile, appendLineDurably, withBoardWriteLock } from "./persistence";
import { buildAgentContext } from "./protocol";
import { manifestSchema, roadmapSchema } from "./schema";
import type { PlanbanBoardRecord, PlanbanBoardRegistry, PlanbanProjectManifest, PlanbanResolvedState, PlanbanRoadmap, PlanbanStatus } from "./types";
import { PLANBAN_STATUSES } from "./types";

const boardRecordSchema = z.object({
  repoId: z.string().min(1),
  title: z.string().min(1),
  cwd: z.string().min(1),
  planningRoot: z.string().min(1),
  roadmapPath: z.string().min(1),
  manifestPath: z.string().min(1),
  kind: z.enum(["project", "demo"]).optional(),
  archivedAt: z.string().min(1).nullable().optional(),
  lastOpenedAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const registrySchema = z.object({
  version: z.literal(1),
  boards: z.array(boardRecordSchema).default([]),
});

function nowIso() {
  return new Date().toISOString();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(cwd: string) {
  const path = manifestPath(cwd);
  if (!(await pathExists(path))) return null;
  return manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function resolvePlanningRoot(manifest: { repoId: string; storage?: { root?: string | undefined } | undefined }) {
  return manifest.storage?.root
    ? resolve(expandHome(manifest.storage.root))
    : defaultPlanningRoot(manifest.repoId);
}

async function readRegistryFile(): Promise<PlanbanBoardRegistry> {
  const path = registryPath();
  if (!(await pathExists(path))) return { version: 1, boards: [] };
  const parsed = registrySchema.parse(JSON.parse(await readFile(path, "utf8")));
  return {
    version: 1,
    boards: parsed.boards.map((board) => {
      const record: PlanbanBoardRecord = {
        repoId: board.repoId,
        title: board.title,
        cwd: board.cwd,
        planningRoot: board.planningRoot,
        roadmapPath: board.roadmapPath,
        manifestPath: board.manifestPath,
        lastOpenedAt: board.lastOpenedAt,
        updatedAt: board.updatedAt,
      };
      if (board.kind) record.kind = board.kind;
      if (board.archivedAt !== undefined) record.archivedAt = board.archivedAt;
      return record;
    }),
  };
}

async function writeRegistryFile(registry: PlanbanBoardRegistry) {
  const path = registryPath();
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, JSON.stringify(registry, null, 2) + "\n", "utf8");
  await rename(tempPath, path);
}

export async function listBoards(): Promise<PlanbanBoardRecord[]> {
  const registry = await readRegistryFile();
  return registry.boards
    .filter((board) => !board.archivedAt)
    .slice()
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt) || a.title.localeCompare(b.title));
}

export async function listAllBoards(): Promise<PlanbanBoardRecord[]> {
  const registry = await readRegistryFile();
  return registry.boards
    .slice()
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt) || a.title.localeCompare(b.title));
}

export async function registerBoardFromState(
  state: PlanbanResolvedState,
  options: { kind?: PlanbanBoardRecord["kind"] } = {},
): Promise<PlanbanBoardRecord> {
  const timestamp = nowIso();
  const registry = await readRegistryFile();
  const existing = registry.boards.find((board) => board.repoId === state.manifest.repoId);
  const record: PlanbanBoardRecord = {
    repoId: state.manifest.repoId,
    title: state.roadmap.project.title,
    cwd: state.cwd,
    planningRoot: state.planningRoot,
    roadmapPath: state.roadmapPath,
    manifestPath: state.manifestPath,
    kind: options.kind ?? existing?.kind ?? "project",
    archivedAt: null,
    lastOpenedAt: timestamp,
    updatedAt: timestamp,
  };

  const boards = existing
    ? registry.boards.map((board) =>
        board.repoId === record.repoId
          ? { ...board, ...record, lastOpenedAt: record.lastOpenedAt, archivedAt: null }
          : board,
      )
    : [...registry.boards, record];
  await writeRegistryFile({ version: 1, boards });
  return record;
}

export async function touchBoard(repoId: string): Promise<void> {
  const registry = await readRegistryFile();
  const timestamp = nowIso();
  await writeRegistryFile({
    version: 1,
    boards: registry.boards.map((board) =>
      board.repoId === repoId ? { ...board, lastOpenedAt: timestamp } : board,
    ),
  });
}

export async function archiveBoard(repoId: string): Promise<PlanbanBoardRecord> {
  const registry = await readRegistryFile();
  const existing = registry.boards.find((board) => board.repoId === repoId);
  if (!existing) throw new Error(`Planban board not found: ${repoId}`);
  const timestamp = nowIso();
  const archived = { ...existing, archivedAt: existing.archivedAt ?? timestamp, updatedAt: timestamp };
  await writeRegistryFile({
    version: 1,
    boards: registry.boards.map((board) => (board.repoId === repoId ? archived : board)),
  });
  return archived;
}

export async function restoreBoard(repoId: string): Promise<PlanbanBoardRecord> {
  const registry = await readRegistryFile();
  const existing = registry.boards.find((board) => board.repoId === repoId);
  if (!existing) throw new Error(`Planban board not found: ${repoId}`);
  const timestamp = nowIso();
  const restored = { ...existing, archivedAt: null, lastOpenedAt: timestamp, updatedAt: timestamp };
  await writeRegistryFile({
    version: 1,
    boards: registry.boards.map((board) => (board.repoId === repoId ? restored : board)),
  });
  return restored;
}

function safeTimestamp(timestamp: string) {
  return timestamp.replace(/[:.]/g, "-");
}

function uniqueDuplicateRepoId(registry: PlanbanBoardRegistry, preferred: string) {
  const taken = new Set(registry.boards.map((board) => board.repoId));
  const base = slugify(preferred);
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function duplicateTitle(sourceTitle: string, requestedTitle?: string) {
  const trimmed = requestedTitle?.trim();
  return trimmed ? trimmed : `${sourceTitle} Copy`;
}

function duplicateRoadmap(source: PlanbanRoadmap, input: { repoId: string; title: string; timestamp: string }): PlanbanRoadmap {
  return {
    ...source,
    revision: 1,
    updatedAt: input.timestamp,
    project: {
      ...source.project,
      id: input.repoId,
      title: input.title,
    },
  };
}

const STATUS_LABELS: Record<PlanbanStatus, string> = {
  "in-progress": "In Progress",
  "up-next": "Up Next",
  pending: "Pending",
  complete: "Complete",
  archived: "Archived",
};

function normalizeSourceRoadmap(input: unknown): PlanbanRoadmap {
  const parsed = roadmapSchema.parse(input);
  return {
    ...parsed,
    columns: parsed.columns.length > 0
      ? parsed.columns
      : PLANBAN_STATUSES.map((id) => ({ id, label: STATUS_LABELS[id] })),
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

export async function duplicateBoard(input: {
  sourceRepoId: string;
  repoId?: string | undefined;
  title?: string | undefined;
}): Promise<{ source: PlanbanBoardRecord; board: PlanbanBoardRecord }> {
  const registry = await readRegistryFile();
  const source = registry.boards.find((board) => board.repoId === input.sourceRepoId);
  if (!source) throw new Error(`Planban board not found: ${input.sourceRepoId}`);
  if (!(await pathExists(source.roadmapPath))) {
    throw new Error(`Planban roadmap is missing at ${source.roadmapPath}`);
  }

  const sourceRoadmap = normalizeSourceRoadmap(JSON.parse(await readFile(source.roadmapPath, "utf8")));
  const title = duplicateTitle(sourceRoadmap.project.title, input.title);
  const explicitRepoId = input.repoId?.trim() ? slugify(input.repoId) : null;
  if (explicitRepoId && registry.boards.some((board) => board.repoId === explicitRepoId)) {
    throw new Error(`Planban board already exists: ${explicitRepoId}`);
  }
  const repoId = explicitRepoId ?? uniqueDuplicateRepoId(registry, `${source.repoId}-copy`);
  const timestamp = nowIso();
  const planningRoot = defaultPlanningRoot(repoId);
  const cwd = detachedBoardCwd(repoId);
  const liveRoadmapPath = roadmapPath(planningRoot);
  const sourceItemsRoot = join(source.planningRoot, "items");
  const targetItemsRoot = join(planningRoot, "items");
  const manifest: PlanbanProjectManifest = {
    version: 1,
    repoId,
    enabled: true,
    storage: { kind: "local" },
  };

  if (await pathExists(planningRoot)) throw new Error(`Planban planning root already exists for ${repoId}: ${planningRoot}`);
  if (await pathExists(cwd)) throw new Error(`Planban detached board workspace already exists for ${repoId}: ${cwd}`);

  try {
    return await withBoardWriteLock(planningRoot, async () => {
      await mkdir(planningRoot, { recursive: true });
      await mkdir(join(cwd, ".planban"), { recursive: true });
      if (await pathExists(sourceItemsRoot)) {
        await cp(sourceItemsRoot, targetItemsRoot, { recursive: true, force: false, errorOnExist: true });
      }

      const roadmap = duplicateRoadmap(sourceRoadmap, { repoId, title, timestamp });
      await atomicWriteFile(liveRoadmapPath, JSON.stringify(roadmap, null, 2) + "\n");
      await atomicWriteFile(manifestPath(cwd), JSON.stringify(manifest, null, 2) + "\n");
      await atomicWriteFile(
        agentContextPath(cwd),
        buildAgentContext({
          planningRoot,
          roadmapPath: liveRoadmapPath,
          manifestPath: manifestPath(cwd),
        }),
      );
      await appendLineDurably(eventsPath(planningRoot), JSON.stringify({
        type: "board.duplicated",
        at: timestamp,
        sourceRepoId: source.repoId,
        repoId,
        title,
      }) + "\n");

      const state: PlanbanResolvedState = {
        cwd,
        manifestPath: manifestPath(cwd),
        agentContextPath: agentContextPath(cwd),
        planningRoot,
        roadmapPath: liveRoadmapPath,
        manifest,
        roadmap,
      };
      await ensureHistoryBaseline(state);
      await recordHistoryVersion(state, roadmap, {
        actor: "system",
        operation: "board.duplicate",
        summary: `Duplicated board from ${source.repoId}`,
        affectedCards: roadmap.roadmapItems.map((item) => item.id),
      });

      const freshRegistry = await readRegistryFile();
      const record: PlanbanBoardRecord = {
        repoId,
        title,
        cwd,
        planningRoot,
        roadmapPath: liveRoadmapPath,
        manifestPath: manifestPath(cwd),
        kind: source.kind === "demo" ? "project" : source.kind ?? "project",
        archivedAt: null,
        lastOpenedAt: timestamp,
        updatedAt: timestamp,
      };
      await writeRegistryFile({ version: 1, boards: [...freshRegistry.boards, record] });
      return { source, board: record };
    });
  } catch (error) {
    await rm(planningRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function deleteBoard(repoId: string): Promise<{ repoId: string; backupPath: string | null }> {
  const registry = await readRegistryFile();
  const existing = registry.boards.find((board) => board.repoId === repoId);
  if (!existing) throw new Error(`Planban board not found: ${repoId}`);

  const timestamp = nowIso();
  let backupPath: string | null = null;
  if (await pathExists(existing.planningRoot)) {
    backupPath = join(boardBackupsRoot(), `${repoId}-${safeTimestamp(timestamp)}-${basename(existing.planningRoot)}`);
    await mkdir(dirname(backupPath), { recursive: true });
    await cp(existing.planningRoot, backupPath, { recursive: true, force: false, errorOnExist: true });
    await rm(existing.planningRoot, { recursive: true, force: true });
  }

  await writeRegistryFile({
    version: 1,
    boards: registry.boards.filter((board) => board.repoId !== repoId),
  });
  return { repoId, backupPath };
}

export async function registerBoardFromCwd(cwdInput: string): Promise<PlanbanBoardRecord | null> {
  const cwd = resolve(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest || !manifest.enabled) return null;
  const planningRoot = resolvePlanningRoot(manifest);
  const liveRoadmapPath = roadmapPath(planningRoot);
  if (!(await pathExists(liveRoadmapPath))) return null;
  const raw = JSON.parse(await readFile(liveRoadmapPath, "utf8")) as { project?: { title?: unknown } };
  const timestamp = nowIso();
  const registry = await readRegistryFile();
  const existing = registry.boards.find((board) => board.repoId === manifest.repoId);
  const record: PlanbanBoardRecord = {
    repoId: manifest.repoId,
    title: typeof raw.project?.title === "string" ? raw.project.title : manifest.repoId,
    cwd,
    planningRoot,
    roadmapPath: liveRoadmapPath,
    manifestPath: manifestPath(cwd),
    kind: existing?.kind ?? "project",
    archivedAt: null,
    lastOpenedAt: timestamp,
    updatedAt: timestamp,
  };

  const boards = registry.boards.some((board) => board.repoId === record.repoId)
    ? registry.boards.map((board) => (board.repoId === record.repoId ? { ...board, ...record } : board))
    : [...registry.boards, record];
  await writeRegistryFile({ version: 1, boards });
  return record;
}

export async function resolveBoardCwd(repoId: string): Promise<string> {
  const boards = await listBoards();
  const board = boards.find((entry) => entry.repoId === repoId);
  if (!board) throw new Error(`Planban board not found: ${repoId}`);
  return board.cwd;
}
