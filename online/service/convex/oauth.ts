// Internal enrollment state machine. The HTTP boundary validates client
// metadata and verifies human session identity; these mutations atomically
// bind approval, code redemption and rotating credentials to one connection.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { connectionIsUsable, liveConnection } from "./model/access";
import { fail } from "./model/errors";
import { agentLevel } from "./schema";
import { metadataClientAllowed } from "./model/oauthClient";

export const REQUEST_MS = 10 * 60_000;
export const CODE_MS = 60_000;
export const ACCESS_MS = 5 * 60_000;
export const REFRESH_IDLE_MS = 90 * 24 * 60 * 60_000;
export const GRANT_MS = 365 * 24 * 60 * 60_000;
const invalid = () => ({ error: "invalid_grant" as const });
const hash = v.string();
const SCOPES = new Set(["planban:read", "planban:plan", "planban:complete", "offline_access"]);
export const MACHINE_CLIENT_ID = "planban-cli";
export function scopeLevel(scopes: string[]) {
  return scopes.includes("planban:complete") ? "complete" as const : scopes.includes("planban:plan") ? "plan" as const : "read" as const;
}

async function requestRow(ctx: MutationCtx, requestHash: string) {
  return ctx.db.query("oauthRequests").withIndex("by_requestHash", (q) => q.eq("requestHash", requestHash)).unique();
}

async function cleanupState(ctx: MutationCtx) {
  return ctx.db.query("oauthCleanup").withIndex("by_name", (q) => q.eq("name", "requests")).unique();
}

async function scheduleCleanup(ctx: MutationCtx, delay: number) {
  const state = await cleanupState(ctx);
  if (state?.dueAt !== undefined) return;
  const ticket = (state?.ticket ?? 0) + 1;
  const fields = { name: "requests", ticket, dueAt: Date.now() + delay };
  if (state) await ctx.db.patch(state._id, fields);
  else await ctx.db.insert("oauthCleanup", fields);
  await ctx.scheduler.runAfter(delay, internal.oauth.cleanupRequests, { ticket });
}

/** Reserve outbound work atomically, even if metadata fails or no row is created. */
export const reserveMetadataFetch = internalMutation({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    if (!metadataClientAllowed(clientId)) return false;
    const bucket = Math.floor(Date.now() / REQUEST_MS);
    const usage = await ctx.db.query("oauthUsage").withIndex("by_client_bucket", (q) => q.eq("clientId", clientId).eq("bucket", bucket)).unique();
    if ((usage?.requests ?? 0) >= 100 || (usage?.fetches ?? 0) >= 100) return false;
    if (usage) await ctx.db.patch(usage._id, { fetches: (usage.fetches ?? 0) + 1 });
    else await ctx.db.insert("oauthUsage", { clientId, bucket, requests: 0, fetches: 1 });
    await scheduleCleanup(ctx, REQUEST_MS + CODE_MS);
    return true;
  },
});

export const createRequest = internalMutation({
  args: { requestHash: hash, browserHash: hash, csrfHash: hash, clientId: v.string(), clientName: v.string(), redirectUri: v.string(), resource: v.string(), scopes: v.array(v.string()), level: agentLevel, challenge: v.string(), state: v.string(), purpose: v.union(v.literal("oauth"), v.literal("machine")) },
  handler: async (ctx, args) => {
    if ([args.requestHash, args.browserHash, args.csrfHash].some((value) => !/^[a-f0-9]{64}$/.test(value)) || !/^[A-Za-z0-9_-]{43}$/.test(args.challenge)) fail("validation", "Invalid authorization request.");
    if (args.clientId.length > 2048 || args.redirectUri.length > 2048 || args.resource.length > 2048 || args.state.length > 2048 || args.clientName.length > 200 || args.scopes.length > 4) fail("validation", "Authorization request is too large.");
    if (args.purpose === "machine") {
      if (args.clientId !== MACHINE_CLIENT_ID || args.scopes.length !== 1 || args.scopes[0] !== "planban:machine" || args.level !== "complete") fail("validation", "Invalid machine authorization.");
    } else if (!args.scopes.some((scope) => scope.startsWith("planban:")) || args.scopes.some((scope) => !SCOPES.has(scope)) || args.level !== scopeLevel(args.scopes)) fail("validation", "Invalid authorization scopes.");
    const bucket = Math.floor(Date.now() / REQUEST_MS);
    const usage = await ctx.db.query("oauthUsage").withIndex("by_client_bucket", (q) => q.eq("clientId", args.clientId).eq("bucket", bucket)).unique();
    if ((usage?.requests ?? 0) >= 100) fail("rate_limited", "Too many authorization requests. Try again later.");
    if (usage) await ctx.db.patch(usage._id, { requests: usage.requests + 1 });
    else await ctx.db.insert("oauthUsage", { clientId: args.clientId, bucket, requests: 1 });
    await ctx.db.insert("oauthRequests", { ...args, status: "pending", expiresAt: Date.now() + REQUEST_MS });
    await scheduleCleanup(ctx, REQUEST_MS + CODE_MS);
    return { created: true };
  },
});

