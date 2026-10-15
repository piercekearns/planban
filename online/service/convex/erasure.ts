// Deleting things for good (owner decisions, 15 October 2026).
//
// (a) A board taken back to a computer stays online as a read-only copy until
//     its owner deletes it: deleteBoardCopy, from Board settings on the web.
// (b) Deleting an account removes everything within 30 days: requestAccount,
//     run by the operator (see the release runbook) when someone emails
//     hello@planban.ai.
//
// Each deletion takes effect at once: the board, or the person's sign-ins and
// memberships, are gone in the same transaction. The stored rows are then
// removed in batches by `work`, recorded in `erasures` so a daily sweep
// finishes anything that stalled. Board rows are found by board id and
// generation; generations are numbered globally, so a board created later
// under the same id is never touched.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { boardAccess } from "./model/access";
import { fail } from "./model/errors";

const BATCH = 200;
/** What other people's boards show for changes made by an account that has been deleted. */
export const DELETED_ACCOUNT = "deleted-account";

const BOARD_ROWS = [
  ["historyDocs", "by_board_version"], ["historyPayloads", "by_board_version"], ["history", "by_board_version"],
  ["docs", "by_board_card_kind"], ["retiredIds", "by_board_card"], ["boardFingerprints", "by_board_generation"],
  ["cardChanges", "by_board_generation_card"], ["boardSizes", "by_board_generation"], ["boardState", "by_board_generation"],
] as const;

async function boardRow(ctx: QueryCtx, boardId: string) {
  return ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", boardId)).unique();
}

/**
 * Removes a board at once for everyone: its row, its people and its
 * invitations; keys limited to it stop reaching it. Its stored rows follow
 * in `work`.
 */
async function removeBoard(ctx: MutationCtx, board: Doc<"boards">, now: string) {
  let maxGeneration = board.generation;
  for (const transfer of await ctx.db.query("transfers").withIndex("by_board_state", (q) => q.eq("boardId", board.boardId)).collect()) {
    maxGeneration = Math.max(maxGeneration, transfer.generation);
  }
  const members = await ctx.db.query("members").withIndex("by_board", (q) => q.eq("boardId", board.boardId)).collect();
  for (const member of members) {
    for (const connection of await ctx.db.query("connections").withIndex("by_user", (q) => q.eq("userId", member.userId)).collect()) {
      if (connection.boards === "all" || !connection.boards.includes(board.boardId)) continue;
      const boards = connection.boards.filter((boardId) => boardId !== board.boardId);
      await ctx.db.patch(connection._id, boards.length ? { boards } : { boards, revokedAt: connection.revokedAt ?? now });
    }
    await ctx.db.delete(member._id);
  }
  for (const invite of await ctx.db.query("invites").withIndex("by_board", (q) => q.eq("boardId", board.boardId)).collect()) await ctx.db.delete(invite._id);
  await ctx.db.delete(board._id);
  await ctx.db.insert("erasures", { kind: "board", boardId: board.boardId, maxGeneration, requestedAt: now });
}

/** Deletes the read-only online copy of a board its owner took back to a computer. */
export const deleteBoardCopy = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), confirmTitle: v.string() },
  handler: async (ctx, { connectionId, boardId, confirmTitle }) => {
    const access = await boardAccess(ctx, connectionId, boardId);
    if (!access.canAdminister) fail("forbidden", "Only the board's owner can delete its online copy, from their own sign-in.");
    if (access.board.authority !== "returned-local") fail("conflict", "Only a board taken back to a computer has a read-only online copy to delete. Take it local first.");
    if (access.board.localTransfer) fail("conflict", "This board is still being taken back to a computer. Delete its online copy once that has finished.");
    if (confirmTitle.trim() !== access.board.title.trim()) fail("validation", "Type the board's name exactly to confirm.");
    await removeBoard(ctx, access.board, new Date().toISOString());
    await ctx.scheduler.runAfter(0, internal.erasure.work, {});
    return { deleted: true };
  },
});

/**
 * Starts deleting an account (operator only). At once: every sign-in, key and
 * app connection stops working; boards they own are deleted for everyone;
 * they leave other people's boards; invitations to their addresses go.
 */
