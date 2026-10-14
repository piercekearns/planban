import type { MutationCtx } from "../_generated/server";
import type { BoardRows } from "./history";
import { addStored, sizeOf } from "./limits";

/** Reserve an identity exactly once and meter its stored text in this generation. */
export async function reserveRetiredId(ctx: MutationCtx, at: BoardRows, cardId: string) {
  const existing = await ctx.db.query("retiredIds").withIndex("by_board_card", (q) =>
    q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", cardId)).unique();
  if (existing) return;
  await addStored(ctx, at, sizeOf(cardId));
  await ctx.db.insert("retiredIds", { ...at, cardId });
}
