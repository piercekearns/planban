import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boardBackupsRoot, defaultPlanningRoot, expandHome, manifestPath, registryPath, roadmapPath } from "./paths";
import { manifestSchema } from "./schema";
import type { PlanbanBoardRecord, PlanbanBoardRegistry, PlanbanResolvedState } from "./types";

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