/** Only the browser holding the interaction nonce can inspect or bind consent. */
export const inspect = internalQuery({
  args: { requestHash: hash, browserHash: hash },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("oauthRequests").withIndex("by_requestHash", (q) => q.eq("requestHash", args.requestHash)).unique();
    if (!row || row.browserHash !== args.browserHash || row.expiresAt <= Date.now() || row.status !== "pending") return null;
    return { clientId: row.clientId, clientName: row.clientName, redirectUri: row.redirectUri, resource: row.resource, scopes: row.scopes, purpose: row.purpose, userId: row.userId };
  },
});

export const bindIdentity = internalMutation({
  args: { requestHash: hash, browserHash: hash, csrfHash: hash, userId: v.string(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await requestRow(ctx, args.requestHash);
    if (!row || row.status !== "pending" || row.expiresAt <= Date.now() || row.browserHash !== args.browserHash || row.csrfHash !== args.csrfHash || (row.userId && row.userId !== args.userId)) fail("unauthorized", "Start a fresh authorization request.");
    if (row!.sessionId && row!.sessionId !== args.sessionId) fail("unauthorized", "The signed-in session changed. Start again.");
    await ctx.db.patch(row!._id, { userId: args.userId, ...(args.sessionId ? { sessionId: args.sessionId } : {}) });
    return { bound: true };
  },
});

/** Cancellation cannot create a grant and does not require a signed-in user. */
export const denyRequest = internalMutation({
  args: { requestHash: hash, browserHash: hash, csrfHash: hash },
  handler: async (ctx, args) => {
    const row = await requestRow(ctx, args.requestHash);
    if (!row || row.status !== "pending" || row.expiresAt <= Date.now() || row.browserHash !== args.browserHash || row.csrfHash !== args.csrfHash) fail("unauthorized", "Start a fresh authorization request.");
    await ctx.db.patch(row!._id, { status: "denied" });
    return { redirectUri: row!.redirectUri, state: row!.state };
  },
});

export const approve = internalMutation({
  args: { requestHash: hash, browserHash: hash, csrfHash: hash, userId: v.string(), sessionId: v.optional(v.string()), approverConnectionId: v.optional(v.id("connections")), codeHash: hash, deny: v.boolean() },
  handler: async (ctx, args) => {
    const row = await requestRow(ctx, args.requestHash);
    if (!row || row.status !== "pending" || row.expiresAt <= Date.now() || row.browserHash !== args.browserHash || row.csrfHash !== args.csrfHash || row.userId !== args.userId) fail("unauthorized", "Start a fresh authorization request.");
    if (row!.sessionId && row!.sessionId !== args.sessionId) fail("unauthorized", "The signed-in session changed. Start again.");
    if (args.approverConnectionId) {
      const approver = await liveConnection(ctx, args.approverConnectionId);
      if (!approver.canAdminister || approver.userId !== args.userId) fail("forbidden", "Approve from your own sign-in.");
    } else if (!args.sessionId || row!.sessionId !== args.sessionId) fail("unauthorized", "Approve from your current signed-in session.");
    if (args.deny) {
      await ctx.db.patch(row!._id, { status: "denied" });
      return { denied: true, redirectUri: row!.redirectUri, state: row!.state };
    }
    if (!/^[a-f0-9]{64}$/.test(args.codeHash)) fail("validation", "Invalid authorization code.");
    const now = new Date().toISOString();
    // Pending grants are visible and revocable before code redemption; they
    // have no credential and cannot authorize resource work.
    const connectionId = await ctx.db.insert("connections", {
      userId: args.userId, kind: row!.purpose, name: row!.clientName, clientName: row!.clientName,
      boards: "all", level: row!.purpose === "machine" ? "complete" : row!.level,
      canAdminister: row!.purpose === "machine", createdAt: now, lastUsedAt: now,
      oauthClientId: row!.clientId, oauthResource: row!.resource, authorizationVersion: 2, oauthPending: true,
      ...(row!.purpose === "oauth" ? { expiresAt: new Date(Date.now() + GRANT_MS).toISOString() } : {}),
    });
    const codeExpiresAt = Date.now() + CODE_MS;
    await ctx.db.patch(row!._id, { status: "approved", connectionId, codeHash: args.codeHash, codeExpiresAt, expiresAt: codeExpiresAt, ...(args.approverConnectionId ? { approverConnectionId: args.approverConnectionId } : {}) });
    return { denied: false, redirectUri: row!.redirectUri, state: row!.state };
  },
});

async function issueOAuth(ctx: MutationCtx, connection: Doc<"connections">, accessHash: string, refreshHash: string, scopes: string[]) {
  const expiresAt = new Date(Date.now() + ACCESS_MS).toISOString();
  const accessId = await ctx.db.insert("connections", {
    userId: connection.userId, kind: "oauth", name: "Access credential", clientName: connection.clientName,
    tokenHash: accessHash, boards: connection.boards, level: scopeLevel(scopes), canAdminister: false,
    createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), expiresAt,
    oauthClientId: connection.oauthClientId, oauthResource: connection.oauthResource,
    authorizationVersion: 2, oauthConnectionId: connection._id,
  });
  await ctx.scheduler.runAfter(ACCESS_MS + CODE_MS, internal.oauth.cleanupCredential, { accessId });
  if (scopes.includes("offline_access")) {
    const refreshId = await ctx.db.insert("oauthRefresh", {
      tokenHash: refreshHash, connectionId: connection._id, clientId: connection.oauthClientId!, resource: connection.oauthResource!, scopes,
      expiresAt: Math.min(Date.now() + REFRESH_IDLE_MS, Date.parse(connection.expiresAt!)),
    });
    await ctx.scheduler.runAfter(Math.max(0, Date.parse(connection.expiresAt!) - Date.now()) + CODE_MS, internal.oauth.cleanupCredential, { refreshId });
  }
  return { machine: false, expiresIn: ACCESS_MS / 1000, scope: scopes.join(" "), refresh: scopes.includes("offline_access") };
}

