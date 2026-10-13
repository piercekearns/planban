import assert from "node:assert/strict";
import { test } from "node:test";
import * as invites from "../online/service/convex/invites";
import { createKey, list, MAX_ACTIVE_KEYS, revokeAllOthers } from "../online/service/convex/connections";
import { resolvedConnection } from "../online/service/convex/model/access";
import { DAILY_INVITE_EMAILS, DAILY_INVITES, DAILY_KEYS, SERVICE_DAILY_INVITE_EMAILS } from "../online/service/convex/model/limits";
import { handleMcp, MAX_BATCH } from "../online/service/convex/model/mcp";

const handler = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

function store() {
  const rows: any[] = [];
  let sequence = 0;
  const db: any = {
    get: async (id: string) => rows.find((row) => row._id === id) ?? null,
    insert: async (table: string, value: any) => { const id = `${table}-${++sequence}`; rows.push({ ...value, _id: id, _table: table, _n: sequence }); return id; },
    patch: async (id: string, patch: any) => Object.assign(rows.find((row) => row._id === id), patch),
    delete: async (id: string) => { rows.splice(rows.findIndex((row) => row._id === id), 1); },
    normalizeId: (table: string, id: string) => rows.some((row) => row._id === id && row._table === table) ? id : null,
    query: (table: string) => {
      let match = (row: any) => row._table === table;
      let descending = false;
      const ordered = () => rows.filter(match).sort((a, b) => descending ? b._n - a._n : a._n - b._n);
      const query: any = {
        withIndex: (_name: string, range?: (q: any) => any) => {
          const q: any = { eq: (field: string, value: unknown) => { const prior = match; match = (row) => prior(row) && row[field] === value; return q; } };
          range?.(q);
          return query;
        },
        order: (direction: string) => { descending = direction === "desc"; return query; },
        unique: async () => ordered()[0] ?? null,
        first: async () => ordered()[0] ?? null,
        collect: async () => ordered(),
        take: async (count: number) => ordered().slice(0, count),
      };
      return query;
    },
  };
  return { rows, ctx: { db } };
}

async function ownerWithBoard(ctx: any, userId = "owner", boardId = "shared") {
  const now = new Date().toISOString();
  const connection = await ctx.db.insert("connections", { userId, kind: "machine", name: "Mac", clientName: "Mac", boards: "all", level: "complete", canAdminister: true, createdAt: now, lastUsedAt: now });
  await ctx.db.insert("boards", { boardId, title: "Shared", authority: "online", ownerId: userId, generation: 1, revision: 1, historyVersion: 1 });
  await ctx.db.insert("members", { boardId, userId, role: "owner" });
  return connection;
}

const invite = (ctx: any, connectionId: string, n: number, email?: string, boardId = "shared") =>
  handler(invites.create, ctx, { connectionId, boardId, tokenHash: `t${n}`.padEnd(64, "0"), role: "viewer", ...(email ? { email } : {}) });

test("invitation emails are limited per account, per address, per board and across the service", async () => {
  const { ctx, rows } = store();
  const owner = await ownerWithBoard(ctx);
  await invite(ctx, owner, 1, "friend@example.com");
  await assert.rejects(invite(ctx, owner, 2, "Friend@Example.com"), /already has an invitation waiting/);
  await assert.rejects(invite(ctx, owner, 3, `${"a".repeat(250)}@example.com`), /does not look like an email/);
  for (let n = 4; n < 4 + DAILY_INVITE_EMAILS - 1; n += 1) await invite(ctx, owner, n, `person${n}@example.com`);
  await assert.rejects(invite(ctx, owner, 100, "one-more@example.com"), /limit of 10 invitation emails/);

  // One address gets at most three invitations a day, across boards and owners.
  const other = store();
  const owners = [];
  for (let n = 0; n < 4; n += 1) owners.push(await ownerWithBoard(other.ctx, `owner${n}`, `board${n}`));
  for (let n = 0; n < 3; n += 1) await invite(other.ctx, owners[n], n, "popular@example.com", `board${n}`);
  await assert.rejects(invite(other.ctx, owners[3], 9, "popular@example.com", "board3"), /as many Planban invitations as it can receive today/);

  // The service-wide email budget refuses once spent.
  const day = new Date().toISOString().slice(0, 10);
  const service = rows.find((row) => row._table === "usage" && row.userId === "*service*" && row.day === day);
  service.inviteEmails = SERVICE_DAILY_INVITE_EMAILS;
  const second = await ownerWithBoard(ctx, "second", "second-board");
  await assert.rejects(invite(ctx, second, 200, "fresh@example.com", "second-board"), /as many invitation emails as it can today/);
});

test("invitation links are limited per day, pending invitations per board, and joins per link", async () => {
  const { ctx, rows } = store();
  const owner = await ownerWithBoard(ctx);
  for (let n = 0; n < DAILY_INVITES; n += 1) await invite(ctx, owner, n);
  await assert.rejects(invite(ctx, owner, 99), /limit of 30 invitations/);

  const fresh = store();
  const freshOwner = await ownerWithBoard(fresh.ctx);
  for (let n = 0; n < invites.MAX_PENDING_INVITES; n += 1) fresh.rows.push({ _table: "invites", _id: `pre-${n}`, _n: -n, boardId: "shared", tokenHash: `p${n}`, role: "viewer", createdBy: "owner", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), joinedBy: [] });
  await assert.rejects(invite(fresh.ctx, freshOwner, 1), /50 invitations waiting/);

  const link = rows.find((row) => row._table === "invites");
  link.joinedBy = Array.from({ length: invites.MAX_LINK_JOINS }, (_, n) => `joined-${n}`);
  const now = new Date().toISOString();
  const joiner = await ctx.db.insert("connections", { userId: "newcomer", kind: "machine", name: "Mac", clientName: "Mac", boards: "all", level: "complete", canAdminister: true, createdAt: now, lastUsedAt: now });
  await assert.rejects(handler(invites.accept, ctx, { connectionId: joiner, tokenHash: link.tokenHash }), /used 100 times/);
});

