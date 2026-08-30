import { cp, mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ensureHistoryBaseline,
  recordHistoryVersion,
  resolveHistoryDoc,
  restoreCardFromHistory,
  restoreRoadmapFromHistory,
  type PlanbanHistoryMeta,
} from "./history";
import {
  agentContextPath,
  defaultPlanningRoot,
  defaultRepoId,
  eventsPath,
  expandHome,
  itemRoot,
  historyDocPath,
  historyRoot,
  manifestPath,
  resolveInsideRoot,
  slugify,
  protocolDir,
  roadmapPath,
} from "./paths";
import { appendLineDurably, atomicWriteFile, withBoardWriteLock } from "./persistence";
import { buildAgentContext } from "./protocol";
import { registerBoardFromState } from "./registry";
import { manifestSchema, roadmapSchema } from "./schema";
import type {
  PlanbanDocPayload,
  PlanbanProjectManifest,
  PlanbanResolvedState,
  PlanbanRoadmap,
  PlanbanRoadmapItem,
  PlanbanStatus,
  PlanbanHistoryActor,
} from "./types";
import { PLANBAN_STATUSES } from "./types";
import { currentVersionInfo } from "./version";
import { flattenRoadmapForVersion1, hierarchyRecoveryManifest } from "./hierarchyMigration";

const STATUS_LABELS: Record<PlanbanStatus, string> = {
  "in-progress": "In Progress",
  "up-next": "Up Next",
  pending: "Pending",
  complete: "Complete",
  archived: "Archived",
};

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class PlanbanConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanConflictError";
  }
}

export class PlanbanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanValidationError";
  }
}

export class PlanbanNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanNotFoundError";
  }
}

function assertBaseRevision(state: PlanbanResolvedState, baseRevision?: number) {
  if (baseRevision !== undefined && (!Number.isInteger(baseRevision) || baseRevision < 0)) {
    throw new PlanbanValidationError("baseRevision must be a non-negative integer.");
  }
  if (baseRevision !== undefined && baseRevision !== state.roadmap.revision) {
    throw new PlanbanConflictError(
      `Roadmap changed from revision ${baseRevision} to ${state.roadmap.revision}. Reload before saving.`,
    );
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function nowIso(): string {
  return new Date().toISOString();
}

export function defaultColumns() {
  return PLANBAN_STATUSES.map((id) => ({ id, label: STATUS_LABELS[id] }));
}

export function normalizeRoadmap(input: unknown): PlanbanRoadmap {
  const parsed = roadmapSchema.parse(input);
  const roadmap: PlanbanRoadmap = {
    ...parsed,
    writerVersion: parsed.version === 2 ? parsed.writerVersion : 0,
    columns: parsed.columns.length > 0 ? parsed.columns : defaultColumns(),
    roadmapItems: parsed.roadmapItems.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      summary: item.summary,
      nextAction: item.nextAction,
      tags: item.tags,
      icon: item.icon,
      blockedBy: item.blockedBy?.trim() || null,
      specDoc: item.specDoc,
      planDoc: item.planDoc,
      completedAt: item.completedAt,
      updatedAt: item.updatedAt,
      isGroup: parsed.version === 2
        ? parsed.writerVersion >= 6
          ? "isGroup" in item && item.isGroup === true
          : "isProgramme" in item && item.isProgramme === true
        : false,
      parentId: parsed.version === 2 && parsed.writerVersion >= 2 ? item.parentId as string | null : null,
      boardRank: parsed.version === 2 && parsed.writerVersion >= 2
        ? item.boardRank as number | null
        : item.priority,
      groupRank: parsed.version === 2 && parsed.writerVersion >= 2
        ? parsed.writerVersion >= 6
          ? "groupRank" in item ? item.groupRank as number | null : null
          : "programmeRank" in item ? item.programmeRank as number | null : null
        : null,
      ...(item.metadata ? { metadata: item.metadata } : {}),
    })),
  };
  if (parsed.version === 1 || parsed.writerVersion < 6) {
    roadmap.roadmapItems = assignHierarchyRanks(roadmap.roadmapItems);
  }
  assertRoadmapRelations(roadmap);
  return roadmap;
}

function assertRoadmapRelations(roadmap: PlanbanRoadmap): void {
  const byId = new Map(roadmap.roadmapItems.map((item) => [item.id, item]));
  if (byId.size !== roadmap.roadmapItems.length) {
    throw new PlanbanValidationError("Work Item ids must be unique.");
  }
  for (const item of roadmap.roadmapItems) {
    if (item.isGroup && item.parentId !== null) {
      throw new PlanbanValidationError(`Group ${item.id} must remain on the Main Board.`);
    }
    if (item.parentId === null) {
      if (!Number.isInteger(item.boardRank) || (item.boardRank ?? 0) < 1 || item.groupRank !== null) {
        throw new PlanbanValidationError(`Root ${item.id} must have a positive Board Rank and no Group Rank.`);
      }
    } else if (!Number.isInteger(item.groupRank) || (item.groupRank ?? 0) < 1 || item.boardRank !== null) {
      throw new PlanbanValidationError(`Owned item ${item.id} must have a positive Group Rank and no Board Rank.`);
    }
    if (item.parentId !== null && !byId.has(item.parentId)) {
      throw new PlanbanValidationError(`Parent not found for ${item.id}: ${item.parentId}`);
    }
    if (item.parentId !== null && byId.get(item.parentId)?.isGroup !== true) {
      throw new PlanbanValidationError(`Parent ${item.parentId} must have the Group role.`);
    }
    if (item.parentId === item.id) throw new PlanbanValidationError(`${item.id} cannot parent itself.`);
    if (item.blockedBy !== null && !byId.has(item.blockedBy)) {
      throw new PlanbanValidationError(`Dependency not found for ${item.id}: ${item.blockedBy}`);
    }
    if (item.blockedBy === item.id) throw new PlanbanValidationError(`${item.id} cannot block itself.`);
    for (const relation of ["parentId", "blockedBy"] as const) {
      const seen = new Set([item.id]);
      let cursor = item[relation];
      while (cursor) {
        if (seen.has(cursor)) throw new PlanbanValidationError(`${relation === "parentId" ? "Hierarchy" : "Dependency"} cycle detected at ${item.id}.`);
        seen.add(cursor);
        cursor = byId.get(cursor)?.[relation] ?? null;
      }
    }
  }
  const ranksByScope = new Map<string, number[]>();
  for (const item of roadmap.roadmapItems) {
    const key = JSON.stringify([item.parentId, item.status]);
    const ranks = ranksByScope.get(key) ?? [];
    ranks.push((item.parentId === null ? item.boardRank : item.groupRank)!);
    ranksByScope.set(key, ranks);
  }
  for (const [scope, ranks] of ranksByScope) {
    ranks.sort((a, b) => a - b);
    if (ranks.some((rank, index) => rank !== index + 1)) {
      throw new PlanbanValidationError(`Ranks must be unique and contiguous in ${scope}.`);
    }
  }
}

export function cardAncestry(roadmap: PlanbanRoadmap, cardId: string): PlanbanRoadmapItem[] {
  const byId = new Map(roadmap.roadmapItems.map((item) => [item.id, item]));
  const item = byId.get(cardId);
  if (!item) throw new PlanbanNotFoundError(`Card not found: ${cardId}`);
  const result: PlanbanRoadmapItem[] = [];
  let parentId = item.parentId;
  while (parentId) {
    const parent = byId.get(parentId);
    if (!parent) throw new PlanbanValidationError(`Parent not found: ${parentId}`);
    result.unshift(parent);
    parentId = parent.parentId;
  }
  return result;
}

