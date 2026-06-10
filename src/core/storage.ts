import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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
  manifestPath,
  protocolDir,
  roadmapPath,
} from "./paths";
import { appendLineDurably, atomicWriteFile, withBoardWriteLock } from "./persistence";
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

function assertBaseRevision(state: PlanbanResolvedState, baseRevision?: number) {
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
  return {
    ...parsed,
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
      blockedBy: item.blockedBy,
      specDoc: item.specDoc,
      planDoc: item.planDoc,
      completedAt: item.completedAt,
      updatedAt: item.updatedAt,
      ...(item.metadata ? { metadata: item.metadata } : {}),
    })),
  };
}

export function createEmptyRoadmap(input: { repoId: string; title: string }): PlanbanRoadmap {
  const timestamp = nowIso();
  return {
    version: 1,
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

function buildAgentContext(input: {
  planningRoot: string;
  roadmapPath: string;
  manifestPath: string;
}): string {
  return `# Planban Agent Context

This repo uses Planban.

Canonical live planning state for this device is not branch-local. Read and write the live roadmap at:

- ${input.roadmapPath}

Repo-local manifest:

- ${input.manifestPath}

Device-local planning root:

- ${input.planningRoot}

When the user asks to update the roadmap:

- update the roadmap item's status
- update priority when ordering changes within a column
- update the card summary and next action so they match the current phase of work
- update linked specs, and only create or update separate implementation plans when the work is complex enough to need one
- do not create or prefer ROADMAP.md

Roadmap status protocol for agent work:

- if the user explicitly asks an agent to start implementing a roadmap item, or the agent proceeds to implementation work for that item, move it to In Progress when it is not already there
- do not move a card to In Progress merely because a Codex thread was opened, context was read, or planning/discussion happened
- when the agent finishes its own implementation and verification, leave the card In Progress and update summary and next action to say it is ready for user review/testing
- move a card to Complete only when the user explicitly asks, manually confirms completion after testing/review, or clearly waives user-side verification
- agent-side tests and verification are enough to record "ready for review"; they are not enough by themselves to self-complete the roadmap item
`;
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
  if (history !== false) await ensureHistoryBaseline(state);
  const updated: PlanbanRoadmap = {
    ...roadmap,
    revision: roadmap.revision + 1,
    updatedAt: nowIso(),
  };
  await mkdir(dirname(state.roadmapPath), { recursive: true });
  await atomicWriteFile(state.roadmapPath, JSON.stringify(updated, null, 2) + "\n");
  await appendEvent(state.planningRoot, {
    type: "roadmap.saved",
    at: updated.updatedAt,
    revision: updated.revision,
  });
  if (history !== false) await recordHistoryVersion({ ...state, roadmap: updated }, updated, history);
  return updated;
  });
}

export async function appendEvent(planningRoot: string, event: Record<string, unknown>) {
  await mkdir(planningRoot, { recursive: true });
  const line = JSON.stringify(event) + "\n";
  await appendLineDurably(eventsPath(planningRoot), line);
}

function normalizeColumnPriorities(items: PlanbanRoadmapItem[]): PlanbanRoadmapItem[] {
  return PLANBAN_STATUSES.flatMap((status) =>
    items
      .filter((item) => item.status === status)
      .map((item, index) => ({ ...item, priority: index + 1 })),
  );
}

export async function moveCard(input: {
  cwd: string;
  cardId: string;
  status: PlanbanStatus;
  afterId?: string;
  baseRevision?: number | undefined;
  actor?: PlanbanHistoryActor | undefined;
}): Promise<PlanbanResolvedState> {
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
  assertBaseRevision(state, input.baseRevision);
  const item = state.roadmap.roadmapItems.find((entry) => entry.id === input.cardId);
  if (!item) throw new Error(`Card not found: ${input.cardId}`);

  const remaining = state.roadmap.roadmapItems.filter((entry) => entry.id !== input.cardId);
  const moved = { ...item, status: input.status, updatedAt: nowIso() };
  const result: PlanbanRoadmapItem[] = [];
  let inserted = false;

  for (const entry of remaining) {
    result.push(entry);
    if (input.afterId && entry.id === input.afterId) {
      result.push(moved);
      inserted = true;
    }
  }

  if (!inserted) {
    const lastTargetIndex = result.map((entry) => entry.status).lastIndexOf(input.status);
    if (lastTargetIndex >= 0) result.splice(lastTargetIndex + 1, 0, moved);
    else result.push(moved);
  }

  const roadmap = await saveRoadmap(state, {
    ...state.roadmap,
    roadmapItems: normalizeColumnPriorities(result),
  }, {
    actor: input.actor ?? "user",
    operation: "card.move",
    summary: `Moved ${item.title} to ${STATUS_LABELS[input.status]}`,
    affectedCards: [item.id],
  });
  return { ...state, roadmap };
  });
}

