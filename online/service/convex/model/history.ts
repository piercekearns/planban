// Board history: one row per version. Full roadmaps are kept every
// SNAPSHOT_EVERY versions; versions in between store only what changed, which
// keeps a busy board inside the free plan's database traffic.
import type { PlannedHistory } from "../../../../src/core/boardOperations";
import type { PlanbanHistoryEntry, PlanbanRoadmap, PlanbanRoadmapItem } from "../../../../src/core/types";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { packJson, packText, unpackJson } from "./codec";

export const SNAPSHOT_EVERY = 25;
export const MAX_HISTORY_VERSIONS = 1000;
const PRUNE_BATCH = 50;

/** Who made a change: the signed-in person, the connected app and whether a person or an agent acted. */
export interface Attribution {
  userId: string;
  clientName: string;
  actor: "user" | "agent";
  connectionId: string;
}

interface Delta {
  meta: Omit<PlanbanRoadmap, "roadmapItems">;
  order: string[];
  items: Record<string, PlanbanRoadmapItem>;
}

function diff(previous: PlanbanRoadmap, next: PlanbanRoadmap): Delta {
  const before = new Map(previous.roadmapItems.map((item) => [item.id, JSON.stringify(item)]));
  const items: Record<string, PlanbanRoadmapItem> = {};
  for (const item of next.roadmapItems) {
    if (before.get(item.id) !== JSON.stringify(item)) items[item.id] = item;
  }
  const { roadmapItems, ...meta } = next;
  return { meta, order: roadmapItems.map((item) => item.id), items };
}

function apply(previous: PlanbanRoadmap, delta: Delta): PlanbanRoadmap {
  const before = new Map(previous.roadmapItems.map((item) => [item.id, item]));
  return {
    ...delta.meta,
    roadmapItems: delta.order.map((id) => {
      const item = delta.items[id] ?? before.get(id);
      if (!item) throw new Error(`History is missing card ${id}.`);
      return item;
    }),
  } as PlanbanRoadmap;
}

/** A board's rows in one generation. */
export interface BoardRows {
  boardId: string;
  generation: number;
}

export async function roadmapAtVersion(ctx: QueryCtx, at: BoardRows, version: number): Promise<PlanbanRoadmap | null> {
  const { boardId, generation } = at;
  const rows: Doc<"history">[] = [];
  for await (const row of ctx.db.query("history")
    .withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", generation).lte("version", version))
    .order("desc")) {
    rows.push(row);
    if (row.snapshot) break;
  }
  if (rows.length === 0 || rows[0]!.version !== version) return null;
  const base = rows.pop()!;
  if (!base.snapshot) throw new Error(`History for ${boardId} has no snapshot before version ${version}.`);
  let roadmap = unpackJson<PlanbanRoadmap>(base.snapshot);
  for (const row of rows.reverse()) roadmap = apply(roadmap, unpackJson<Delta>(row.delta!));
  return roadmap;
}

/** History versions after `after`, oldest first, each with its full roadmap. */
export async function historyPage(ctx: QueryCtx, at: BoardRows, after: number, limit: number) {
  const rows = await ctx.db.query("history")
    .withIndex("by_board_version", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).gt("version", after))
    .take(limit);
  const page: Array<{ entry: PlanbanHistoryEntry; roadmap: PlanbanRoadmap }> = [];
  let previous: PlanbanRoadmap | null = null;
  for (const row of rows) {
    const roadmap: PlanbanRoadmap | null = row.snapshot
      ? unpackJson<PlanbanRoadmap>(row.snapshot)
      : previous
        ? apply(previous, unpackJson<Delta>(row.delta!))
        : await roadmapAtVersion(ctx, at, row.version);
    page.push({ entry: row.entry as PlanbanHistoryEntry, roadmap: roadmap! });
    previous = roadmap;
  }
  return page;
}

export async function recordHistory(ctx: MutationCtx, input: {
  board: Doc<"boards">;
  /** Defaults to the board's live generation. */
  generation?: number;
  previous: PlanbanRoadmap | null;
  committed: PlanbanRoadmap;
  history: PlannedHistory;
  docs: Array<{ cardId: string; kind: "spec" | "plan"; markdown: string }>;
  attribution: Attribution;
  now: string;
}): Promise<number> {
  const { board, previous, committed, history, docs, attribution, now } = input;
  const at = { boardId: board.boardId, generation: input.generation ?? board.generation };
  const version = board.historyVersion + 1;
  const entry: PlanbanHistoryEntry & { attribution: Omit<Attribution, "connectionId"> } = {
    version,
    roadmapRevision: committed.revision,
    createdAt: now,
    actor: history.actor,
    operation: history.operation,
    summary: history.summary,
    affectedCards: [...new Set(history.affectedCards)],
    affectedDocs: history.affectedDocs ?? [],
    attribution: { userId: attribution.userId, clientName: attribution.clientName, actor: attribution.actor },
  };
  const snapshot = !previous || version % SNAPSHOT_EVERY === 0;
  await ctx.db.insert("history", {
    ...at,
    version,
    entry,
    ...(snapshot ? { snapshot: packJson(committed) } : { delta: packJson(diff(previous!, committed)) }),
  });
  for (const doc of docs) {
    await ctx.db.insert("historyDocs", { ...at, version, cardId: doc.cardId, kind: doc.kind, markdown: packText(doc.markdown) });
  }
  await ctx.db.patch(board._id, { historyVersion: version });
  await prune(ctx, at, version - MAX_HISTORY_VERSIONS);
  return version;
}

/** Stores an uploaded history version as written by the local board. */
export async function importHistoryVersion(ctx: MutationCtx, at: BoardRows, entry: PlanbanHistoryEntry, roadmap: PlanbanRoadmap) {
  await ctx.db.insert("history", { ...at, version: entry.version, entry, snapshot: packJson(roadmap) });
}

/** Drops versions at or below the cutoff, keeping a snapshot at the start of what remains. */
async function prune(ctx: MutationCtx, at: BoardRows, cutoff: number) {
  if (cutoff <= 0) return;
  const { boardId, generation } = at;
  const first = await ctx.db.query("history")
    .withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", generation).gt("version", cutoff))
    .first();
  if (first && !first.snapshot) {
    const roadmap = await roadmapAtVersion(ctx, at, first.version);
    await ctx.db.patch(first._id, { snapshot: packJson(roadmap), delta: undefined });
  }
  const old = await ctx.db.query("history")
    .withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", generation).lte("version", cutoff))
    .take(PRUNE_BATCH);
  for (const row of old) {
    await ctx.db.delete(row._id);
    for (const doc of await ctx.db.query("historyDocs").withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", generation).eq("version", row.version)).collect()) {
      await ctx.db.delete(doc._id);
    }
  }
}
