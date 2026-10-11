// Who may do what. Every request names a connection; it is re-read inside the
// same transaction as the work, so a revoked connection stops at once.
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { fail } from "./errors";

export const BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A machine's sign-in lasts until it signs out or goes this long unused (owner decision 6). */
export const IDLE_SIGN_OUT_MS = 90 * 24 * 60 * 60 * 1000;

export function connectionIsUsable(connection: Doc<"connections"> | null): connection is Doc<"connections"> {
  if (!connection || connection.revokedAt) return false;
  if (connection.expiresAt && Date.parse(connection.expiresAt) <= Date.now()) return false;
  if ((connection.kind === "machine" || connection.kind === "dev") && Date.now() - Date.parse(connection.lastUsedAt) > IDLE_SIGN_OUT_MS) return false;
  return true;
}

export async function liveConnection(ctx: QueryCtx, connectionId: Id<"connections">): Promise<Doc<"connections">> {
  const connection = await ctx.db.get(connectionId);
  if (!connectionIsUsable(connection)) fail("unauthorized", "This Planban connection was signed out, revoked or unused for 90 days. Sign in again.");
  return connection!;
}

export function reaches(connection: Doc<"connections">, boardId: string) {
  return connection.boards === "all" || connection.boards.includes(boardId);
}

export interface BoardAccess {
  connection: Doc<"connections">;
  board: Doc<"boards">;
  role: Doc<"members">["role"];
  canWrite: boolean;
  /** The owner's own connection: completing, deleting, moving authority and inviting. */
  canAdminister: boolean;
  canComplete: boolean;
}

/** The caller's access to a board, or a not-found error that does not reveal whether the board exists. */
export async function boardAccess(ctx: QueryCtx, connectionId: Id<"connections">, boardId: string): Promise<BoardAccess> {
  const connection = await liveConnection(ctx, connectionId);
  const missing = () => fail("not_found", `Online Board not found: ${boardId}`);
  if (!BOARD_ID_PATTERN.test(boardId) || !reaches(connection, boardId)) missing();
  const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", boardId)).unique();
  if (!board) missing();
  const member = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId).eq("userId", connection.userId)).unique();
  if (!member) missing();
  const canWrite = member!.role !== "viewer" && connection.level !== "read";
  const canAdminister = member!.role === "owner" && connection.canAdminister;
  return {
    connection,
    board: board!,
    role: member!.role,
    canWrite,
    canAdminister,
    canComplete: canAdminister || (canWrite && member!.role === "owner" && connection.level === "complete"),
  };
}