export function createEmptyRoadmap(input: { repoId: string; title: string }): PlanbanRoadmap {
  const timestamp = nowIso();
  return {
    version: 2,
    writerVersion: 6,
    revision: 1,
    updatedAt: timestamp,
    project: {
      id: input.repoId,
      title: input.title,
      status: "active",
      description: "",
      tags: [],
    },
    columns: defaultColumns(),
    roadmapItems: [],
  };
}

export function resolvePlanningRoot(manifest: PlanbanProjectManifest): string {
  return manifest.storage?.root
    ? resolve(expandHome(manifest.storage.root))
    : defaultPlanningRoot(manifest.repoId);
}

export async function withRoadmapWriteLock<T>(cwdInput: string, callback: () => Promise<T>): Promise<T> {
  const cwd = resolve(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest || !manifest.enabled) {
    throw new Error(`Planban is not initialized in ${cwd}`);
  }
  return withBoardWriteLock(resolvePlanningRoot(manifest), callback);
}

export async function readManifest(cwd: string): Promise<PlanbanProjectManifest | null> {
  const path = manifestPath(cwd);
  if (!(await pathExists(path))) return null;
  return manifestSchema.parse(await readJson(path));
}

export async function loadState(cwdInput: string): Promise<PlanbanResolvedState> {
  const cwd = resolve(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest || !manifest.enabled) {
    throw new Error(`Planban is not initialized in ${cwd}`);
  }

  const planningRoot = resolvePlanningRoot(manifest);
  const liveRoadmapPath = roadmapPath(planningRoot);
  if (!(await pathExists(liveRoadmapPath))) {
    throw new Error(`Planban roadmap is missing at ${liveRoadmapPath}`);
  }

  const state = {
    cwd,
    manifestPath: manifestPath(cwd),
    agentContextPath: agentContextPath(cwd),
    planningRoot,
    roadmapPath: liveRoadmapPath,
    manifest,
    roadmap: normalizeRoadmap(await readJson(liveRoadmapPath)),
  };
  await ensureHistoryBaseline(state);
  return state;
}

const AGENTS_BLOCK_START = "<!-- BEGIN PLANBAN -->";
const AGENTS_BLOCK_END = "<!-- END PLANBAN -->";

function buildAgentsBlock(): string {
  return `${AGENTS_BLOCK_START}

This repo uses Planban.

Canonical live planning state for this device is not branch-local.
Read \`.planban/project.json\` and \`.planban/agent-context.md\` before making roadmap or plan updates.
If the user asks to update the roadmap, follow the Planban protocol described there.
If an agent starts implementation work on a roadmap item, move it to In Progress if needed; leave completed agent work In Progress with a review/testing next action until the user explicitly asks to mark it Complete or confirms completion.

${AGENTS_BLOCK_END}`;
}

function upsertManagedBlock(existing: string, block: string): string {
  const start = existing.indexOf(AGENTS_BLOCK_START);
  const end = existing.indexOf(AGENTS_BLOCK_END);
  if (start >= 0 && end >= start) {
    const suffix = end + AGENTS_BLOCK_END.length;
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(suffix).trimStart();
    return [before, block, after].filter(Boolean).join("\n\n") + "\n";
  }
  return existing.trimEnd().length > 0 ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
}

export async function initializeProject(input: {
  cwd: string;
  title?: string | undefined;
  repoId?: string | undefined;
  updateAgents?: boolean | undefined;
}): Promise<PlanbanResolvedState> {
  const cwd = resolve(input.cwd);
  const repoId = input.repoId ?? defaultRepoId(cwd);
  const title = input.title ?? repoId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const planningRoot = defaultPlanningRoot(repoId);
  const liveRoadmapPath = roadmapPath(planningRoot);

  return withBoardWriteLock(planningRoot, async () => {
  const manifest: PlanbanProjectManifest = {
    version: 1,
    repoId,
    enabled: true,
    storage: { kind: "local" },
  };

  await mkdir(protocolDir(cwd), { recursive: true });
  await mkdir(planningRoot, { recursive: true });
  await mkdir(dirname(liveRoadmapPath), { recursive: true });

  await atomicWriteFile(manifestPath(cwd), JSON.stringify(manifest, null, 2) + "\n");
  await atomicWriteFile(
    agentContextPath(cwd),
    buildAgentContext({
      planningRoot,
      roadmapPath: liveRoadmapPath,
      manifestPath: manifestPath(cwd),
    }),
  );

  if (!(await pathExists(liveRoadmapPath))) {
    await atomicWriteFile(
      liveRoadmapPath,
      JSON.stringify(createEmptyRoadmap({ repoId, title }), null, 2) + "\n",
    );
  }

  if (input.updateAgents !== false) {
    const agentsPath = join(cwd, "AGENTS.md");
    const existing = (await pathExists(agentsPath)) ? await readFile(agentsPath, "utf8") : "";
    await atomicWriteFile(agentsPath, upsertManagedBlock(existing, buildAgentsBlock()));
  }

  const state = await loadState(cwd);
  await registerBoardFromState(state);
  return state;
  });
}

export async function saveRoadmap(
  state: PlanbanResolvedState,
  roadmap: PlanbanRoadmap,
  history: PlanbanHistoryMeta | false = {
    actor: "user",
    operation: "roadmap.save",
    summary: "Saved roadmap",
    affectedCards: roadmap.roadmapItems.map((item) => item.id),
  },
) {
  return withBoardWriteLock(state.planningRoot, async () => {
  assertRoadmapRelations(roadmap);
  assertGroupLifecycle(roadmap);
  if (history !== false) await ensureHistoryBaseline(state);
  const updated: PlanbanRoadmap = {
    ...roadmap,
    version: 2,
    writerVersion: 6,
    revision: roadmap.revision + 1,
    updatedAt: nowIso(),
  };
  await mkdir(dirname(state.roadmapPath), { recursive: true });
  const originalRoadmap = await readFile(state.roadmapPath, "utf8");
  await atomicWriteFile(state.roadmapPath, JSON.stringify(updated, null, 2) + "\n");
  try {
    if (history !== false) await recordHistoryVersion({ ...state, roadmap: updated }, updated, history);
  } catch (error) {
    await atomicWriteFile(state.roadmapPath, originalRoadmap);
    throw error;
  }
  await appendEvent(state.planningRoot, {
    type: "roadmap.saved",
    at: updated.updatedAt,
    revision: updated.revision,
  }).catch(() => undefined);
  return updated;
  });
}

export async function appendEvent(planningRoot: string, event: Record<string, unknown>) {
  await mkdir(planningRoot, { recursive: true });
  const line = JSON.stringify(event) + "\n";
  await appendLineDurably(eventsPath(planningRoot), line);
}

function normalizeColumnPriorities(items: PlanbanRoadmapItem[]): PlanbanRoadmapItem[] {
  return assignHierarchyRanks(PLANBAN_STATUSES.flatMap((status) =>
    items
      .filter((item) => item.status === status)
      .map((item, index) => ({ ...item, priority: index + 1 })),
  ));
}

function assignColumnPriorities(items: PlanbanRoadmapItem[]): PlanbanRoadmapItem[] {
  const counts = new Map<PlanbanStatus, number>();
  return assignHierarchyRanks(items.map((item) => {
    const priority = (counts.get(item.status) ?? 0) + 1;
    counts.set(item.status, priority);
    return { ...item, priority };
  }));
}

