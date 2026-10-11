// Housekeeping: idempotency records expire after seven days, and uploads
// abandoned for a day are cancelled so their board id is released.
import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { abortTransfer } from "./model/transfer";

const OPERATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ABANDONED_TRANSFER_MS = 24 * 60 * 60 * 1000;
const BATCH = 200;

export const expireOperations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = new Date(Date.now() - OPERATION_TTL_MS).toISOString();
    const old = await ctx.db.query("operations").withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff)).take(BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === BATCH) await ctx.scheduler.runAfter(0, internal.maintenance.expireOperations, {});
  },
});

export const cancelAbandonedTransfers = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = new Date(Date.now() - ABANDONED_TRANSFER_MS).toISOString();
    const abandoned = await ctx.db.query("transfers").withIndex("by_state_updated", (q) => q.eq("state", "open").lt("updatedAt", cutoff)).take(BATCH);
    for (const transfer of abandoned) await abortTransfer(ctx, transfer);
    if (abandoned.length === BATCH) await ctx.scheduler.runAfter(0, internal.maintenance.cancelAbandonedTransfers, {});
  },
});
