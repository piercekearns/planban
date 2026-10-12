// A starting total for boards stored before size accounting existed (see
// model/limits.ts). Run once after deploying the change to a backend that
// already holds boards:  npx convex run limits:backfillAll
// Each board's live generation is measured in small batches, then its total
// is replaced by what was measured.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { sizeOf } from "./model/limits";

const TABLES = ["boardState", "docs", "history", "historyPayloads", "historyDocs"] as const;
const BATCH = 100;

export const backfillAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    let scheduled = 0;
    for await (const board of ctx.db.query("boards")) {
      await ctx.scheduler.runAfter(0, internal.limits.backfillBoard, { boardId: board.boardId, generation: board.generation, table: 0, cursor: null, total: 0 });
      scheduled += 1;
    }
    return { scheduled };
  },
});

export const backfillBoard = internalMutation({
  args: { boardId: v.string(), generation: v.number(), table: v.number(), cursor: v.union(v.string(), v.null()), total: v.number() },
  handler: async (ctx, { boardId, generation, table, cursor, total }) => {
    const name = TABLES[table];
    if (!name) {
      const row = await ctx.db.query("boardSizes").withIndex("by_board_generation", (q) => q.eq("boardId", boardId).eq("generation", generation)).unique();
      if (row) await ctx.db.patch(row._id, { bytes: total });
      else await ctx.db.insert("boardSizes", { boardId, generation, bytes: total });
      return;
    }
    const index = name === "boardState" ? "by_board_generation" : name === "docs" ? "by_board_card_kind" : "by_board_version";
    const page = await (ctx.db.query(name) as any).withIndex(index, (q: any) => q.eq("boardId", boardId).eq("generation", generation)).paginate({ numItems: BATCH, cursor });
    let added = 0;
    for (const row of page.page as Array<Record<string, unknown>>) {
      if (name === "boardState") added += sizeOf(row.roadmap);
      else if (name === "docs" || name === "historyDocs") added += sizeOf(row.markdown);
      else if (name === "history") added += sizeOf(row.entry);
      else added += sizeOf(row.snapshot ?? row.delta ?? new Uint8Array());
    }
    await ctx.scheduler.runAfter(0, internal.limits.backfillBoard, page.isDone
      ? { boardId, generation, table: table + 1, cursor: null, total: total + added }
      : { boardId, generation, table, cursor: page.continueCursor, total: total + added });
  },
});