function assignHierarchyRanks(items: PlanbanRoadmapItem[]): PlanbanRoadmapItem[] {
  const counts = new Map<string, number>();
  return items.map((item) => {
    const key = JSON.stringify([item.parentId, item.status]);
    const rank = (counts.get(key) ?? 0) + 1;
    counts.set(key, rank);
    return { ...item, boardRank: item.parentId === null ? rank : null, groupRank: item.parentId === null ? null : rank };
  });
}

export type PlanbanCreateCardPosition = "top" | "bottom";

function defaultSpecMarkdown(input: { title: string }) {
  return `# ${input.title} Spec\n\nStatus: **Draft. Complete the Current state section before using this Spec for execution.**\n\n## Purpose\n\nDescribe why this Item or Group exists.\n\n## Target outcome\n\nDescribe the future success condition.\n\n## Current state\n\nState what is true now. This section is authoritative for current execution after review.\n\n## Agent reference\n\nRecord applicable scope, decisions, constraints, acceptance, verification, rollback, and authoritative links.\n`;
}

function insertCreatedCard(
  items: PlanbanRoadmapItem[],
  item: PlanbanRoadmapItem,
  input: { position?: PlanbanCreateCardPosition | undefined; afterId?: string | undefined },
) {
  if (input.position !== undefined && input.position !== "top" && input.position !== "bottom") {
    throw new Error("position must be top or bottom");
  }

  if (input.afterId) {
    const afterIndex = items.findIndex((entry) => entry.id === input.afterId);
    if (afterIndex < 0) throw new Error(`afterId not found: ${input.afterId}`);
    if (items[afterIndex]?.status !== item.status) {
      throw new Error(`afterId must refer to a card in ${STATUS_LABELS[item.status]}`);
    }
    if (items[afterIndex]?.parentId !== item.parentId) {
      throw new Error("afterId must refer to a sibling in the same Group or on the main board");
    }
    const result = [...items];
    result.splice(afterIndex + 1, 0, item);
    return result;
  }

  const result = [...items];
  if (input.position === "top") {
    const firstTargetIndex = result.findIndex((entry) => entry.status === item.status);
    if (firstTargetIndex >= 0) result.splice(firstTargetIndex, 0, item);
    else result.push(item);
    return result;
  }

  const lastTargetIndex = result.map((entry) => entry.status).lastIndexOf(item.status);
  if (lastTargetIndex >= 0) result.splice(lastTargetIndex + 1, 0, item);
  else result.push(item);
  return result;
}

function assertGroupLifecycle(candidate: PlanbanRoadmap): void {
  for (const group of candidate.roadmapItems.filter((entry) =>
    entry.isGroup && (entry.status === "complete" || entry.status === "archived")
  )) {
    const openItem = candidate.roadmapItems.find((entry) =>
      entry.parentId === group.id && entry.status !== "complete" && entry.status !== "archived"
    );
    if (openItem) {
      throw new PlanbanConflictError(
        `Cannot move ${group.title} to ${STATUS_LABELS[group.status]} while Item ${openItem.title} remains ${STATUS_LABELS[openItem.status]}.`,
      );
    }
  }
}

export async function moveCard(input: {
  cwd: string;
  cardId: string;
  status?: PlanbanStatus | undefined;
  parentId?: string | null | undefined;
  afterId?: string | null | undefined;
  baseRevision?: number | undefined;
  actor?: PlanbanHistoryActor | undefined;
}): Promise<PlanbanResolvedState> {
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  assertBaseRevision(state, input.baseRevision);
  const item = state.roadmap.roadmapItems.find((entry) => entry.id === input.cardId);
  if (!item) throw new Error(`Card not found: ${input.cardId}`);
  if (input.status === undefined && input.parentId === undefined && input.afterId === undefined) {
    throw new PlanbanValidationError("A status, parentId, or rank position is required.");
  }
  if (typeof input.parentId === "string" && !input.parentId.trim()) {
    throw new PlanbanValidationError("parentId must be a non-empty card id or null.");
  }
  const status = input.status ?? item.status;
  const parentId = input.parentId === undefined ? item.parentId : input.parentId?.trim() || null;
  if (parentId === item.id) throw new PlanbanValidationError(`${item.id} cannot parent itself.`);
  const parent = parentId ? state.roadmap.roadmapItems.find((entry) => entry.id === parentId) : null;
  if (parentId && !parent) throw new PlanbanNotFoundError(`Parent not found: ${parentId}`);
  if (parentId && item.isGroup) {
    throw new PlanbanValidationError("A Group cannot be placed inside another Group.");
  }
  if (parent && parent.parentId !== null) {
    throw new PlanbanValidationError("An owned Item cannot own another Work Item. Move it to the Main Board first.");
  }
  if (parent && !parent.isGroup) {
    throw new PlanbanValidationError("The destination must be an existing Group.");
  }
  if (typeof input.afterId === "string") {
    const after = state.roadmap.roadmapItems.find((entry) => entry.id === input.afterId);
    if (!after) throw new PlanbanNotFoundError(`afterId not found: ${input.afterId}`);
    if (after.id === item.id || after.parentId !== parentId || after.status !== status) {
      throw new PlanbanValidationError("afterId must refer to another Work Item in the target ownership and status scope.");
    }
  }

  const remaining = state.roadmap.roadmapItems.filter((entry) => entry.id !== input.cardId);
  const changedAt = nowIso();
  const moved = {
    ...item,
    status,
    parentId,
    completedAt: status === "complete" ? item.completedAt ?? changedAt : null,
    updatedAt: changedAt,
  };
  const result: PlanbanRoadmapItem[] = [];
  let inserted = false;

  for (const entry of remaining) {
    if (input.afterId === null && !inserted && entry.parentId === parentId && entry.status === status) {
      result.push(moved);
      inserted = true;
    }
    result.push(entry);
    if (typeof input.afterId === "string" && entry.id === input.afterId) {
      result.push(moved);
      inserted = true;
    }
  }

  if (!inserted) {
    const lastTargetIndex = result.map((entry) => entry.parentId === parentId && entry.status === status).lastIndexOf(true);
    if (lastTargetIndex >= 0) result.splice(lastTargetIndex + 1, 0, moved);
    else result.push(moved);
  }

  const candidate = {
    ...state.roadmap,
    roadmapItems: normalizeColumnPriorities(result),
  };
  const roadmap = await saveRoadmap(state, candidate, {
    actor: input.actor ?? "user",
    operation: parentId !== item.parentId ? "card.parent.update" : "card.move",
    summary: parentId !== item.parentId
      ? parent ? `Moved ${item.title} into ${parent.title}` : `Moved ${item.title} to the main board`
      : status !== item.status ? `Moved ${item.title} to ${STATUS_LABELS[status]}` : `Placed ${item.title} in ${STATUS_LABELS[status]}`,
    affectedCards: parent ? [item.id, parent.id] : [item.id],
  });
  return { ...state, roadmap };
  });
}