export async function updateCard(input: {
  cwd: string;
  cardId: string;
  baseRevision?: number | undefined;
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

  const updatedItem: PlanbanRoadmapItem = {
    ...item,
    ...(input.summary !== undefined ? { summary: input.summary?.trim() || null } : {}),
    ...(input.nextAction !== undefined ? { nextAction: input.nextAction?.trim() || null } : {}),
    ...(input.tags !== undefined ? { tags: input.tags.map((tag) => tag.trim()).filter(Boolean) } : {}),
    ...(input.blockedBy !== undefined ? { blockedBy: input.blockedBy?.trim() || null } : {}),
    ...(input.metadata !== undefined ? (input.metadata === null ? {} : { metadata: input.metadata }) : {}),
    updatedAt: nowIso(),
  };

  if (input.metadata === null) delete updatedItem.metadata;

  const roadmap = await saveRoadmap(state, {
    ...state.roadmap,
    roadmapItems: state.roadmap.roadmapItems.map((entry) => entry.id === input.cardId ? updatedItem : entry),
  }, {
    actor: input.actor ?? "user",
    operation: "card.update",
    summary: `Updated ${item.title}`,
    affectedCards: [item.id],
  });
  return { ...state, roadmap };
  });
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

  const roadmap = await saveRoadmap(state, {
    ...state.roadmap,
    roadmapItems: normalizeColumnPriorities(reordered),
  }, {
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
  metadata?: Record<string, unknown> | undefined;
}): Promise<PlanbanResolvedState> {
  return withRoadmapWriteLock(input.cwd, async () => {
  const state = await loadState(input.cwd);
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
  const priority =
    state.roadmap.roadmapItems.filter((item) => item.status === status).length + 1;
  const timestamp = nowIso();
  const item: PlanbanRoadmapItem = {
    id,
    title: input.title.trim(),
    status,
    priority,
    summary: input.summary?.trim() || null,
    nextAction: input.nextAction?.trim() || null,
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: `items/${id}/spec.md`,
    planDoc: null,
    completedAt: null,
    updatedAt: timestamp,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };

  const roadmap = await saveRoadmap(state, {
    ...state.roadmap,
    roadmapItems: [...state.roadmap.roadmapItems, item],
  }, false);

  await mkdir(itemRoot(state.planningRoot, id), { recursive: true });
  const specPath = resolve(state.planningRoot, item.specDoc ?? `items/${id}/spec.md`);
  await mkdir(dirname(specPath), { recursive: true });
  await atomicWriteFile(
    specPath,
    `# ${input.title.trim()} Spec\n\n## Goal\n\n${input.summary?.trim() || "Describe the intended outcome."}\n\n## Next Action\n\n${input.nextAction?.trim() || "Define the next concrete step."}\n`,
  );
  await appendEvent(state.planningRoot, {
    type: "doc.written",
    at: nowIso(),
    cardId: id,
    kind: "spec",
    path: specPath,
  });
  await recordHistoryVersion({ ...state, roadmap }, roadmap, {
    actor: "user",
    operation: "card.create",
    summary: `Created ${item.title}`,
    affectedCards: [item.id],
    affectedDocs: [{ cardId: item.id, kind: "spec", path: item.specDoc }],
  });

  return { ...state, roadmap };
  });
}

export function docPathForItem(state: PlanbanResolvedState, item: PlanbanRoadmapItem, kind: "spec" | "plan") {
  const configured = kind === "spec" ? item.specDoc : item.planDoc;
  if (!configured) return null;
  return resolve(state.planningRoot, configured);
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

  const path = resolve(state.planningRoot, relativePath);
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