export const eraseAccount = internalMutation({
  args: { userId: v.string(), emails: v.array(v.string()) },
  handler: async (ctx, { userId, emails }) => {
    if (!userId || userId === DELETED_ACCOUNT) fail("validation", "A user id is required.");
    const now = new Date().toISOString();
    for (const connection of await ctx.db.query("connections").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      if (!connection.revokedAt) await ctx.db.patch(connection._id, { revokedAt: now });
    }
    const owned: string[] = [];
    const scrubBoards: string[] = [];
    for (const member of await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId)).collect()) {
      const board = await boardRow(ctx, member.boardId);
      if (board && member.role === "owner") {
        owned.push(board.boardId);
        await removeBoard(ctx, board, now);
      } else {
        await ctx.db.delete(member._id);
        if (board) scrubBoards.push(board.boardId);
      }
    }
    // A board of theirs without an owner row (an upload that never finished) goes too.
    for await (const board of ctx.db.query("boards")) {
      if (board.ownerId === userId && !owned.includes(board.boardId)) {
        owned.push(board.boardId);
        await removeBoard(ctx, board, now);
      }
    }
    let invitesRemoved = 0;
    for (const email of new Set(emails.map((address) => address.trim().toLowerCase()).filter(Boolean))) {
      for (const invite of await ctx.db.query("invites").withIndex("by_email", (q) => q.eq("email", email)).collect()) {
        await ctx.db.delete(invite._id);
        invitesRemoved += 1;
      }
    }
    const existing = (await ctx.db.query("erasures").withIndex("by_kind", (q) => q.eq("kind", "account")).collect()).find((row) => row.userId === userId);
    if (existing) {
      await ctx.db.patch(existing._id, {
        scrubBoards: [...new Set([...(existing.scrubBoards ?? []), ...scrubBoards])],
        ownedBoards: [...new Set([...(existing.ownedBoards ?? []), ...owned])], stage: "history", cursor: null,
      });
    } else {
      await ctx.db.insert("erasures", { kind: "account", userId, scrubBoards, ownedBoards: owned, stage: "history", cursor: null, requestedAt: now });
    }
    await ctx.scheduler.runAfter(0, internal.erasure.work, {});
    return { boardsDeleted: owned.length, boardsLeft: scrubBoards.length, invitesRemoved };
  },
});

/** One batch of removal; schedules itself again while anything is left. */
export const work = internalMutation({
  args: {},
  handler: async (ctx) => {
    const pending = await ctx.db.query("erasures").take(10);
    let more = false;
    for (const erasure of pending) {
      more = (erasure.kind === "board" ? await purgeBoard(ctx, erasure) : await purgeAccount(ctx, erasure)) || more;
    }
    if (more) await ctx.scheduler.runAfter(0, internal.erasure.work, {});
  },
});

/** The daily sweep: finishes any deletion whose batches stopped (owner decision: within 30 days). */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (await ctx.db.query("erasures").first()) await ctx.scheduler.runAfter(0, internal.erasure.work, {});
    for (const row of await ctx.db.query("erasures").withIndex("by_kind", (q) => q.eq("kind", "account")).collect()) {
      if (row.stage === "clerk") await ctx.scheduler.runAfter(0, internal.erasure.deleteSignInAccount, { userId: row.userId! });
    }
  },
});

/** Removes a batch of a deleted board's stored rows. True while more remain. */
async function purgeBoard(ctx: MutationCtx, erasure: Doc<"erasures">): Promise<boolean> {
  const boardId = erasure.boardId!, max = erasure.maxGeneration!;
  let removed = 0;
  for (const [table, index] of BOARD_ROWS) {
    const rows = await (ctx.db.query(table) as any).withIndex(index, (q: any) => q.eq("boardId", boardId).lte("generation", max)).take(BATCH - removed);
    for (const row of rows) await ctx.db.delete(row._id);
    removed += rows.length;
    if (removed >= BATCH) return true;
  }
  for (const transfer of await ctx.db.query("transfers").withIndex("by_board_state", (q) => q.eq("boardId", boardId)).take(BATCH)) {
    if (transfer.generation > max) continue;
    const parts = await ctx.db.query("transferParts").withIndex("by_transfer_seq", (q) => q.eq("transferId", transfer.transferId)).take(BATCH);
    for (const part of parts) await ctx.db.delete(part._id);
    if (parts.length === BATCH) return true;
    await ctx.db.delete(transfer._id);
    removed += 1;
  }
  if (removed) return true;
  await ctx.db.delete(erasure._id);
  return false;
}

