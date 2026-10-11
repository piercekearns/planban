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

export async function roadmapAtVersion(ctx: QueryCtx, boardId: string, version: number): Promise<PlanbanRoadmap | null> {
  const rows: Doc<"history">[] = [];
  for await (const row of ctx.db.query("history")
    .withIndex("by_board_version", (q) => q.eq("boardId", boardId).lte("version", version))
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

export async function recordHistory(ctx: MutationCtx, input: {
  board: Doc<"boards">;
  previous: PlanbanRoadmap | null;
  committed: PlanbanRoadmap;
  history: PlannedHistory;
  docs: Array<{ cardId: string; kind: "spec" | "plan"; markdown: string }>;
  attribution: Attribution;
  now: string;
}): Promise<number> {
  const { board, previous, committed, history, docs, attribution, now } = input;
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
    boardId: board.boardId,
    version,
    entry,
    ...(snapshot ? { snapshot: packJson(committed) } : { delta: packJson(diff(previous!, committed)) }),
  });
  for (const doc of docs) {
    await ctx.db.insert("historyDocs", { boardId: board.boardId, version, cardId: doc.cardId, kind: doc.kind, markdown: packText(doc.markdown) });
  }
  await ctx.db.patch(board._id, { historyVersion: version });
  await prune(ctx, board.boardId, version - MAX_HISTORY_VERSIONS);
  return version;
}

/** Stores an imported history version as written by the local board. */
export async function importHistoryVersion(ctx: MutationCtx, boardId: string, entry: PlanbanHistoryEntry, roadmap: PlanbanRoadmap) {
  await ctx.db.insert("history", { boardId, version: entry.version, entry, snapshot: packJson(roadmap) });
}

/** Drops versions at or below the cutoff, keeping a snapshot at the start of what remains. */
async function prune(ctx: MutationCtx, boardId: string, cutoff: number) {
  if (cutoff <= 0) return;
  const first = await ctx.db.query("history")
    .withIndex("by_board_version", (q) => q.eq("boardId", boardId).gt("version", cutoff))
    .first();
  if (first && !first.snapshot) {
    const roadmap = await roadmapAtVersion(ctx, boardId, first.version);
    await ctx.db.patch(first._id, { snapshot: packJson(roadmap), delta: undefined });
  }
  const old = await ctx.db.query("history")
    .withIndex("by_board_version", (q) => q.eq("boardId", boardId).lte("version", cutoff))
    .take(PRUNE_BATCH);
  for (const row of old) {
    await ctx.db.delete(row._id);
    for (const doc of await ctx.db.query("historyDocs").withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("version", row.version)).collect()) {
      await ctx.db.delete(doc._id);
    }
  }
}