export async function updateCard(input: {
  cwd: string;
  cardId: string;
  baseRevision?: number | undefined;
  title?: string | undefined;
  summary?: string | null | undefined;
  nextAction?: string | null | undefined;
  tags?: string[] | undefined;
  blockedBy?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  actor?: PlanbanHistoryActor | undefined;
}): Promise<PlanbanResolvedState> {
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  assertBaseRevision(state, input.baseRevision);
  const item = state.roadmap.roadmapItems.find((entry) => entry.id === input.cardId);
  if (!item) throw new Error(`Card not found: ${input.cardId}`);
  const title = input.title === undefined ? undefined : input.title.trim();
  if (title !== undefined && !title) throw new PlanbanValidationError("title is required");

  const updatedItem: PlanbanRoadmapItem = {
    ...item,
    ...(title !== undefined ? { title } : {}),
    ...(input.summary !== undefined ? { summary: input.summary?.trim() || null } : {}),
    ...(input.nextAction !== undefined ? { nextAction: input.nextAction?.trim() || null } : {}),
    ...(input.tags !== undefined ? { tags: input.tags.map((tag) => tag.trim()).filter(Boolean) } : {}),
    ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy?.trim() || null } : {}),
    ...(input.metadata !== undefined ? (input.metadata === null ? {} : { metadata: input.metadata }) : {}),
    updatedAt: nowIso(),
  };

  if (input.blockedBy !== undefined) {
    const blockerId = input.blockedBy?.trim() || null;
    if (blockerId === item.id) throw new PlanbanValidationError(`${item.id} cannot block itself.`);
    if (blockerId && !state.roadmap.roadmapItems.some((entry) => entry.id === blockerId)) {
      throw new PlanbanNotFoundError(`Dependency not found: ${blockerId}`);
    }
    const candidate = {
      ...state.roadmap,
      roadmapItems: state.roadmap.roadmapItems.map((entry) => entry.id === item.id ? updatedItem : entry),
    };
    assertRoadmapRelations(candidate);
  }

  if (input.metadata === null) delete updatedItem.metadata;

  const roadmap = await saveRoadmap(state, {
    ...state.roadmap,
    roadmapItems: state.roadmap.roadmapItems.map((entry) => entry.id === input.cardId ? updatedItem : entry),
  }, {
    actor: input.actor ?? "user",
    operation: "card.update",
    summary: title !== undefined && title !== item.title
      ? `Renamed ${item.title} to ${title}`
      : `Updated ${item.title}`,
    affectedCards: [item.id],
  });
  return { ...state, roadmap };
  });
}

export async function setCardParent(input: {
  cwd: string;
  cardId: string;
  parentId: string | null;
  baseRevision?: number | undefined;
  actor?: PlanbanHistoryActor | undefined;
}): Promise<PlanbanResolvedState> {
  return moveCard(input);
}

export async function setCardStatus(cwd: string, cardId: string, status: PlanbanStatus) {
  return moveCard({ cwd, cardId, status });
}

export async function deleteArchivedCard(input: {
  cwd: string;
  cardId: string;
  baseRevision?: number | undefined;
}): Promise<PlanbanResolvedState> {
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  assertBaseRevision(state, input.baseRevision);
  const item = state.roadmap.roadmapItems.find((entry) => entry.id === input.cardId);
  if (!item) throw new Error(`Card not found: ${input.cardId}`);
  if (item.status !== "archived") {
    throw new PlanbanConflictError("Only archived cards can be deleted.");
  }
  if (state.roadmap.roadmapItems.some((entry) => entry.parentId === item.id)) {
    throw new PlanbanConflictError("A Group with children cannot be deleted.");
  }

  const roadmap = await saveRoadmap(state, {
    ...state.roadmap,
    roadmapItems: normalizeColumnPriorities(state.roadmap.roadmapItems.filter((entry) => entry.id !== input.cardId)),
  }, {
    actor: "user",
    operation: "card.delete",
    summary: `Deleted ${item.title}`,
    affectedCards: [item.id],
  });
  await rm(itemRoot(state.planningRoot, input.cardId), { recursive: true, force: true });
  return { ...state, roadmap };
  });
}

export async function reorderCards(input: {
  cwd: string;
  items: Array<{ id: string; status: PlanbanStatus }>;
  baseRevision?: number | undefined;
}): Promise<PlanbanResolvedState> {
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  assertBaseRevision(state, input.baseRevision);

  const existingById = new Map(state.roadmap.roadmapItems.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const reordered: PlanbanRoadmapItem[] = [];

  for (const entry of input.items) {
    const existing = existingById.get(entry.id);
    if (!existing) throw new Error(`Unknown card in reorder payload: ${entry.id}`);
    if (seen.has(entry.id)) throw new Error(`Duplicate card in reorder payload: ${entry.id}`);
    seen.add(entry.id);
    reordered.push({
      ...existing,
      status: entry.status,
      updatedAt: existing.status === entry.status ? existing.updatedAt : nowIso(),
    });
  }

  if (seen.size !== existingById.size) {
    throw new Error("Reorder payload must include every card id");
  }

  const candidate = {
    ...state.roadmap,
    roadmapItems: normalizeColumnPriorities(reordered),
  };
  const roadmap = await saveRoadmap(state, candidate, {
    actor: "user",
    operation: "cards.reorder",
    summary: "Reordered board cards",
    affectedCards: input.items.map((item) => item.id),
  });
  return { ...state, roadmap };
  });
}

