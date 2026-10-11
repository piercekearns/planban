// Background continuation of history pruning, so a board never stays above
// its retention cap even when nobody edits it.
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { pruneHistory } from "./model/history";

export const prune = internalMutation({
  args: { boardId: v.string(), generation: v.number(), cutoff: v.number() },
  handler: async (ctx, { boardId, generation, cutoff }) => {
    const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", boardId)).unique();
    if (!board || board.generation !== generation) return;
    await pruneHistory(ctx, { boardId, generation }, cutoff);
  },
});
