// While something is being deleted (erasure.ts), nothing may bring it back:
// an account being deleted can't sign in, connect an app or be given a
// profile, and a deleted board's id stays reserved until its rows are gone.
import type { QueryCtx } from "../_generated/server";
import { fail } from "./errors";

export async function accountBeingDeleted(ctx: QueryCtx, userId: string) {
  return (await ctx.db.query("erasures").withIndex("by_user", (q) => q.eq("userId", userId)).take(1)).length > 0;
}

export async function refuseDeletedAccount(ctx: QueryCtx, userId: string) {
  if (await accountBeingDeleted(ctx, userId)) fail("unauthorized", "This Planban account has been deleted.");
}

export async function boardIdReserved(ctx: QueryCtx, boardId: string) {
  return (await ctx.db.query("erasures").withIndex("by_board", (q) => q.eq("boardId", boardId)).take(1)).length > 0;
}
