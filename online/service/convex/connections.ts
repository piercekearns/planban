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