test("personal keys are limited per day and in total", async () => {
  const { ctx, rows } = store();
  const owner = await ownerWithBoard(ctx);
  const key = (n: number) => handler(createKey, ctx, { connectionId: owner, tokenHash: `k${n}`, name: `Key ${n}`, boardId: "shared", level: "read" });
  for (let n = 0; n < DAILY_KEYS; n += 1) await key(n);
  await assert.rejects(key(99), /limit of 20 new personal access keys/);
  const day = new Date().toISOString().slice(0, 10);
  rows.find((row) => row._table === "usage" && row.userId === "owner" && row.day === day).keys = 0;
  const now = new Date().toISOString();
  for (let n = DAILY_KEYS; n < MAX_ACTIVE_KEYS; n += 1) rows.push({ _table: "connections", _id: `key-${n}`, _n: 1000 + n, userId: "owner", kind: "key", name: `Key ${n}`, clientName: "Key", boards: ["shared"], level: "read", canAdminister: false, createdAt: now, lastUsedAt: now });
  await assert.rejects(key(100), /50 active personal access keys/);
});

test("MCP refuses a batch above the limit before running any of it", async () => {
  let calls = 0;
  const service: any = new Proxy({}, { get: () => () => { calls += 1; return {}; } });
  const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });
  const big = await handleMcp(new Request("https://app.example/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Array.from({ length: MAX_BATCH + 1 }, (_, n) => call(n))) }), service, "https://app.example");
  assert.equal(big.status, 400);
  assert.equal(calls, 0);
  const empty = await handleMcp(new Request("https://app.example/mcp", { method: "POST", body: "[]" }), service, "https://app.example");
  assert.equal(empty.status, 400);
  const small = await handleMcp(new Request("https://app.example/mcp", { method: "POST", body: JSON.stringify([call(1), call(2)]) }), service, "https://app.example");
  assert.equal(small.status, 200);
  assert.equal((await small.json()).length, 2);
});

test("old active keys behind lots of revoked history stay listed, count toward the cap, and get cut off", async () => {
  const { ctx, rows } = store();
  const owner = await ownerWithBoard(ctx);
  const now = new Date().toISOString();
  const keyRow = (id: string, n: number, revoked: boolean) => ({ _table: "connections", _id: id, _n: n, userId: "owner", kind: "key", name: id, clientName: "Key", boards: ["shared"], level: "read", canAdminister: false, createdAt: now, lastUsedAt: now, ...(revoked ? { revokedAt: now } : {}) });
  for (let n = 0; n < MAX_ACTIVE_KEYS; n += 1) rows.push(keyRow(`old-${n}`, 10_000 + n, false));
  for (let n = 0; n < 1000; n += 1) rows.push(keyRow(`revoked-${n}`, 20_000 + n, true));
  rows.push({ _table: "oauthRegistrations", _id: "reg-1", _n: 30_000, clientId: `pbc_${"r".repeat(43)}`, redirectUris: [], createdAt: Date.now(), userId: "owner" });

  const listed = await handler(list, ctx, { connectionId: owner });
  const activeKeys = listed.connections.filter((entry: any) => entry.kind === "key" && entry.active);
  assert.equal(activeKeys.length, MAX_ACTIVE_KEYS, "every active key is listed despite newer revoked history");
  await assert.rejects(handler(createKey, ctx, { connectionId: owner, tokenHash: "k-new", name: "One too many", boardId: "shared", level: "read" }), /50 active personal access keys/);

  let result: any;
  do result = await handler(revokeAllOthers, ctx, { connectionId: owner }); while (result.more);
  assert.equal(await resolvedConnection(ctx as any, "old-0" as any), null, "the oldest key is cut off too");
  assert.ok(rows.filter((row) => row._table === "connections" && row._id.startsWith("old-")).every((row) => row.revokedAt));
  assert.ok(await resolvedConnection(ctx as any, owner as any), "the connection making the request stays signed in");
  assert.equal(rows.some((row) => row._table === "oauthRegistrations"), false, "Claude registrations are removed too");
});

test("cutting off everything works in batches until nothing is left", async () => {
  const { ctx, rows } = store();
  const owner = await ownerWithBoard(ctx);
  const now = new Date().toISOString();
  for (let n = 0; n < 450; n += 1) rows.push({ _table: "connections", _id: `m-${n}`, _n: 40_000 + n, userId: "owner", kind: "machine", name: "Mac", clientName: "Mac", boards: "all", level: "complete", canAdminister: true, createdAt: now, lastUsedAt: now });
  const first = await handler(revokeAllOthers, ctx, { connectionId: owner });
  assert.deepEqual([first.revoked, first.more], [200, true]);
  let rounds = 1;
  let result = first;
  while (result.more) { result = await handler(revokeAllOthers, ctx, { connectionId: owner }); rounds += 1; }
  assert.equal(rounds, 3);
  assert.ok(rows.filter((row) => row._id.startsWith("m-")).every((row) => row.revokedAt));
  const agentKey = rows.find((row) => row._id === "m-0");
  delete agentKey.revokedAt; agentKey.canAdminister = false;
  await assert.rejects(handler(revokeAllOthers, ctx, { connectionId: "m-0" }), /your own sign-in/);
});
