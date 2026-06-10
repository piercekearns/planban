import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defaultPlanningRoot, expandHome, manifestPath, registryPath, roadmapPath } from "./paths";
import { manifestSchema } from "./schema";
import type { PlanbanBoardRecord, PlanbanBoardRegistry, PlanbanResolvedState } from "./types";

const boardRecordSchema = z.object({
  repoId: z.string().min(1),
  title: z.string().min(1),
  cwd: z.string().min(1),
  planningRoot: z.string().min(1),
  roadmapPath: z.string().min(1),
  manifestPath: z.string().min(1),
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
  return registrySchema.parse(JSON.parse(await readFile(path, "utf8")));
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
    .slice()
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt) || a.title.localeCompare(b.title));
}

export async function registerBoardFromState(state: PlanbanResolvedState): Promise<PlanbanBoardRecord> {
  const timestamp = nowIso();
  const record: PlanbanBoardRecord = {
    repoId: state.manifest.repoId,
    title: state.roadmap.project.title,
    cwd: state.cwd,
    planningRoot: state.planningRoot,
    roadmapPath: state.roadmapPath,
    manifestPath: state.manifestPath,
    lastOpenedAt: timestamp,
    updatedAt: timestamp,
  };

  const registry = await readRegistryFile();
  const existing = registry.boards.find((board) => board.repoId === record.repoId);
  const boards = existing
    ? registry.boards.map((board) =>
        board.repoId === record.repoId
          ? { ...board, ...record, lastOpenedAt: record.lastOpenedAt }
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

export async function registerBoardFromCwd(cwdInput: string): Promise<PlanbanBoardRecord | null> {
  const cwd = resolve(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest || !manifest.enabled) return null;
  const planningRoot = resolvePlanningRoot(manifest);
  const liveRoadmapPath = roadmapPath(planningRoot);
  if (!(await pathExists(liveRoadmapPath))) return null;
  const raw = JSON.parse(await readFile(liveRoadmapPath, "utf8")) as { project?: { title?: unknown } };
  const timestamp = nowIso();
  const record: PlanbanBoardRecord = {
    repoId: manifest.repoId,
    title: typeof raw.project?.title === "string" ? raw.project.title : manifest.repoId,
    cwd,
    planningRoot,
    roadmapPath: liveRoadmapPath,
    manifestPath: manifestPath(cwd),
    lastOpenedAt: timestamp,
    updatedAt: timestamp,
  };

  const registry = await readRegistryFile();
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