export async function createCard(input: {
  cwd: string;
  title: string;
  status?: PlanbanStatus | undefined;
  summary?: string | undefined;
  nextAction?: string | undefined;
  tags?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  specMarkdown?: string | undefined;
  planMarkdown?: string | undefined;
  position?: PlanbanCreateCardPosition | undefined;
  afterId?: string | undefined;
  actor?: PlanbanHistoryActor | undefined;
  parentId?: string | null | undefined;
  baseRevision?: number | undefined;
}): Promise<PlanbanResolvedState & { createdCard: PlanbanRoadmapItem }> {
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  assertBaseRevision(state, input.baseRevision);
  const title = input.title.trim();
  if (!title) throw new Error("title is required");
  const baseId = input.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const existingIds = new Set(state.roadmap.roadmapItems.map((item) => item.id));
  let id = baseId || "card";
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${baseId || "card"}-${suffix}`;
    suffix += 1;
  }

  const status = input.status ?? "pending";
  if (typeof input.parentId === "string" && !input.parentId.trim()) {
    throw new PlanbanValidationError("parentId must be a non-empty card id or null.");
  }
  const parentId = input.parentId?.trim() || null;
  const parent = parentId ? state.roadmap.roadmapItems.find((entry) => entry.id === parentId) : null;
  if (parentId && !parent) throw new PlanbanNotFoundError(`Parent not found: ${parentId}`);
  if (parent && parent.parentId !== null) {
    throw new PlanbanValidationError("An owned Item cannot own another Work Item. Move it to the Main Board first.");
  }
  if (parent && !parent.isGroup) {
    throw new PlanbanValidationError("The destination must be an existing Group.");
  }
  const priority = state.roadmap.roadmapItems.filter((item) => item.status === status && item.parentId === parentId).length + 1;
  const timestamp = nowIso();
  const item: PlanbanRoadmapItem = {
    id,
    title,
    status,
    priority,
    summary: input.summary?.trim() || null,
    nextAction: input.nextAction?.trim() || null,
    tags: input.tags?.map((tag) => tag.trim()).filter(Boolean) ?? [],
    icon: null,
    blockedBy: null,
    specDoc: `items/${id}/spec.md`,
    planDoc: input.planMarkdown !== undefined ? `items/${id}/plan.md` : null,
    completedAt: null,
    updatedAt: timestamp,
    isGroup: false,
    parentId,
    boardRank: parentId === null ? priority : null,
    groupRank: parentId === null ? null : priority,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
  const roadmapItems = assignColumnPriorities(insertCreatedCard(state.roadmap.roadmapItems, item, input));

  const candidate = {
    ...state.roadmap,
    roadmapItems,
  };
  const roadmap = await saveRoadmap(state, candidate, false);

  await mkdir(itemRoot(state.planningRoot, id), { recursive: true });
  const specPath = resolveInsideRoot(state.planningRoot, item.specDoc ?? `items/${id}/spec.md`, `spec document path for ${id}`);
  await mkdir(dirname(specPath), { recursive: true });
  await atomicWriteFile(specPath, input.specMarkdown ?? defaultSpecMarkdown({ title }));
  await appendEvent(state.planningRoot, {
    type: "doc.written",
    at: nowIso(),
    cardId: id,
    kind: "spec",
    path: specPath,
  });
  const affectedDocs: PlanbanHistoryMeta["affectedDocs"] = [{ cardId: item.id, kind: "spec", path: item.specDoc }];

  if (item.planDoc !== null && input.planMarkdown !== undefined) {
    const planPath = resolveInsideRoot(state.planningRoot, item.planDoc, `plan document path for ${id}`);
    await mkdir(dirname(planPath), { recursive: true });
    await atomicWriteFile(planPath, input.planMarkdown);
    await appendEvent(state.planningRoot, {
      type: "doc.written",
      at: nowIso(),
      cardId: id,
      kind: "plan",
      path: planPath,
    });
    affectedDocs.push({ cardId: item.id, kind: "plan", path: item.planDoc });
  }

  await recordHistoryVersion({ ...state, roadmap }, roadmap, {
    actor: input.actor ?? "user",
    operation: "card.create",
    summary: `Created ${item.title}`,
    affectedCards: parent ? [item.id, parent.id] : [item.id],
    affectedDocs,
  });

  const createdCard = roadmap.roadmapItems.find((entry) => entry.id === id) ?? item;
  return { ...state, roadmap, createdCard };
  });
}

export async function createGroup(input: {
  cwd: string;
  title: string;
  summary?: string | undefined;
  nextAction?: string | undefined;
  status?: PlanbanStatus | undefined;
  itemIds?: string[] | undefined;
  anchorId?: string | undefined;
  specMarkdown?: string | undefined;
  planMarkdown?: string | undefined;
  baseRevision?: number | undefined;
  actor?: PlanbanHistoryActor | undefined;
}): Promise<PlanbanResolvedState & { createdGroup: PlanbanRoadmapItem }> {
  return withRoadmapWriteLock(input.cwd, async () => {
    const state = await loadState(input.cwd);
    assertBaseRevision(state, input.baseRevision);
    const title = input.title.trim();
    if (!title) throw new PlanbanValidationError("title is required");
    const summary = input.summary?.trim() || null;

    const itemIds = [...new Set((input.itemIds ?? []).map((id) => id.trim()))];
    if (itemIds.some((id) => !id)) throw new PlanbanValidationError("itemIds must contain non-empty card ids.");
    const itemIdSet = new Set(itemIds);
    const items = itemIds.map((id) => {
      const item = state.roadmap.roadmapItems.find((entry) => entry.id === id);
      if (!item) throw new PlanbanNotFoundError(`Item not found: ${id}`);
      if (item.isGroup) throw new PlanbanValidationError(`${item.title} is a Group and cannot be placed inside another Group.`);
      if (item.parentId !== null) throw new PlanbanValidationError(`${item.title} is already owned by a Group. Move it to the Main Board first.`);
      return item;
    });
    const anchorId = input.anchorId?.trim();
    if (anchorId && !itemIdSet.has(anchorId)) {
      throw new PlanbanValidationError("anchorId must identify one of the initial Items.");
    }
    const anchor = anchorId ? items.find((item) => item.id === anchorId)! : null;

    const baseId = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    const existingIds = new Set(state.roadmap.roadmapItems.map((item) => item.id));
    let id = baseId || "group";
    let suffix = 2;
    while (existingIds.has(id) || await pathExists(itemRoot(state.planningRoot, id))) {
      id = `${baseId || "group"}-${suffix}`;
      suffix += 1;
    }

    const timestamp = nowIso();
    const status = input.status ?? anchor?.status ?? "pending";
    const group: PlanbanRoadmapItem = {
      id,
      title,
      status,
      priority: 1,
      summary,
      nextAction: input.nextAction?.trim() || null,
      tags: [],
      icon: null,
      blockedBy: null,
      specDoc: `items/${id}/spec.md`,
      planDoc: input.planMarkdown !== undefined ? `items/${id}/plan.md` : null,
      completedAt: null,
      updatedAt: timestamp,
      isGroup: true,
      parentId: null,
      boardRank: 1,
      groupRank: null,
    };

    const anchorIndex = anchor ? state.roadmap.roadmapItems.findIndex((item) => item.id === anchor.id) : state.roadmap.roadmapItems.length;
    const remaining = state.roadmap.roadmapItems.filter((item) => !itemIdSet.has(item.id));
    const rootsBeforeAnchor = state.roadmap.roadmapItems.slice(0, anchorIndex).filter((item) => !itemIdSet.has(item.id)).length;
    const ownedItems = state.roadmap.roadmapItems
      .filter((item) => itemIdSet.has(item.id))
      .map((item) => ({ ...item, parentId: id, boardRank: null, groupRank: 1, updatedAt: timestamp }));
    const arranged = [...remaining];
    arranged.splice(rootsBeforeAnchor, 0, group);
    arranged.push(...ownedItems);
    const roadmapItems = normalizeColumnPriorities(arranged);
    const candidate = { ...state.roadmap, roadmapItems };
    const roadmap = await saveRoadmap(state, candidate, false);

    await mkdir(itemRoot(state.planningRoot, id), { recursive: true });
    const specPath = resolveInsideRoot(state.planningRoot, group.specDoc!, `spec document path for ${id}`);
    await mkdir(dirname(specPath), { recursive: true });
    await atomicWriteFile(specPath, input.specMarkdown ?? defaultSpecMarkdown({ title }));
    await appendEvent(state.planningRoot, { type: "doc.written", at: nowIso(), cardId: id, kind: "spec", path: specPath });
    const affectedDocs: PlanbanHistoryMeta["affectedDocs"] = [{ cardId: id, kind: "spec", path: group.specDoc }];
    if (group.planDoc && input.planMarkdown !== undefined) {
      const planPath = resolveInsideRoot(state.planningRoot, group.planDoc, `plan document path for ${id}`);
      await mkdir(dirname(planPath), { recursive: true });
      await atomicWriteFile(planPath, input.planMarkdown);
      await appendEvent(state.planningRoot, { type: "doc.written", at: nowIso(), cardId: id, kind: "plan", path: planPath });
      affectedDocs.push({ cardId: id, kind: "plan", path: group.planDoc });
    }
    await recordHistoryVersion({ ...state, roadmap }, roadmap, {
      actor: input.actor ?? "user",
      operation: "group.create",
      summary: items.length > 0
        ? `Created ${title} with ${items.length} ${items.length === 1 ? "Item" : "Items"}`
        : `Created empty Group ${title}`,
      affectedCards: [id, ...itemIds],
      affectedDocs,
    });
    const createdGroup = roadmap.roadmapItems.find((item) => item.id === id) ?? group;
    return { ...state, roadmap, createdGroup };
  });
}

export async function createCards(input: {
  cwd: string;
  titles: string[];
  status?: PlanbanStatus | undefined;
  parentId?: string | null | undefined;
  baseRevision?: number | undefined;
  actor?: PlanbanHistoryActor | undefined;
  writeSpecFile?: ((path: string, markdown: string) => Promise<void>) | undefined;
}): Promise<PlanbanResolvedState & { createdCards: PlanbanRoadmapItem[] }> {
  return withRoadmapWriteLock(input.cwd, async () => {
    const state = await loadState(input.cwd);
    assertBaseRevision(state, input.baseRevision);
    const titles = input.titles.map((title) => title.trim());
    if (titles.length === 0 || titles.some((title) => !title)) {
      throw new PlanbanValidationError("titles must contain at least one non-empty title.");
    }
    const parentId = input.parentId?.trim() || null;
    const parent = parentId ? state.roadmap.roadmapItems.find((entry) => entry.id === parentId) : null;
    if (parentId && !parent) throw new PlanbanNotFoundError(`Parent not found: ${parentId}`);
    if (parent && parent.parentId !== null) {
      throw new PlanbanValidationError("An owned Item cannot own another Work Item. Move it to the Main Board first.");
    }
    if (parent && !parent.isGroup) {
      throw new PlanbanValidationError("The destination must be an existing Group.");
    }
    const status = input.status ?? "pending";
    const timestamp = nowIso();
    const existingIds = new Set(state.roadmap.roadmapItems.map((item) => item.id));
    const createdItems: PlanbanRoadmapItem[] = [];
    for (const title of titles) {
      const baseId = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "card";
      let id = baseId;
      let suffix = 2;
      while (existingIds.has(id) || await pathExists(itemRoot(state.planningRoot, id))) { id = `${baseId}-${suffix}`; suffix += 1; }
      existingIds.add(id);
      createdItems.push({
        id,
        title,
        status,
        priority: 1,
        summary: null,
        nextAction: null,
        tags: [],
        icon: null,
        blockedBy: null,
        specDoc: `items/${id}/spec.md`,
        planDoc: null,
        completedAt: null,
        updatedAt: timestamp,
        isGroup: false,
        parentId,
        boardRank: parentId === null ? 1 : null,
        groupRank: parentId === null ? null : 1,
      });
    }
    const roadmapItems = assignColumnPriorities([...state.roadmap.roadmapItems, ...createdItems]);
    const affectedDocs: PlanbanHistoryMeta["affectedDocs"] = [];
    const transactionRoot = join(state.planningRoot, ".transactions", `create-cards-${randomUUID()}`);
    const publishedRoots: string[] = [];
    const writeSpecFile = input.writeSpecFile ?? atomicWriteFile;
    let roadmap: PlanbanRoadmap;
    try {
      for (const item of createdItems) {
        const stagedSpecPath = join(transactionRoot, item.id, "spec.md");
        await mkdir(dirname(stagedSpecPath), { recursive: true });
        await writeSpecFile(stagedSpecPath, defaultSpecMarkdown({ title: item.title }));
        affectedDocs.push({ cardId: item.id, kind: "spec", path: item.specDoc });
      }
      for (const item of createdItems) {
        const finalRoot = itemRoot(state.planningRoot, item.id);
        await mkdir(dirname(finalRoot), { recursive: true });
        await rename(join(transactionRoot, item.id), finalRoot);
        publishedRoots.push(finalRoot);
      }
      roadmap = await saveRoadmap(state, { ...state.roadmap, roadmapItems }, {
        actor: input.actor ?? "user",
        operation: "cards.create",
        summary: `Created ${createdItems.length} Items`,
        affectedCards: [...createdItems.map((item) => item.id), ...(parent ? [parent.id] : [])],
        affectedDocs,
      });
      for (const item of createdItems) {
        const specPath = resolveInsideRoot(state.planningRoot, item.specDoc!, `spec document path for ${item.id}`);
        await appendEvent(state.planningRoot, { type: "doc.written", at: nowIso(), cardId: item.id, kind: "spec", path: specPath }).catch(() => undefined);
      }
    } catch (error) {
      await Promise.allSettled(publishedRoots.map((root) => rm(root, { recursive: true, force: true })));
      await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    const createdIds = new Set(createdItems.map((item) => item.id));
    return { ...state, roadmap, createdCards: roadmap.roadmapItems.filter((item) => createdIds.has(item.id)) };
  });
}

export function docPathForItem(state: PlanbanResolvedState, item: PlanbanRoadmapItem, kind: "spec" | "plan") {
  const configured = kind === "spec" ? item.specDoc : item.planDoc;
  if (!configured) return null;
  return resolveInsideRoot(state.planningRoot, configured, `${kind} document path for ${item.id}`);
}

export async function readDoc(input: {
  cwd: string;
  cardId: string;
  kind: "spec" | "plan";
}): Promise<PlanbanDocPayload> {
  const state = await loadState(input.cwd);
  const item = state.roadmap.roadmapItems.find((entry) => entry.id === input.cardId);
  if (!item) throw new Error(`Card not found: ${input.cardId}`);
  const path = docPathForItem(state, item, input.kind);
  if (!path || !(await pathExists(path))) {
    return { cardId: input.cardId, kind: input.kind, path, exists: false, markdown: "", mtimeMs: null };
  }
  const stats = await stat(path);
  return {
    cardId: input.cardId,
    kind: input.kind,
    path,
    exists: true,
    markdown: await readFile(path, "utf8"),
    mtimeMs: stats.mtimeMs,
  };
}

export async function exportFlatVersion1(input: {
  cwd: string;
  exportId: string;
  actor?: PlanbanHistoryActor | undefined;
}) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(input.exportId)) {
    throw new PlanbanValidationError("exportId must use 1-80 lowercase letters, numbers, or hyphens.");
  }
  return withRoadmapWriteLock(input.cwd, async () => {
    const state = await loadState(input.cwd);
    const exportRoot = join(state.planningRoot, "exports", input.exportId);
    if (await pathExists(exportRoot)) throw new PlanbanConflictError(`Export already exists: ${input.exportId}`);
    const affectedDocs = state.roadmap.roadmapItems.flatMap((item) => ([
      ...(item.specDoc ? [{ cardId: item.id, kind: "spec" as const, path: item.specDoc }] : []),
      ...(item.planDoc ? [{ cardId: item.id, kind: "plan" as const, path: item.planDoc }] : []),
    ]));
    const historyDocKeys = new Set<string>();
    const realPlanningRoot = await realpath(state.planningRoot);
    for (const doc of affectedDocs) {
      const historyDocKey = `${slugify(doc.cardId)}/${doc.kind}`;
      if (historyDocKeys.has(historyDocKey)) {
        throw new PlanbanValidationError(`Cannot export document evidence because Work Item ids collide after safe path encoding: ${doc.cardId}`);
      }
      historyDocKeys.add(historyDocKey);
      const livePath = resolveInsideRoot(state.planningRoot, doc.path, `${doc.kind} document path for ${doc.cardId}`);
      if (!(await pathExists(livePath))) {
        throw new PlanbanValidationError(`Cannot export ${doc.kind} evidence for ${doc.cardId}: ${doc.path} does not exist.`);
      }
      const realLivePath = await realpath(livePath);
      const pathFromRoot = relative(realPlanningRoot, realLivePath);
      if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
        throw new PlanbanValidationError(`Cannot export ${doc.kind} evidence for ${doc.cardId}: ${doc.path} resolves outside the planning root.`);
      }
    }
    const exportedDocPath = (cardId: string, kind: "spec" | "plan") => `documents/id-${encodeURIComponent(cardId)}/${kind}.md`;
    const flatRoadmap = flattenRoadmapForVersion1(state.roadmap);
    flatRoadmap.roadmapItems = flatRoadmap.roadmapItems.map((item) => ({
      ...item,
      specDoc: item.specDoc ? exportedDocPath(item.id, "spec") : null,
      planDoc: item.planDoc ? exportedDocPath(item.id, "plan") : null,
    }));
    const historyEntry = await recordHistoryVersion(state, state.roadmap, {
      actor: input.actor ?? "user",
      operation: "roadmap.export.flat-v1.snapshot",
      summary: `Captured a recovery snapshot for a flat version-1 export of ${state.roadmap.project.title}`,
      affectedCards: state.roadmap.roadmapItems.map((item) => item.id),
      affectedDocs,
      strictDocs: true,
    });
    for (const doc of affectedDocs) {
      if (!(await pathExists(historyDocPath(state.planningRoot, historyEntry.version, doc.cardId, doc.kind)))) {
        throw new PlanbanValidationError(`Cannot export ${doc.kind} evidence for ${doc.cardId}: recovery snapshot capture failed.`);
      }
    }
    const transactionRoot = join(state.planningRoot, ".transactions", `flat-v1-export-${randomUUID()}`);
    try {
      await mkdir(transactionRoot, { recursive: true });
      await atomicWriteFile(join(transactionRoot, "roadmap.json"), JSON.stringify(flatRoadmap, null, 2) + "\n");
      await atomicWriteFile(join(transactionRoot, "hierarchy-recovery.json"), JSON.stringify(hierarchyRecoveryManifest(state.roadmap, historyEntry.version), null, 2) + "\n");
      for (const doc of affectedDocs) {
        const source = historyDocPath(state.planningRoot, historyEntry.version, doc.cardId, doc.kind);
        if (!(await pathExists(source))) throw new PlanbanValidationError(`Cannot export ${doc.kind} evidence for ${doc.cardId}: recovery snapshot is incomplete.`);
        const destination = resolveInsideRoot(transactionRoot, exportedDocPath(doc.cardId, doc.kind), `export ${doc.kind} document path for ${doc.cardId}`);
        await mkdir(dirname(destination), { recursive: true });
        await atomicWriteFile(destination, await readFile(source, "utf8"));
      }
      await cp(historyRoot(state.planningRoot), join(transactionRoot, "history"), { recursive: true });
      await mkdir(dirname(exportRoot), { recursive: true });
      await rename(transactionRoot, exportRoot);
    } catch (error) {
      await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    await appendEvent(state.planningRoot, { type: "roadmap.exported", at: nowIso(), format: "flat-v1", exportId: input.exportId, historyVersion: historyEntry.version }).catch(() => undefined);
    return { exportId: input.exportId, exportRoot, roadmapPath: join(exportRoot, "roadmap.json"), recoveryPath: join(exportRoot, "hierarchy-recovery.json"), historyVersion: historyEntry.version, sourceRevision: state.roadmap.revision };
  });
}

export async function reconstructHierarchy(input: {
  cwd: string;
  groups: Array<{ id: string; childIds: string[] }>;
  baseRevision?: number | undefined;
  actor?: PlanbanHistoryActor | undefined;
}) {
  if (!Array.isArray(input.groups) || input.groups.length === 0) {
    throw new PlanbanValidationError("groups must contain at least one explicit hierarchy mapping.");
  }
  if (input.baseRevision === undefined) throw new PlanbanValidationError("baseRevision is required for hierarchy reconstruction.");
  return withRoadmapWriteLock(input.cwd, async () => {
    const state = await loadState(input.cwd);
    assertBaseRevision(state, input.baseRevision);
    const byId = new Map(state.roadmap.roadmapItems.map((item) => [item.id, item]));
    const parentByChild = new Map<string, string>();
    const preferredIndex = new Map<string, number>();
    const groupIds = new Set<string>();
    for (const group of input.groups) {
      if (!group || typeof group.id !== "string" || !group.id.trim() || !Array.isArray(group.childIds) || group.childIds.some((id) => typeof id !== "string" || !id.trim())) {
        throw new PlanbanValidationError("Each Group mapping requires a non-empty id and childIds array of Work Item ids.");
      }
      const groupItem = byId.get(group.id);
      if (!groupItem) throw new PlanbanNotFoundError(`Group Work Item not found: ${group.id}`);
      if (!groupItem.isGroup) throw new PlanbanValidationError(`${groupItem.title} is an Item; hierarchy reconstruction requires an existing Group.`);
      if (groupIds.has(group.id)) throw new PlanbanValidationError(`Duplicate Group mapping: ${group.id}`);
      groupIds.add(group.id);
      for (const [index, childId] of group.childIds.entries()) {
        if (!byId.has(childId)) throw new PlanbanNotFoundError(`Child Work Item not found: ${childId}`);
        if (childId === group.id) throw new PlanbanValidationError(`${childId} cannot parent itself.`);
        if (parentByChild.has(childId)) throw new PlanbanValidationError(`${childId} appears beneath more than one Group.`);
        parentByChild.set(childId, group.id);
        preferredIndex.set(childId, index);
      }
    }
    for (const groupId of groupIds) {
      if (parentByChild.has(groupId)) {
        throw new PlanbanValidationError("A Group cannot be placed inside another Group.");
      }
    }
    for (const childId of parentByChild.keys()) {
      if (byId.get(childId)?.isGroup) {
        throw new PlanbanValidationError("A Group cannot be placed inside another Group.");
      }
    }
    const timestamp = nowIso();
    const detachedIds = new Set(state.roadmap.roadmapItems.filter((item) => item.parentId && groupIds.has(item.parentId) && !parentByChild.has(item.id)).map((item) => item.id));
    let roadmapItems = state.roadmap.roadmapItems.map((item) => {
      const nextParentId = parentByChild.has(item.id) ? parentByChild.get(item.id)! : detachedIds.has(item.id) ? null : item.parentId;
      const changed = nextParentId !== item.parentId;
      return {
        ...item,
        parentId: nextParentId,
        updatedAt: changed ? timestamp : item.updatedAt,
      };
    });
    const scopes = new Map<string, PlanbanRoadmapItem[]>();
    for (const item of roadmapItems) {
      const key = JSON.stringify([item.parentId, item.status]);
      const scope = scopes.get(key) ?? [];
      scope.push(item);
      scopes.set(key, scope);
    }
    const rankById = new Map<string, number>();
    for (const scope of scopes.values()) {
      scope.sort((a, b) => {
        const aPreferred = preferredIndex.get(a.id);
        const bPreferred = preferredIndex.get(b.id);
        if (aPreferred !== undefined && bPreferred !== undefined) return aPreferred - bPreferred;
        if (aPreferred !== undefined) return -1;
        if (bPreferred !== undefined) return 1;
        return (a.parentId === null ? a.boardRank ?? 9999 : a.groupRank ?? 9999) - (b.parentId === null ? b.boardRank ?? 9999 : b.groupRank ?? 9999);
      });
      scope.forEach((item, index) => rankById.set(item.id, index + 1));
    }
    roadmapItems = roadmapItems.map((item) => ({
      ...item,
      boardRank: item.parentId === null ? rankById.get(item.id)! : null,
      groupRank: item.parentId === null ? null : rankById.get(item.id)!,
    }));
    const affectedCards = [...new Set([...groupIds, ...parentByChild.keys(), ...detachedIds])];
    const roadmap = await saveRoadmap(state, { ...state.roadmap, roadmapItems }, {
      actor: input.actor ?? "user",
      operation: "hierarchy.reconstruct",
      summary: `Reconstructed ${input.groups.length} Group ${input.groups.length === 1 ? "mapping" : "mappings"}`,
      affectedCards,
    });
    return { ...state, roadmap, cards: affectedCards.map((id) => roadmap.roadmapItems.find((item) => item.id === id)!) };
  });
}

export async function writeDoc(input: {
  cwd: string;
  cardId: string;
  kind: "spec" | "plan";
  markdown: string;
  expectedMtimeMs?: number | null | undefined;
  history?: PlanbanHistoryMeta | false | undefined;
}): Promise<PlanbanDocPayload> {
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  const item = state.roadmap.roadmapItems.find((entry) => entry.id === input.cardId);
  if (!item) throw new Error(`Card not found: ${input.cardId}`);

  let relativePath = input.kind === "spec" ? item.specDoc : item.planDoc;
  if (!relativePath) {
    relativePath = `items/${item.id}/${input.kind}.md`;
    const updatedItems = state.roadmap.roadmapItems.map((entry) =>
      entry.id === item.id
        ? {
            ...entry,
            ...(input.kind === "spec" ? { specDoc: relativePath } : { planDoc: relativePath }),
            updatedAt: nowIso(),
          }
        : entry,
    );
    await saveRoadmap(state, { ...state.roadmap, roadmapItems: updatedItems }, false);
  }

  const path = resolveInsideRoot(state.planningRoot, relativePath, `${input.kind} document path for ${item.id}`);
  const existsBeforeWrite = await pathExists(path);
  if (input.expectedMtimeMs !== undefined) {
    if (existsBeforeWrite) {
      const currentStats = await stat(path);
      if (input.expectedMtimeMs === null || currentStats.mtimeMs !== input.expectedMtimeMs) {
        throw new PlanbanConflictError("Document changed on disk. Reload before saving.");
      }
    } else if (input.expectedMtimeMs !== null) {
      throw new PlanbanConflictError("Document was removed on disk. Reload before saving.");
    }
  }

  await mkdir(dirname(path), { recursive: true });
  await atomicWriteFile(path, input.markdown);
  const stats = await stat(path);
  await appendEvent(state.planningRoot, {
    type: "doc.written",
    at: nowIso(),
    cardId: input.cardId,
    kind: input.kind,
    path,
  });
  if (input.history !== false) {
    const latestState = await loadState(input.cwd);
    await recordHistoryVersion(latestState, latestState.roadmap, input.history ?? {
      actor: "user",
      operation: "doc.write",
      summary: `Edited ${item.title} ${input.kind}`,
      affectedCards: [item.id],
      affectedDocs: [{ cardId: item.id, kind: input.kind, path: relativePath }],
    });
  }
  return { cardId: input.cardId, kind: input.kind, path, exists: true, markdown: input.markdown, mtimeMs: stats.mtimeMs };
  });
}

export async function historyPayload(cwd: string) {
  const state = await loadState(cwd);
  const { listHistory } = await import("./history");
  return listHistory(state);
}

export async function loadHistoryState(input: { cwd: string; version: number }): Promise<PlanbanResolvedState> {
  const state = await loadState(input.cwd);
  const { readHistoryRoadmap } = await import("./history");
  return { ...state, roadmap: await readHistoryRoadmap(state, input.version) };
}

export async function readHistoryDoc(input: {
  cwd: string;
  version: number;
  cardId: string;
  kind: "spec" | "plan";
}): Promise<PlanbanDocPayload> {
  const state = await loadState(input.cwd);
  return resolveHistoryDoc(state, input.version, input.cardId, input.kind);
}

export async function restoreBoardVersion(input: {
  cwd: string;
  version: number;
  actor?: PlanbanHistoryActor | undefined;
}): Promise<PlanbanResolvedState> {
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  const restored = await restoreRoadmapFromHistory({ state, version: input.version, actor: input.actor });
  const roadmap = await saveRoadmap(state, restored, {
    actor: input.actor ?? "user",
    operation: "history.restore.board",
    summary: `Restored board from v${input.version}`,
    affectedCards: restored.roadmapItems.map((item) => item.id),
  });
  return { ...state, roadmap };
  });
}

export async function restoreCardVersion(input: {
  cwd: string;
  version: number;
  cardId: string;
  actor?: PlanbanHistoryActor | undefined;
}): Promise<PlanbanResolvedState> {
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  const restoredCard = await restoreCardFromHistory({ state, version: input.version, cardId: input.cardId });
  const existing = state.roadmap.roadmapItems.some((item) => item.id === input.cardId);
  const roadmapItems = existing
    ? state.roadmap.roadmapItems.map((item) => (item.id === input.cardId ? restoredCard : item))
    : [...state.roadmap.roadmapItems, restoredCard];
  const roadmap = await saveRoadmap(state, {
    ...state.roadmap,
    roadmapItems: normalizeColumnPriorities(roadmapItems),
  }, {
    actor: input.actor ?? "user",
    operation: "history.restore.card",
    summary: `Restored ${restoredCard.title} from v${input.version}`,
    affectedCards: [input.cardId],
  });
  return { ...state, roadmap };
  });
}

export async function restoreDocVersion(input: {
  cwd: string;
  version: number;
  cardId: string;
  kind: "spec" | "plan";
  actor?: PlanbanHistoryActor | undefined;
}): Promise<PlanbanDocPayload> {
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  const historicalDoc = await resolveHistoryDoc(state, input.version, input.cardId, input.kind);
  if (!historicalDoc.exists) throw new Error(`${input.kind} document not found in v${input.version}`);
  const item = state.roadmap.roadmapItems.find((entry) => entry.id === input.cardId);
  const livePath = (item ? (input.kind === "spec" ? item.specDoc : item.planDoc) : null) ?? `items/${input.cardId}/${input.kind}.md`;
  return writeDoc({
    cwd: input.cwd,
    cardId: input.cardId,
    kind: input.kind,
    markdown: historicalDoc.markdown,
    history: {
      actor: input.actor ?? "user",
      operation: "history.restore.doc",
      summary: `Restored ${input.kind} document from v${input.version}`,
      affectedCards: [input.cardId],
      affectedDocs: [{ cardId: input.cardId, kind: input.kind, path: livePath }],
    },
  });
  });
}

export async function getStatus(cwdInput: string) {
  const cwd = resolve(cwdInput);
  const manifest = await readManifest(cwd);
  if (!manifest) {
    return {
      initialized: false,
      cwd,
      manifestPath: manifestPath(cwd),
      version: currentVersionInfo(),
    };
  }
  const planningRoot = resolvePlanningRoot(manifest);
  const liveRoadmapPath = roadmapPath(planningRoot);
  return {
    initialized: true,
    cwd,
    manifestPath: manifestPath(cwd),
    agentContextPath: agentContextPath(cwd),
    planningRoot,
    roadmapPath: liveRoadmapPath,
    roadmapExists: await pathExists(liveRoadmapPath),
    repoId: manifest.repoId,
    version: currentVersionInfo(),
  };
}