/**
 * An account's removal, in stages: their changes on other people's boards
 * (history, card faces, documents) are credited to "a deleted account"; then every row of theirs goes; last, the
 * sign-in account itself (Clerk). True while more remain.
 */
async function purgeAccount(ctx: MutationCtx, erasure: Doc<"erasures">): Promise<boolean> {
  const userId = erasure.userId!;
  const boards = erasure.scrubBoards ?? [];
  const stage = erasure.stage ?? "history";
  if (stage === "history" || stage === "cards" || stage === "docs" || stage === "invites") {
    const [boardId, ...rest] = boards;
    if (!boardId) {
      await ctx.db.patch(erasure._id, { stage: "rows", cursor: null });
      return true;
    }
    const next = (patch: Partial<Doc<"erasures">>) => ctx.db.patch(erasure._id, patch);
    if (stage === "history") {
      const page = await ctx.db.query("history").withIndex("by_board_version", (q) => q.eq("boardId", boardId)).paginate({ numItems: BATCH, cursor: erasure.cursor ?? null });
      for (const row of page.page) {
        if (row.entry?.attribution?.userId === userId) await ctx.db.patch(row._id, { entry: { ...row.entry, attribution: { ...row.entry.attribution, userId: DELETED_ACCOUNT } } });
      }
      await next(page.isDone ? { stage: "cards", cursor: null } : { cursor: page.continueCursor });
    } else if (stage === "cards") {
      const page = await ctx.db.query("cardChanges").withIndex("by_board_generation_card", (q) => q.eq("boardId", boardId)).paginate({ numItems: BATCH, cursor: erasure.cursor ?? null });
      for (const row of page.page) if (row.userId === userId) await ctx.db.patch(row._id, { userId: DELETED_ACCOUNT });
      await next(page.isDone ? { stage: "docs", cursor: null } : { cursor: page.continueCursor });
    } else if (stage === "docs") {
      const page = await ctx.db.query("docs").withIndex("by_board_card_kind", (q) => q.eq("boardId", boardId)).paginate({ numItems: BATCH, cursor: erasure.cursor ?? null });
      for (const row of page.page) if (row.updatedBy === userId) await ctx.db.patch(row._id, { updatedBy: DELETED_ACCOUNT });
      await next(page.isDone ? { stage: "invites", cursor: null } : { cursor: page.continueCursor });
    } else {
      for (const invite of await ctx.db.query("invites").withIndex("by_board", (q) => q.eq("boardId", boardId)).collect()) {
        if (invite.joinedBy.includes(userId)) await ctx.db.patch(invite._id, { joinedBy: invite.joinedBy.filter((id) => id !== userId) });
      }
      await next({ scrubBoards: rest, stage: "history", cursor: null });
    }
    return true;
  }
  if (stage === "rows") {
    let removed = 0;
    for (const connection of await ctx.db.query("connections").withIndex("by_user", (q) => q.eq("userId", userId)).take(BATCH)) {
      for (const refresh of await ctx.db.query("oauthRefresh").withIndex("by_connection", (q) => q.eq("connectionId", connection._id)).collect()) await ctx.db.delete(refresh._id);
      await ctx.db.delete(connection._id);
      removed += 1;
    }
    // Sign-in requests last minutes, so there are few; any naming them go.
    for await (const request of ctx.db.query("oauthRequests")) {
      if (request.userId === userId) {
        await ctx.db.delete(request._id);
        removed += 1;
      }
    }
    const byUser = [
      ctx.db.query("oauthRegistrations").withIndex("by_user", (q) => q.eq("userId", userId)),
      ctx.db.query("signInApprovals").withIndex("by_user_hour", (q) => q.eq("userId", userId)),
      ctx.db.query("usage").withIndex("by_user_day", (q) => q.eq("userId", userId)),
      ctx.db.query("operations").withIndex("by_user_key", (q) => q.eq("userId", userId)),
      ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", userId)),
    ];
    for (const query of byUser) {
      for (const row of await (query as any).take(BATCH)) {
        await ctx.db.delete(row._id);
        removed += 1;
      }
    }
    if (removed) return true;
    // Their boards' rows go first, so the account is only finished once nothing of theirs is left.
    const boardsLeft = (await ctx.db.query("erasures").withIndex("by_kind", (q) => q.eq("kind", "board")).collect())
      .some((row) => (erasure.ownedBoards ?? []).includes(row.boardId!));
    if (boardsLeft) return true;
    await ctx.db.patch(erasure._id, { stage: "clerk" });
    await ctx.scheduler.runAfter(0, internal.erasure.deleteSignInAccount, { userId });
    return false;
  }
  // Stage "clerk": waiting for deleteSignInAccount, which the daily sweep asks again.
  return false;
}

