// While something is being deleted (erasure.ts), nothing may bring it back.
// An account being deleted, or ever deleted, can't sign in, connect an app,
// be given a profile or be added to a board: deleted accounts are remembered
// only as a hash of their id. A deleted board's id stays reserved until its
// rows are gone.
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fail } from "./errors";
import { Sha256 } from "./sha256";

export function accountHash(userId: string) {
  const sha = new Sha256();
  sha.update(new TextEncoder().encode(`planban-account:${userId}`));
  return sha.hex();
}

export async function accountBeingDeleted(ctx: QueryCtx, userId: string) {
  if ((await ctx.db.query("erasures").withIndex("by_user", (q) => q.eq("userId", userId)).take(1)).length) return true;
  return (await ctx.db.query("retiredAccounts").withIndex("by_hash", (q) => q.eq("userHash", accountHash(userId))).take(1)).length > 0;
}

export async function refuseDeletedAccount(ctx: QueryCtx, userId: string) {
  if (await accountBeingDeleted(ctx, userId)) fail("unauthorized", "This Planban account has been deleted.");
}

/** Remembers a deleted account, by hash only. */
export async function retireAccount(ctx: MutationCtx, userId: string) {
  const userHash = accountHash(userId);
  if (!(await ctx.db.query("retiredAccounts").withIndex("by_hash", (q) => q.eq("userHash", userHash)).take(1)).length) await ctx.db.insert("retiredAccounts", { userHash });
}

export async function boardIdReserved(ctx: QueryCtx, boardId: string) {
  return (await ctx.db.query("erasures").withIndex("by_board", (q) => q.eq("boardId", boardId)).take(1)).length > 0;
}
