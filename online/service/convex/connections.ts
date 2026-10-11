// Connections: every credential resolves to one row, re-checked on every
// request. Bearer secrets Planban issues itself are stored only as hashes.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { BOARD_ID_PATTERN, boardAccess, connectionIsUsable, liveConnection } from "./model/access";
import { fail } from "./model/errors";
import { agentLevel } from "./schema";

/** A connection is marked used at most this often, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export const resolveToken = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const connection = await ctx.db.query("connections").withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash)).unique();
    if (!connectionIsUsable(connection)) return null;
    return { connectionId: connection._id, lastUsedAt: connection.lastUsedAt };
  },
});

export const touch = internalMutation({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await ctx.db.get(connectionId);
    if (!connection || connection.revokedAt) return;
    if (Date.now() - Date.parse(connection.lastUsedAt) < TOUCH_INTERVAL_MS) return;
    await ctx.db.patch(connectionId, { lastUsedAt: new Date().toISOString() });
  },
});


/** Development sign-in: only reachable when the HTTP layer allows it (local backends). */
export const createDevConnection = internalMutation({
  args: {
    tokenHash: v.string(),
    userId: v.string(),
    clientName: v.string(),
    boards: v.union(v.literal("all"), v.array(v.string())),
    level: agentLevel,
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const id = await ctx.db.insert("connections", {
      userId: args.userId,
      kind: "dev",
      name: args.clientName,
      clientName: args.clientName,
      tokenHash: args.tokenHash,
      boards: args.boards,
      level: args.level,
      canAdminister: args.boards === "all",
      createdAt: now,
      lastUsedAt: now,
    });
    return { connectionId: id };
  },
});

function describe(connection: Doc<"connections">, currentId: string) {
  return {
    id: connection._id,
    kind: connection.kind,
    name: connection.name,
    clientName: connection.clientName,
    boards: connection.boards,
    level: connection.level,
    createdAt: connection.createdAt,
    lastUsedAt: connection.lastUsedAt,
    ...(connection.expiresAt ? { expiresAt: connection.expiresAt } : {}),
    ...(connection.revokedAt ? { revokedAt: connection.revokedAt } : {}),
    active: connectionIsUsable(connection),
    current: connection._id === currentId,
  };
}

/**
 * The connections page: a person's own connection sees every machine, agent
 * and key of theirs; anything narrower sees only itself.
 */
export const list = internalQuery({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await liveConnection(ctx, connectionId);
    if (!connection.canAdminister) return { connections: [describe(connection, connectionId)] };
    const all = await ctx.db.query("connections").withIndex("by_user", (q) => q.eq("userId", connection.userId)).collect();
    return { connections: all.map((row) => describe(row, connectionId)) };
  },
});

/** Cuts a connection off at once. Signing out revokes the machine's own connection. */
export const revoke = internalMutation({
  args: { connectionId: v.id("connections"), targetId: v.string() },
  handler: async (ctx, { connectionId, targetId }) => {
    const connection = await liveConnection(ctx, connectionId);
    const id = targetId === "self" ? connectionId : ctx.db.normalizeId("connections", targetId);
    const target = id ? await ctx.db.get(id) : null;
    const allowed = target && (target._id === connectionId || (connection.canAdminister && target.userId === connection.userId));
    if (!allowed) fail("not_found", "Connection not found.");
    if (!target!.revokedAt) await ctx.db.patch(target!._id, { revokedAt: new Date().toISOString() });
    return { revoked: true, id: target!._id };
  },
});

/**
 * Personal access keys (owner decision 5): named, for one board, at one
 * level, optionally expiring. Created from the person's own connection; the
 * key itself is shown once and only its hash is kept.
 */
export const createKey = internalMutation({
  args: {
    connectionId: v.id("connections"),
    tokenHash: v.string(),
    name: v.string(),
    boardId: v.string(),
    level: agentLevel,
    expiresAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const connection = await liveConnection(ctx, args.connectionId);
    if (!connection.canAdminister) fail("forbidden", "Personal access keys are created from your own sign-in, not from an agent or another key.");
    const name = args.name.trim();
    if (!name || name.length > 80) fail("validation", "Give the key a name of up to 80 characters.");
    if (!BOARD_ID_PATTERN.test(args.boardId)) fail("not_found", `Online Board not found: ${args.boardId}`);
    const access = await boardAccess(ctx, args.connectionId, args.boardId);
    if (access.role === "viewer" && args.level !== "read") fail("forbidden", "A viewer's key can only read.");
    if (args.level === "complete" && access.role !== "owner") fail("forbidden", "Only the board owner can create a key that completes cards.");
    if (args.expiresAt && !(Date.parse(args.expiresAt) > Date.now())) fail("validation", "The expiry must be in the future.");
    const now = new Date().toISOString();
    const id = await ctx.db.insert("connections", {
      userId: connection.userId, kind: "key", name, clientName: `Key: ${name}`, tokenHash: args.tokenHash,
      boards: [args.boardId], level: args.level, canAdminister: false, createdAt: now, lastUsedAt: now,
      ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}),
    });
    return { id, name, boardId: args.boardId, level: args.level, ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}) };
  },
});

