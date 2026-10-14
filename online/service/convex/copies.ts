// Stale local copies (owner decision 14). A machine that still holds a local
// copy of a board that has since been taken online asks here. A copy is
// recognised by the board's durable identity, which every copy of its folder
// carries; boards made before identities existed are recognised by at least
// two history entries they share with what the board arrived online with.
// Only boards the caller belongs to are compared, and nothing is revealed
// about others.
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalQuery, type QueryCtx } from "./_generated/server";
import { liveConnection, reaches } from "./model/access";

const MAX_FINGERPRINTS = 120;

export const check = internalQuery({
  args: {
    connectionId: v.id("connections"),
    uid: v.optional(v.string()),
    fingerprints: v.array(v.object({ version: v.number(), createdAt: v.string(), operation: v.string() })),
  },
  handler: async (ctx, { connectionId, uid, fingerprints }) => {
    const connection = await liveConnection(ctx, connectionId);
    const memberOf = new Set((await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", connection.userId)).collect())
      .map((member) => member.boardId).filter((boardId) => reaches(connection, boardId)));
    const boards = new Map<string, Doc<"boards"> | null>();
    const liveBoard = async (boardId: string) => {
      if (!boards.has(boardId)) {
        const board = memberOf.has(boardId) ? await boardRow(ctx, boardId) : null;
        boards.set(boardId, board && board.authority === "online" ? board : null);
      }
      return boards.get(boardId) ?? null;
    };
    const matched = new Map<string, number[]>();
    const wanted = fingerprints.slice(0, MAX_FINGERPRINTS);
    for (const fingerprint of wanted) {
      const key = `${fingerprint.version}|${fingerprint.createdAt}|${fingerprint.operation}`;
      for (const row of await ctx.db.query("boardFingerprints").withIndex("by_key", (q) => q.eq("key", key)).collect()) {
        const board = await liveBoard(row.boardId);
        if (!board || board.generation !== row.generation) continue;
        matched.set(board.boardId, [...(matched.get(board.boardId) ?? []), fingerprint.version]);
      }
    }
    const identified = new Set<string>();
    if (uid) {
      for (const board of await ctx.db.query("boards").withIndex("by_uid", (q) => q.eq("uid", uid)).collect()) {
        if (await liveBoard(board.boardId)) identified.add(board.boardId);
      }
    }
    const matches = [];
    for (const boardId of new Set([...identified, ...matched.keys()])) {
      const versions = [...new Set(matched.get(boardId) ?? [])];
      // One shared entry could be a coincidence; the durable identity, or two
      // shared entries, cannot.
      if (!identified.has(boardId) && versions.length < Math.min(2, wanted.length)) continue;
      const board = (await liveBoard(boardId))!;
      matches.push({ boardId, title: board.title, onlineSince: board.onlineSince ?? board.updatedAt, matchedVersions: versions, sameIdentity: identified.has(boardId) });
    }
    return { matches };
  },
});

async function boardRow(ctx: QueryCtx, boardId: string) {
  return ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", boardId)).unique();
}
