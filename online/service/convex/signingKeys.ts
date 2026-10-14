// Clerk's published signing keys, cached in the database: an HTTP action's
// memory does not reliably outlive its request, so a cache there would mean
// fetching the key set for every token. Refreshes are claimed here first, so
// the whole service fetches it at most once per cooldown however many tokens
// with made-up key ids arrive.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const NAME = "clerk";

export const cached = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("signingKeys").withIndex("by_name", (q) => q.eq("name", NAME)).first();
    return row ? { keys: row.keys, fetchedAt: row.fetchedAt } : null;
  },
});

/** True if this caller may fetch the key set now; nobody else may until the cooldown passes. */
export const claimRefresh = internalMutation({
  args: { cooldownMs: v.number() },
  handler: async (ctx, { cooldownMs }) => {
    const now = Date.now();
    const row = await ctx.db.query("signingKeys").withIndex("by_name", (q) => q.eq("name", NAME)).first();
    if (row && now - row.attemptedAt < cooldownMs) return false;
    if (row) await ctx.db.patch(row._id, { attemptedAt: now });
    else await ctx.db.insert("signingKeys", { name: NAME, keys: "[]", fetchedAt: 0, attemptedAt: now });
    return true;
  },
});

export const store = internalMutation({
  args: { keys: v.string() },
  handler: async (ctx, { keys }) => {
    const row = await ctx.db.query("signingKeys").withIndex("by_name", (q) => q.eq("name", NAME)).first();
    if (row) await ctx.db.patch(row._id, { keys, fetchedAt: Date.now() });
    else await ctx.db.insert("signingKeys", { name: NAME, keys, fetchedAt: Date.now(), attemptedAt: Date.now() });
  },
});
