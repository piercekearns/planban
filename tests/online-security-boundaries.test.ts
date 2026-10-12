import assert from "node:assert/strict";
import { test } from "node:test";
import { handleApi } from "../online/service/convex/http";
import { attributionFor } from "../online/service/convex/boards";
import { restore, forOAuthClient } from "../online/service/convex/connections";
import { checkImportedExtras } from "../online/service/convex/model/indexRules";
import { reserveRetiredId } from "../online/service/convex/model/retired";
import { sizeOf } from "../online/service/convex/model/limits";

test("invalid supplied member and invite roles fail before mutation or mail", async () => {
  let calls = 0;
  const ctx: any = { runMutation: async () => { calls++; return { id: "invite" }; } };
  const auth: any = { connectionId: "owner" };
  for (const suffix of ["invites", "members", "members/person/role"]) {
    for (const role of [null, "owner", "EDITOR", "invalid", 1, [], {}]) {
      const response = await handleApi(ctx, new Request(`http://127.0.0.1/api/v1/boards/board/${suffix}`, {
        method: "POST", body: JSON.stringify({ role, userId: "person" }),
      }), auth);
      assert.equal(response.status, 400, `${suffix} ${JSON.stringify(role)}`);
    }
  }
  const missing = await handleApi(ctx, new Request("http://127.0.0.1/api/v1/boards/board/members/person/role", { method: "POST", body: "{}" }), auth);
  assert.equal(missing.status, 400);
  assert.equal(calls, 0);
  const accepted: any[] = [];
  ctx.runMutation = async (_fn: unknown, args: any) => { accepted.push(args); return { id: "invite" }; };
  for (const [suffix, role] of [["invites", "viewer"], ["members", "editor"]]) {
    const response = await handleApi(ctx, new Request(`http://127.0.0.1/api/v1/boards/board/${suffix}`, { method: "POST", body: "{}" }), auth);
    assert.ok(response.ok);
    assert.equal(accepted.at(-1).role, role, "omitted defaults remain compatible");
  }
});

test("email transport omits private planning title and stays dormant without mail configuration", async () => {
  const previousKey = process.env.RESEND_API_KEY, previousFrom = process.env.PLANBAN_INVITE_FROM;
  const originalFetch = globalThis.fetch;
  const payloads: any[] = [];
  const privateTitle = "PRIVATE BOARD TITLE MUST STAY IN PLANBAN";
  const ctx: any = { runMutation: async () => ({ id: "invite", email: "fixture@example.invalid", boardTitle: privateTitle }) };
  const request = () => new Request("http://127.0.0.1/api/v1/boards/board/invites", { method: "POST", body: JSON.stringify({ email: "fixture@example.invalid", role: "viewer" }) });
  try {
    globalThis.fetch = async (_url, init) => { payloads.push(JSON.parse(String(init?.body))); return new Response("{}", { status: 200 }); };
    delete process.env.RESEND_API_KEY; delete process.env.PLANBAN_INVITE_FROM;
    assert.equal((await (await handleApi(ctx, request(), { connectionId: "owner" } as any)).json()).emailSent, false);
    assert.equal(payloads.length, 0);
    process.env.RESEND_API_KEY = "synthetic-test-value";
    process.env.PLANBAN_INVITE_FROM = "Planban <fixture@example.invalid>";
    assert.equal((await (await handleApi(ctx, request(), { connectionId: "owner" } as any)).json()).emailSent, true);
    assert.equal(payloads.length, 1);
    assert.ok(!JSON.stringify(payloads).includes(privateTitle));
    assert.match(payloads[0].text, /a viewer/);
    assert.match(payloads[0].text, /7 days/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previousKey;
    if (previousFrom === undefined) delete process.env.PLANBAN_INVITE_FROM; else process.env.PLANBAN_INVITE_FROM = previousFrom;
  }
});

test("authenticated agent authority cannot claim human attribution", () => {
  for (const kind of ["oauth", "key", "dev"] as const) {
    const connection: any = { _id: kind, userId: "person", clientName: "App", kind, canAdminister: false };
    for (const requested of ["user", "agent", undefined, "invalid"]) assert.equal(attributionFor(connection, requested).actor, "agent");
  }
  const machine: any = { _id: "machine", userId: "person", clientName: "Mac", kind: "machine", canAdminister: true };
  assert.equal(attributionFor(machine, "user").actor, "user");
  assert.equal(attributionFor(machine, "agent").actor, "agent", "agents using a person's machine stay agents");
  assert.equal(attributionFor(machine, "user").connectionId, "machine");
});

test("restore never changes a revoked OAuth tombstone even for the legitimate administrator", async () => {
  const admin = { _id: "machine", userId: "person", canAdminister: true, kind: "machine", lastUsedAt: new Date().toISOString() };
  const target = { _id: "app", userId: "person", kind: "oauth", revokedAt: "2026-10-12T00:00:00.000Z" };
  let patched = false;
  const ctx: any = { db: {
    get: async (id: string) => id === "machine" ? admin : target,
    normalizeId: (_table: string, id: string) => id,
    patch: async () => { patched = true; },
    query: () => ({ withIndex() { return this; }, collect: async () => [target] }),
  } };
  await assert.rejects((restore as any)._handler(ctx, { connectionId: "machine", targetId: "app" }), /cannot be restored/);
  assert.equal(patched, false);
  assert.equal(await (forOAuthClient as any)._handler(ctx, { userId: "person", clientId: "client", clientName: "App" }), null);
  assert.ok(target.revokedAt);
});

test("retired identity inserts are metered once per generation and refused before storage exceeds its cap", async () => {
  const rows: any[] = [];
  const ctx: any = { db: {
    query(table: string) {
      const filters: Array<[string, unknown]> = [];
      const q: any = { withIndex(_index: string, build: any) { const index: any = { eq(key: string, value: unknown) { filters.push([key, value]); return index; } }; build(index); return q; },
        unique: async () => rows.find((row) => row.table === table && filters.every(([key, value]) => row[key] === value)) ?? null };
      return q;
    },
    insert: async (table: string, value: any) => { const _id = String(rows.length); rows.push({ _id, table, ...value }); return _id; },
    patch: async (id: string, value: any) => Object.assign(rows.find((row) => row._id === id), value),
  } };
  const at = { boardId: "board", generation: 1 };
  await reserveRetiredId(ctx, at, "retired-card");
  await reserveRetiredId(ctx, at, "retired-card");
  assert.equal(rows.filter((row) => row.table === "retiredIds").length, 1);
  assert.equal(rows.find((row) => row.table === "boardSizes").bytes, sizeOf("retired-card"));
  await reserveRetiredId(ctx, { ...at, generation: 2 }, "retired-card");
  assert.equal(rows.filter((row) => row.table === "retiredIds").length, 2);
  const previousLimits = process.env.PLANBAN_TEST_LIMITS;
  try {
    process.env.PLANBAN_TEST_LIMITS = "1,0,0,0";
    await assert.rejects(reserveRetiredId(ctx, at, "another-card"), /more than/);
    assert.equal(rows.filter((row) => row.table === "retiredIds").length, 2);
  } finally {
    if (previousLimits === undefined) delete process.env.PLANBAN_TEST_LIMITS; else process.env.PLANBAN_TEST_LIMITS = previousLimits;
  }
  assert.throws(() => checkImportedExtras({ retiredIds: Array.from({ length: 12000 }, (_, i) => `card-${i}`) }), /limit|KB/);
});
