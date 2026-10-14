// What a Planban install subscribes to while a browser watches an Online
// Board: one small row. Convex pushes a new value when a change commits.
import { v } from "convex/values";
import { query } from "./_generated/server";
import { boardAccess } from "./model/access";
import { fail } from "./model/errors";

export const revision = query({
  args: { boardId: v.string() },
  handler: async (ctx, { boardId }) => {
    const identity = await ctx.auth.getUserIdentity();
    const connectionId = identity ? ctx.db.normalizeId("connections", identity.subject) : null;
    if (!connectionId) fail("unauthorized", "Sign in to Planban Online first.");
    const { board } = await boardAccess(ctx, connectionId!, boardId);
    return { revision: board.revision, authority: board.authority };
  },
});
