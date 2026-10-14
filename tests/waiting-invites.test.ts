import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as invites from "../online/service/convex/invites";
import { WaitingInvites, type WaitingInvite } from "../src/web/onlineBoard";

const handler = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

function store() {
  const rows: any[] = [];
  let sequence = 0;
  const db: any = {
    get: async (id: string) => rows.find((row) => row._id === id) ?? null,
    insert: async (table: string, value: any) => { const id = `${table}-${++sequence}`; rows.push({ ...value, _id: id, _table: table, _n: sequence }); return id; },
    patch: async (id: string, patch: any) => Object.assign(rows.find((row) => row._id === id), patch),
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

test("the owner sees a waiting invitation, cancels it, and can invite the same address again", async () => {
  const { ctx } = store();
  const now = new Date().toISOString();
  const owner = await ctx.db.insert("connections", { userId: "owner", kind: "machine", name: "Mac", clientName: "Mac", boards: "all", level: "complete", canAdminister: true, createdAt: now, lastUsedAt: now });
  await ctx.db.insert("boards", { boardId: "shared", title: "Shared", authority: "online", ownerId: "owner", generation: 1, revision: 1, historyVersion: 1 });
  await ctx.db.insert("members", { boardId: "shared", userId: "owner", role: "owner" });
  const invite = (n: number) => handler(invites.create, ctx, { connectionId: owner, boardId: "shared", tokenHash: `t${n}`.padEnd(64, "0"), role: "viewer", email: "friend@example.com" });

  await invite(1);
  await assert.rejects(invite(2), /already has an invitation waiting/);
  const waiting: WaitingInvite[] = (await handler(invites.list, ctx, { connectionId: owner, boardId: "shared" })).invites;
  assert.deepEqual(waiting.map((entry) => [entry.email, entry.role]), [["friend@example.com", "viewer"]]);

  // What the People panel shows for that list: the address, its role and a Cancel button.
  const cancelled: string[] = [];
  const html = renderToStaticMarkup(createElement(WaitingInvites, { invites: waiting, busy: false, onCancel: (entry: WaitingInvite) => cancelled.push(entry.id) }));
  assert.match(html, /Waiting invitations/);
  assert.match(html, /friend@example\.com/);
  assert.match(html, /Viewer/);
  assert.match(html, /aria-label="Cancel the invitation for friend@example\.com"[^>]*>Cancel</);

  await handler(invites.revoke, ctx, { connectionId: owner, boardId: "shared", inviteId: waiting[0]!.id });
  assert.deepEqual((await handler(invites.list, ctx, { connectionId: owner, boardId: "shared" })).invites, []);
  assert.ok(await invite(3), "the same address can be invited again once the first is cancelled");
});

test("a link invitation shows who has joined, and nothing shows when none are waiting", () => {
  const link: WaitingInvite = { id: "i1", role: "editor", email: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), joined: 2 };
  const html = renderToStaticMarkup(createElement(WaitingInvites, { invites: [link], busy: true, onCancel: () => {} }));
  assert.match(html, /Invite link/);
  assert.match(html, /2 joined/);
  assert.match(html, /Editor/);
  assert.match(html, /disabled=""/, "Cancel is unavailable while another change is in progress");
  assert.equal(renderToStaticMarkup(createElement(WaitingInvites, { invites: [], busy: false, onCancel: () => {} })), "");
});
