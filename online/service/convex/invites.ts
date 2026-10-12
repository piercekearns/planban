// Inviting people to a board (owner decisions 8 and 15): by link, which
// anyone may use for 7 days, or by email for one person. Each person still
// signs in with their own account; joining adds them with the invite's role.
// Only the owner's own sign-in can invite, see or cancel invites.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { boardAccess, liveConnection } from "./model/access";
import { fail } from "./model/errors";

/** Invite links last 7 days (owner decision 15). */
export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const inviteRole = v.union(v.literal("editor"), v.literal("viewer"));

function describe(invite: Doc<"invites">) {
  return {
    id: invite._id, role: invite.role, email: invite.email ?? null, createdAt: invite.createdAt, expiresAt: invite.expiresAt,
    joined: invite.joinedBy.length, revoked: !!invite.revokedAt,
  };
}

const usable = (invite: Doc<"invites">) => !invite.revokedAt && Date.parse(invite.expiresAt) > Date.now();

async function ownerAccess(ctx: Parameters<typeof boardAccess>[0], connectionId: Parameters<typeof boardAccess>[1], boardId: string) {
  const access = await boardAccess(ctx, connectionId, boardId);
  if (!access.canAdminister) fail("forbidden", "Inviting people is kept for the board owner's own sign-in.");
  return access;
}

export const create = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), tokenHash: v.string(), role: inviteRole, email: v.optional(v.string()) },
  handler: async (ctx, { connectionId, boardId, tokenHash, role, email }) => {
    const access = await ownerAccess(ctx, connectionId, boardId);
    if (access.board.authority !== "online" || access.board.localTransfer) fail("conflict", "People can only be invited while the board is online.");
    const address = email?.trim().toLowerCase();
    if (address !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) fail("validation", "That does not look like an email address.");
    const now = Date.now();
    const id = await ctx.db.insert("invites", {
      boardId, tokenHash, role, ...(address ? { email: address } : {}), createdBy: access.connection.userId,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + INVITE_LIFETIME_MS).toISOString(), joinedBy: [],
    });
    return { ...describe((await ctx.db.get(id))!), boardTitle: access.board.title };
  },
});

export const list = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => {
    await ownerAccess(ctx, connectionId, boardId);
    const invites = await ctx.db.query("invites").withIndex("by_board", (q) => q.eq("boardId", boardId)).collect();
    return { invites: invites.filter(usable).map(describe) };
  },
});

export const revoke = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), inviteId: v.string() },
  handler: async (ctx, { connectionId, boardId, inviteId }) => {
    await ownerAccess(ctx, connectionId, boardId);
    const id = ctx.db.normalizeId("invites", inviteId);
    const invite = id ? await ctx.db.get(id) : null;
    if (!invite || invite.boardId !== boardId) fail("not_found", "Invite not found.");
    await ctx.db.patch(invite!._id, { revokedAt: new Date().toISOString() });
    return { revoked: true };
  },
});

/** What an invite link shows before joining: the board's name and the role. Reveals nothing for a bad or old link. */
export const preview = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const invite = await ctx.db.query("invites").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!invite || !usable(invite)) return null;
    const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", invite.boardId)).unique();
    if (!board || board.authority !== "online") return null;
    return { boardTitle: board.title, role: invite.role, expiresAt: invite.expiresAt, forEmail: !!invite.email };
  },
});

/**
 * Joining from an invite, with the person's own sign-in. A link works for
 * anyone until it expires; an email invite only for the account with that
 * email. Someone already on the board keeps their role.
 */
export const accept = internalMutation({
  args: { connectionId: v.id("connections"), tokenHash: v.string() },
  handler: async (ctx, { connectionId, tokenHash }) => {
    const connection = await liveConnection(ctx, connectionId);
    if (!connection.canAdminister) fail("forbidden", "Join a board from your own sign-in, not from an agent or key.");
    const invite = await ctx.db.query("invites").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!invite || !usable(invite)) fail("not_found", "This invite has expired or was cancelled. Ask the board owner for a new one.");
    const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", invite!.boardId)).unique();
    if (!board || board.authority !== "online" || board.localTransfer) fail("conflict", "This board is not online at the moment. Ask the board owner.");
    if (invite!.email) {
      const profile = await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", connection.userId)).unique();
      if (profile?.email?.toLowerCase() !== invite!.email) fail("forbidden", `This invite is for ${invite!.email}. Sign in with that email address to join.`);
    }
    const existing = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", board!.boardId).eq("userId", connection.userId)).unique();
    if (!existing) await ctx.db.insert("members", { boardId: board!.boardId, userId: connection.userId, role: invite!.role });
    if (!invite!.joinedBy.includes(connection.userId)) {
      await ctx.db.patch(invite!._id, {
        joinedBy: [...invite!.joinedBy, connection.userId],
        // An email invite is for one person: used once.
        ...(invite!.email ? { revokedAt: new Date().toISOString() } : {}),
      });
    }
    return { boardId: board!.boardId, title: board!.title, role: existing?.role ?? invite!.role, alreadyMember: !!existing };
  },
});