/** Deletes the person's Clerk user, the last step. Already gone counts as done. */
export const deleteSignInAccount = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const secret = process.env.CLERK_SECRET_KEY;
    // Without a sign-in service (local development) there is no sign-in account to delete.
    if (!secret) {
      await ctx.runMutation(internal.erasure.finishAccount, { userId });
      return { deleted: true };
    }
    const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      method: "DELETE", headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!response || (!response.ok && response.status !== 404)) return { deleted: false, reason: `sign-in service answered ${response?.status ?? "nothing"}` };
    await ctx.runMutation(internal.erasure.finishAccount, { userId });
    return { deleted: true };
  },
});

export const finishAccount = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    for (const row of await ctx.db.query("erasures").withIndex("by_kind", (q) => q.eq("kind", "account")).collect()) {
      if (row.userId === userId && row.stage === "clerk") await ctx.db.delete(row._id);
    }
  },
});

/**
 * The operator's command (release runbook): finds the account for an email
 * address in Clerk, or in Planban if Clerk no longer has it, and starts
 * deleting it. Refuses if the address matches more than one account.
 */
export const requestAccount = internalAction({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<{ userId: string; boardsDeleted: number; boardsLeft: number; invitesRemoved: number }> => {
    const address = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(address)) fail("validation", "Give the account's email address.");
    const secret = process.env.CLERK_SECRET_KEY;
    const found = new Map<string, Set<string>>();
    if (secret) {
      const response = await fetch(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(address)}`, {
        headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) fail("conflict", `The sign-in service answered ${response.status}; try again.`);
      for (const user of await response.json() as Array<{ id: string; email_addresses?: Array<{ email_address: string }> }>) {
        found.set(user.id, new Set([address, ...(user.email_addresses ?? []).map((entry) => entry.email_address.toLowerCase())]));
      }
    }
    for (const userId of await ctx.runQuery(internal.erasure.peopleByEmail, { email: address })) {
      if (!found.has(userId)) found.set(userId, new Set([address]));
    }
    if (found.size === 0) fail("not_found", `No account uses ${address}.`);
    if (found.size > 1) fail("conflict", `${address} matches ${found.size} accounts: ${[...found.keys()].join(", ")}. Delete them one at a time with eraseAccount.`);
    const [[userId, emails]] = [...found.entries()];
    const result = await ctx.runMutation(internal.erasure.eraseAccount, { userId: userId!, emails: [...emails!] });
    return { userId: userId!, ...result };
  },
});

export const peopleByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const rows = [
      ...await ctx.db.query("people").withIndex("by_email", (q) => q.eq("email", email)).collect(),
      ...(await ctx.db.query("people").collect()).filter((row) => row.email?.toLowerCase() === email && row.email !== email),
    ];
    return [...new Set(rows.map((row) => row.userId))];
  },
});

/** What is left of an account: all zero, and finished, once deletion is complete. */
export const accountStatus = internalQuery({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const count = async (query: any) => (await query.take(1000)).length;
    const erasure = (await ctx.db.query("erasures").withIndex("by_kind", (q) => q.eq("kind", "account")).collect()).find((row) => row.userId === userId);
    const left = {
      memberships: await count(ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", userId))),
      connections: await count(ctx.db.query("connections").withIndex("by_user", (q) => q.eq("userId", userId))),
      appRegistrations: await count(ctx.db.query("oauthRegistrations").withIndex("by_user", (q) => q.eq("userId", userId))),
      profile: await count(ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", userId))),
      usage: await count(ctx.db.query("usage").withIndex("by_user_day", (q) => q.eq("userId", userId))),
      retries: await count(ctx.db.query("operations").withIndex("by_user_key", (q) => q.eq("userId", userId))),
      ownedBoardsStillBeingRemoved: (await ctx.db.query("erasures").withIndex("by_kind", (q) => q.eq("kind", "board")).collect())
        .filter((row) => (erasure?.ownedBoards ?? []).includes(row.boardId!)).length,
    };
    return { finished: !erasure && Object.values(left).every((n) => n === 0), stage: erasure?.stage ?? null, left };
  },
});

