// Stale local copies (owner decision 14). A machine that still holds a local
// copy of a board that has since been taken online asks here, sending short
// fingerprints of its newest history entries. Copies of one board share
// their history, so a match means "this is the same board". Only boards the
// caller belongs to are compared, and nothing is revealed about others.
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { liveConnection, reaches } from "./model/access";

const MAX_FINGERPRINTS = 50;

export const check = internalQuery({
  args: {
    connectionId: v.id("connections"),
    fingerprints: v.array(v.object({ version: v.number(), createdAt: v.string(), operation: v.string() })),
  },
  handler: async (ctx, { connectionId, fingerprints }) => {
    const connection = await liveConnection(ctx, connectionId);
    const wanted = fingerprints.slice(0, MAX_FINGERPRINTS);
    const matches = [];
    for (const member of await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", connection.userId)).collect()) {
      if (!reaches(connection, member.boardId)) continue;
      const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", member.boardId)).unique();
      if (!board || board.authority !== "online") continue;
      const matchedVersions: number[] = [];
      for (const fingerprint of wanted) {
        const row = await ctx.db.query("history")
          .withIndex("by_board_version", (q) => q.eq("boardId", board.boardId).eq("generation", board.generation).eq("version", fingerprint.version))
          .unique();
        const entry = row?.entry as { createdAt?: string; operation?: string } | undefined;
        if (entry && entry.createdAt === fingerprint.createdAt && entry.operation === fingerprint.operation) matchedVersions.push(fingerprint.version);
      }
      if (matchedVersions.length > 0) {
        matches.push({ boardId: board.boardId, title: board.title, onlineSince: board.onlineSince ?? board.updatedAt, matchedVersions });
      }
    }
    return { matches };
  },
});