/**
 * An AI app (ChatGPT, Claude, an MCP client) signed in through Clerk: one
 * connection per person and app, created on first use with planning access
 * to the person's boards (no completing or deleting). Revoking it sticks:
 * new tokens from that app are refused until the person re-enables it.
 */
export const forOAuthClient = internalMutation({
  args: { userId: v.string(), clientId: v.string(), clientName: v.string() },
  handler: async (ctx, { userId, clientId, clientName }) => {
    const rows = await ctx.db.query("connections").withIndex("by_user_client", (q) => q.eq("userId", userId).eq("oauthClientId", clientId)).collect();
    const latest = rows.sort((a, b) => b._creationTime - a._creationTime)[0];
    if (latest?.revokedAt) return null;
    const now = new Date().toISOString();
    if (latest) {
      if (Date.now() - Date.parse(latest.lastUsedAt) >= TOUCH_INTERVAL_MS) await ctx.db.patch(latest._id, { lastUsedAt: now });
      return { connectionId: latest._id };
    }
    const id = await ctx.db.insert("connections", {
      userId, kind: "oauth", name: clientName, clientName, oauthClientId: clientId,
      boards: "all", level: "plan", canAdminister: false, createdAt: now, lastUsedAt: now,
    });
    return { connectionId: id };
  },
});

/**
 * A machine's own sign-in, from the command line's browser sign-in: the
 * person's full access. The sign-in token it was exchanged for is used up in
 * the same step, so it can never make a second one.
 */
export const createMachine = internalMutation({
  args: { userId: v.string(), tokenHash: v.string(), name: v.string(), exchangeHash: v.string(), exchangeExpiresAt: v.string() },
  handler: async (ctx, { userId, tokenHash, name, exchangeHash, exchangeExpiresAt }) => {
    const used = await ctx.db.query("machineExchanges").withIndex("by_tokenHash", (q) => q.eq("tokenHash", exchangeHash)).first();
    if (used) fail("unauthorized", "Sign in again: this sign-in has already been used.");
    await ctx.db.insert("machineExchanges", { tokenHash: exchangeHash, expiresAt: exchangeExpiresAt });
    const now = new Date().toISOString();
    const label = name.trim().slice(0, 80) || "Planban command line";
    const id = await ctx.db.insert("connections", {
      userId, kind: "machine", name: label, clientName: label, tokenHash,
      boards: "all", level: "complete", canAdminister: true, createdAt: now, lastUsedAt: now,
    });
    return { connectionId: id };
  },
});

/** From the person's own sign-in: change which boards an app or key reaches and what it may do. */
export const setAccess = internalMutation({
  args: { connectionId: v.id("connections"), targetId: v.string(), level: v.optional(agentLevel), boards: v.optional(v.union(v.literal("all"), v.array(v.string()))) },
  handler: async (ctx, { connectionId, targetId, level, boards }) => {
    const connection = await liveConnection(ctx, connectionId);
    if (!connection.canAdminister) fail("forbidden", "Change access from your own sign-in.");
    const id = ctx.db.normalizeId("connections", targetId);
    const target = id ? await ctx.db.get(id) : null;
    if (!target || target.userId !== connection.userId) fail("not_found", "Connection not found.");
    if (target!.canAdminister) fail("validation", "A machine's own sign-in always has full access; sign it out instead.");
    if (target!.kind === "key" && boards !== undefined) fail("validation", "A key always reaches the one board it was made for.");
    if (boards !== undefined && boards !== "all" && boards.some((board) => !BOARD_ID_PATTERN.test(board))) fail("validation", "Unknown board id.");
    await ctx.db.patch(target!._id, { ...(level ? { level } : {}), ...(boards !== undefined ? { boards } : {}) });
    return describe((await ctx.db.get(target!._id))!, connectionId);
  },
});

/** From the person's own sign-in: let a revoked AI app connect again. */
export const restore = internalMutation({
  args: { connectionId: v.id("connections"), targetId: v.string() },
  handler: async (ctx, { connectionId, targetId }) => {
    const connection = await liveConnection(ctx, connectionId);
    if (!connection.canAdminister) fail("forbidden", "Re-enable apps from your own sign-in.");
    const id = ctx.db.normalizeId("connections", targetId);
    const target = id ? await ctx.db.get(id) : null;
    if (!target || target.userId !== connection.userId || target.kind !== "oauth") fail("not_found", "Connection not found.");
    await ctx.db.patch(target!._id, { revokedAt: undefined, lastUsedAt: new Date().toISOString() });
    return describe((await ctx.db.get(target!._id))!, connectionId);
  },
});
