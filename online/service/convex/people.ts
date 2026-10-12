// How people appear on shared boards (owner decision 15): a face on every
// card showing who last changed it, with a small robot when their agent did,
// and the people list with what each person's agents may do. Names and
// pictures come from the person's sign-in account at Clerk.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { agentLevel } from "./schema";
import { boardAccess, memberAgentLevel, roleLevel } from "./model/access";
import { fail } from "./model/errors";

/** History versions read to find each card's latest change. */
const ACTIVITY_DEPTH = 400;

/** Fetches a person's name and picture from Clerk. Development sign-ins have none. */
export const refresh = internalAction({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const secret = process.env.CLERK_SECRET_KEY;
    if (!secret || !/^user_[A-Za-z0-9]+$/.test(userId)) return;
    const response = await fetch(`https://api.clerk.com/v1/users/${userId}`, { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) return;
    const user = await response.json() as {
      first_name?: string | null; last_name?: string | null; username?: string | null; image_url?: string | null; has_image?: boolean;
      primary_email_address_id?: string | null; email_addresses?: Array<{ id: string; email_address: string }>;
    };
    const email = user.email_addresses?.find((address) => address.id === user.primary_email_address_id)?.email_address;
    const name = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || email?.split("@")[0] || userId;
    await ctx.runMutation(internal.people.store, {
      userId, name,
      ...(user.has_image && user.image_url ? { imageUrl: user.image_url } : {}),
      ...(email ? { email } : {}),
    });
  },
});

export const store = internalMutation({
  args: { userId: v.string(), name: v.string(), imageUrl: v.optional(v.string()), email: v.optional(v.string()) },
  handler: async (ctx, profile) => {
    const existing = await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", profile.userId)).unique();
    const row = { ...profile, imageUrl: profile.imageUrl, email: profile.email, updatedAt: new Date().toISOString() };
    if (existing) await ctx.db.patch(existing._id, row);
    else await ctx.db.insert("people", row);
  },
});

interface CardChange {
  userId: string;
  /** True when the person's agent made the change. */
  agent: boolean;
  clientName: string | null;
  at: string;
  summary: string;
}

/**
 * The people on a board, what each one's agents may do, and who last changed
 * each card. Everyone on the board sees all of it (owner decision 15).
 */
export const forBoard = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => {
    const access = await boardAccess(ctx, connectionId, boardId);
    const members = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId)).collect();
    const profiles = new Map<string, Doc<"people">>();
    for (const member of members) {
      const profile = await ctx.db.query("people").withIndex("by_userId", (q) => q.eq("userId", member.userId)).unique();
      if (profile) profiles.set(member.userId, profile);
    }
    const people = members.map((member) => {
      const profile = profiles.get(member.userId);
      return {
        userId: member.userId,
        name: profile?.name ?? member.userId,
        imageUrl: profile?.imageUrl ?? null,
        // Email is shown to others on the board only; it helps tell people apart.
        email: profile?.email ?? null,
        role: member.role,
        agentLevel: memberAgentLevel(member),
        you: member.userId === access.connection.userId,
      };
    });
    // Each card's latest change, newest history first.
    const cards: Record<string, CardChange> = {};
    const owner = members.find((member) => member.role === "owner")?.userId ?? access.board.ownerId;
    const rows = await ctx.db.query("history").withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", access.board.generation)).order("desc").take(ACTIVITY_DEPTH);
    for (const row of rows) {
      const entry = row.entry as { createdAt: string; actor: string; summary: string; affectedCards?: string[]; affectedDocs?: Array<{ cardId: string }>; attribution?: { userId: string; clientName: string; actor: string } };
      // Versions brought in from Local Mode carry no account: they were the owner's, or the owner's agents'.
      const change: CardChange = entry.attribution
        ? { userId: entry.attribution.userId, agent: entry.attribution.actor === "agent", clientName: entry.attribution.actor === "agent" ? entry.attribution.clientName : null, at: entry.createdAt, summary: entry.summary }
        : { userId: owner, agent: entry.actor === "agent", clientName: null, at: entry.createdAt, summary: entry.summary };
      for (const cardId of [...(entry.affectedCards ?? []), ...(entry.affectedDocs ?? []).map((doc) => doc.cardId)]) {
        cards[cardId] ??= change;
      }
    }
    return { shared: members.length > 1, people, cards };
  },
});

/** A person chooses what their own agents may do on a board, up to what their role allows. */
export const setAgentLevel = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), level: agentLevel },
  handler: async (ctx, { connectionId, boardId, level }) => {
    const access = await boardAccess(ctx, connectionId, boardId);
    if (!access.connection.canAdminister) fail("forbidden", "Change what your agents may do from your own sign-in, not from an agent.");
    const allowed = roleLevel(access.role);
    if (level === "complete" && allowed !== "complete" || level !== "read" && allowed === "read") fail("forbidden", "Your agents cannot do more than you can on this board.");
    const member = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId).eq("userId", access.connection.userId)).unique();
    await ctx.db.patch(member!._id, { agentLevel: level });
    return { agentLevel: level };
  },
});
