// Connections: every credential resolves to one row, re-checked on every
// request. Bearer secrets Planban issues itself are stored only as hashes.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { agentLevel } from "./schema";

/** A connection is marked used at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export const resolveToken = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const connection = await ctx.db.query("connections").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!connection || connection.revokedAt) return null;
    if (connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now()) return null;
    return { connectionId: connection._id, lastUsedAt: connection.lastUsedAt };
  },
});

export const touch = internalMutation({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await ctx.db.get(connectionId);
    if (!connection || connection.revokedAt) return;
    if (Date.now() - Date.parse(connection.lastUsedAt) < TOUCH_INTERVAL_MS) return;
    await ctx.db.patch(connectionId, { lastUsedAt: new Date().toISOString() });
  },
});


/** Development sign-in: only reachable when the HTTP layer allows it (local backends). */
export const createDevConnection = internalMutation({
  args: {
    tokenHash: v.string(),
    userId: v.string(),
    clientName: v.string(),
    boards: v.union(v.literal("all"), v.array(v.string())),
    level: agentLevel,
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const id = await ctx.db.insert("connections", {
      userId: args.userId,
      kind: "dev",
      name: args.clientName,
      clientName: args.clientName,
      tokenHash: args.tokenHash,
      boards: args.boards,
      level: args.level,
      canAdminister: args.boards === "all",
      createdAt: now,
      lastUsedAt: now,
    });
    return { connectionId: id };
  },
});
