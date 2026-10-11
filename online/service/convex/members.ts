// People on a board. The full invite design (link or email, viewer role,
// per-person agent levels) is owned by the shared-board-access card.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { boardAccess } from "./model/access";
import { fail } from "./model/errors";

export const list = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => {
    await boardAccess(ctx, connectionId, boardId);
    const members = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId)).collect();
    return members.map(({ userId, role }) => ({ userId, role }));
  },
});

export const add = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), userId: v.string(), role: v.union(v.literal("editor"), v.literal("viewer")) },
  handler: async (ctx, { connectionId, boardId, userId, role }) => {
    const access = await boardAccess(ctx, connectionId, boardId);
    if (!access.canAdminister) fail("forbidden", "Inviting people is kept for the board owner's own connection.");
    if (!userId.trim()) fail("validation", "userId is required.");
    const existing = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId).eq("userId", userId)).unique();
    if (existing?.role === "owner") fail("validation", "The owner's role cannot be changed here.");
    if (existing) await ctx.db.patch(existing._id, { role });
    else await ctx.db.insert("members", { boardId, userId, role });
    const members = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId)).collect();
    return members.map((member) => ({ userId: member.userId, role: member.role }));
  },
});