export const redeem = internalMutation({
  args: { codeHash: hash, clientId: v.string(), redirectUri: v.string(), resource: v.string(), challenge: v.string(), accessHash: hash, refreshHash: hash, sessionId: v.optional(v.string()), sessionUserId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("oauthRequests").withIndex("by_codeHash", (q) => q.eq("codeHash", args.codeHash)).unique();
    if (!row || row.status !== "approved" || !row.connectionId || (row.codeExpiresAt ?? 0) <= Date.now() || row.clientId !== args.clientId || row.redirectUri !== args.redirectUri || row.resource !== args.resource || row.challenge !== args.challenge) return invalid();
    const connection = await ctx.db.get(row.connectionId);
    if (!connection || connection.revokedAt || !connection.oauthPending) return invalid();
    if (row.approverConnectionId && !connectionIsUsable(await ctx.db.get(row.approverConnectionId))) return invalid();
    if (!row.approverConnectionId && (!row.sessionId || args.sessionId !== row.sessionId || args.sessionUserId !== row.userId)) return invalid();
    await ctx.db.patch(row._id, { status: "consumed" });
    await ctx.db.patch(connection._id, { oauthPending: false });
    if (row.purpose === "machine") {
      await ctx.db.patch(connection._id, { tokenHash: args.accessHash });
      await ctx.scheduler.runAfter(0, internal.people.refresh, { userId: connection.userId });
      return { machine: true, userId: connection.userId, scope: "planban:machine", expiresIn: REFRESH_IDLE_MS / 1000, refresh: false };
    }
    return issueOAuth(ctx, connection, args.accessHash, args.refreshHash, row.scopes);
  },
});

/** HTTP token action rechecks the active provider session before redemption. */
export const redemptionContext = internalQuery({
  args: { codeHash: hash },
  handler: async (ctx, { codeHash }) => {
    const row = await ctx.db.query("oauthRequests").withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash)).unique();
    return row?.status === "approved" && (row.codeExpiresAt ?? 0) > Date.now()
      ? { sessionId: row.approverConnectionId ? undefined : row.sessionId, userId: row.userId }
      : null;
  },
});

