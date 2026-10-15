// Unresolved changes (Spec point 20): an agent's edit refused because
// something it touched changed since it read it is kept, so it is never lost
// silently. It clears when an agent saves a reconsidered version of the same
// fields, or drops it with a reason; both go in the card's history. Agents see
// these; the web page never shows them.
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { BoardRows } from "./history";

/** At most this many kept per board; the oldest go first. */
const MAX_PER_BOARD = 200;

export interface UnresolvedChange {
  changeId: string;
  cardId: string;
  by: { userId: string; app: string };
  at: string;
  op: string;
  proposed: unknown;
  fields: string[];
  refusedAtRevision: number;
  message: string;
}

export function publicUnresolved(row: Doc<"unresolvedChanges">): UnresolvedChange {
  return { changeId: row.changeId, cardId: row.cardId, by: { userId: row.userId, app: row.clientName }, at: row.createdAt, op: row.op, proposed: row.proposed, fields: row.fields, refusedAtRevision: row.refusedAtRevision, message: row.message };
}

export async function recordUnresolved(ctx: MutationCtx, at: BoardRows, change: Omit<Doc<"unresolvedChanges">, "_id" | "_creationTime" | "boardId" | "generation" | "changeId">) {
  const changeId = crypto.randomUUID();
  await ctx.db.insert("unresolvedChanges", { ...at, changeId, ...change });
  const all = await ctx.db.query("unresolvedChanges").withIndex("by_board_card", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).collect();
  if (all.length > MAX_PER_BOARD) {
    for (const row of all.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, all.length - MAX_PER_BOARD)) await ctx.db.delete(row._id);
  }
  return changeId;
}

export async function unresolvedOn(ctx: QueryCtx, at: BoardRows, cardId?: string) {
  const rows = cardId
    ? await ctx.db.query("unresolvedChanges").withIndex("by_board_card", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", cardId)).collect()
    : await ctx.db.query("unresolvedChanges").withIndex("by_board_card", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).collect();
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * The unresolved changes an agent's successful edit settles: on the same card
 * and fields, made from a revision at or after the refusal (so its author had
 * seen what changed).
 */
export async function settledBy(ctx: QueryCtx, at: BoardRows, touched: Array<{ cardId: string; field: string }>, baseRevision: number | null) {
  const settled: Doc<"unresolvedChanges">[] = [];
  for (const cardId of new Set(touched.map((entry) => entry.cardId))) {
    const fields = new Set(touched.filter((entry) => entry.cardId === cardId).map((entry) => entry.field));
    for (const row of await unresolvedOn(ctx, at, cardId)) {
      if (baseRevision !== null && baseRevision < row.refusedAtRevision) continue;
      if (fields.has("*") || row.fields.includes("*") || row.fields.some((field) => fields.has(field))) settled.push(row);
    }
  }
  return settled;
}