export const revokeToken = internalMutation({
  args: { tokenHash: hash, clientId: v.string() },
  handler: async (ctx, args) => {
    const access = await ctx.db.query("connections").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash)).unique();
    const refresh = await ctx.db.query("oauthRefresh").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash)).unique();
    const id = access?.oauthConnectionId ?? refresh?.connectionId;
    const connection = id ? await ctx.db.get(id) : null;
    if (connection?.kind === "oauth" && connection.authorizationVersion === 2 && connection.oauthClientId === args.clientId && !connection.revokedAt) await ctx.db.patch(connection._id, { revokedAt: new Date().toISOString() });
    return { revoked: true };
  },
});

/** Expired request/counter cleanup is bounded; permanent grant rows are retained. */
export const cleanupRequests = internalMutation({
  args: { ticket: v.number() },
  handler: async (ctx, { ticket }) => {
    const state = await cleanupState(ctx);
    if (!state || state.dueAt === undefined || state.ticket !== ticket) return;
    await ctx.db.patch(state._id, { dueAt: undefined });
    const requests = await ctx.db.query("oauthRequests").withIndex("by_expiry", (q) => q.lte("expiresAt", Date.now())).take(100);
    const usage = await ctx.db.query("oauthUsage").withIndex("by_bucket", (q) => q.lt("bucket", Math.floor(Date.now() / REQUEST_MS))).take(100);
    for (const row of requests) {
      const grant = row.connectionId ? await ctx.db.get(row.connectionId) : null;
      if (grant?.oauthPending && !grant.revokedAt) await ctx.db.patch(grant._id, { revokedAt: new Date().toISOString() });
      await ctx.db.delete(row._id);
    }
    for (const row of usage) await ctx.db.delete(row._id);
    if (requests.length === 100 || usage.length === 100) {
      await scheduleCleanup(ctx, 0);
    } else {
      // Later requests or late approval can outlive the bucket's first job.
      // Keep a bounded job alive until the last outstanding deadline passes.
      const next = await ctx.db.query("oauthRequests").withIndex("by_expiry").order("asc").first();
      const nextUsage = await ctx.db.query("oauthUsage").withIndex("by_bucket").order("asc").first();
      const deadline = Math.min(next?.expiresAt ?? Infinity, nextUsage ? (nextUsage.bucket + 1) * REQUEST_MS : Infinity);
      if (Number.isFinite(deadline)) await scheduleCleanup(ctx, Math.max(0, deadline - Date.now()) + 1);
    }
  },
});

export const cleanupCredential = internalMutation({
  args: { accessId: v.optional(v.id("connections")), refreshId: v.optional(v.id("oauthRefresh")) },
  handler: async (ctx, args) => {
    if (args.accessId) {
      const access = await ctx.db.get(args.accessId);
      if (access?.oauthConnectionId && Date.parse(access.expiresAt ?? "") <= Date.now()) await ctx.db.delete(access._id);
    }
    if (args.refreshId) {
      const refresh = await ctx.db.get(args.refreshId);
      const grant = refresh ? await ctx.db.get(refresh.connectionId) : null;
      // Spent hashes stay for the entire live family, so even an old replay
      // can close it. Removing them never makes credentials acceptable.
      if (refresh && (!grant || grant.revokedAt || Date.parse(grant.expiresAt ?? "") <= Date.now())) await ctx.db.delete(refresh._id);
    }
  },
});

export const refresh = internalMutation({
  args: { tokenHash: hash, clientId: v.string(), resource: v.string(), accessHash: hash, refreshHash: hash, requestedScopes: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("oauthRefresh").withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash)).unique();
    if (!row || row.clientId !== args.clientId || row.resource !== args.resource) return invalid();
    const connection = await ctx.db.get(row.connectionId);
    if (row.usedAt !== undefined) {
      // Return an error rather than throwing: the replay-triggered family
      // revocation must commit even though no replacement token is issued.
      if (connection && !connection.revokedAt) await ctx.db.patch(connection._id, { revokedAt: new Date().toISOString() });
      return invalid();
    }
    if (row.expiresAt <= Date.now() || !connectionIsUsable(connection) || connection.authorizationVersion !== 2 || connection.kind !== "oauth" || connection.oauthConnectionId) return invalid();
    if (args.requestedScopes) {
      const approved = new Set(row.scopes), requested = new Set(args.requestedScopes);
      if (requested.size !== args.requestedScopes.length || requested.size !== approved.size || args.requestedScopes.some((scope) => !approved.has(scope))) return { error: "invalid_scope" as const };
    }
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    await ctx.db.patch(connection._id, { lastUsedAt: new Date().toISOString() });
    return issueOAuth(ctx, connection, args.accessHash, args.refreshHash, row.scopes);
  },
});
