import assert from "node:assert/strict";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { CLAUDE_REDIRECTS, parseClaudeRegistration, REGISTERED_CLIENT_NAME } from "../online/service/convex/model/oauthClient";
import { authorizationResponse, registrationResponse } from "../online/service/convex/model/oauthConsent";
import { approve, register, registeredClient, REGISTRATION_MS } from "../online/service/convex/oauth";
import { revoke } from "../online/service/convex/connections";

const handler = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const origin = "https://planban.example";
const CLIENT = `pbc_${"c".repeat(43)}`;
const claudeBody = { client_name: "Claude", redirect_uris: [CLAUDE_REDIRECTS[0]], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };

async function configured(run: () => Promise<void>) {
  const values = { PLANBAN_PUBLIC_URL: origin, CLERK_ISSUER: "https://fixture.clerk.example", CLERK_PUBLISHABLE_KEY: "pk_test_" + btoa("fixture.clerk.example$"), CLERK_SECRET_KEY: "synthetic-fixture-only" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try { Object.assign(process.env, values); await run(); }
  finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

function store() {
  const rows: any[] = [];
  let sequence = 0;
  const jobs: unknown[] = [];
  const db: any = {
    get: async (id: string) => rows.find((row) => row._id === id) ?? null,
    insert: async (table: string, value: any) => { const id = `${table}-${++sequence}`; rows.push({ ...value, _id: id, _table: table }); return id; },
    patch: async (id: string, patch: any) => {
      const row = rows.find((entry) => entry._id === id);
      for (const [key, value] of Object.entries(patch)) if (value === undefined) delete row[key]; else row[key] = value;
    },
    delete: async (id: string) => { rows.splice(rows.findIndex((row) => row._id === id), 1); },
    normalizeId: (_table: string, id: string) => rows.some((row) => row._id === id) ? id : null,
    query: (table: string) => {
      let match = (row: any) => row._table === table;
      const query: any = {
        withIndex: (_name: string, range?: (q: any) => any) => {
          const q: any = {
            eq: (field: string, value: unknown) => { const prior = match; match = (row) => prior(row) && row[field] === value; return q; },
            gt: (field: string, value: any) => { const prior = match; match = (row) => prior(row) && row[field] !== undefined && row[field] > value; return q; },
            lte: (field: string, value: any) => { const prior = match; match = (row) => prior(row) && row[field] !== undefined && row[field] <= value; return q; },
          };
          range?.(q);
          return query;
        },
        order: () => query,
        unique: async () => rows.find(match) ?? null,
        first: async () => rows.find(match) ?? null,
        collect: async () => rows.filter(match),
        take: async (count: number) => rows.filter(match).slice(0, count),
      };
      return query;
    },
  };
  return { rows, ctx: { db, scheduler: { runAfter: async (...args: unknown[]) => { jobs.push(args); } } } };
}

test("only Claude's own callbacks, as a public authorization-code client, can register", () => {
  assert.deepEqual(parseClaudeRegistration(claudeBody), { redirectUris: [CLAUDE_REDIRECTS[0]] });
  assert.deepEqual(parseClaudeRegistration({ redirect_uris: [...CLAUDE_REDIRECTS] }), { redirectUris: [...CLAUDE_REDIRECTS] });
  const refused: Array<[unknown, string]> = [
    [{ ...claudeBody, redirect_uris: ["https://evil.example/api/mcp/auth_callback"] }, "invalid_redirect_uri"],
    [{ ...claudeBody, redirect_uris: [CLAUDE_REDIRECTS[0], "https://evil.example/cb"] }, "invalid_redirect_uri"],
    [{ ...claudeBody, redirect_uris: ["https://claude.ai/api/mcp/auth_callback?x=1"] }, "invalid_redirect_uri"],
    [{ ...claudeBody, redirect_uris: [] }, "invalid_redirect_uri"],
    [{ ...claudeBody, token_endpoint_auth_method: "client_secret_post" }, "invalid_client_metadata"],
    [{ ...claudeBody, grant_types: ["client_credentials"] }, "invalid_client_metadata"],
    [{ ...claudeBody, grant_types: ["refresh_token"] }, "invalid_client_metadata"],
    [{ ...claudeBody, response_types: ["token"] }, "invalid_client_metadata"],
    [{ ...claudeBody, jwks_uri: "https://evil.example/jwks" }, "invalid_client_metadata"],
    [[claudeBody], "invalid_client_metadata"],
  ];
  for (const [body, error] of refused) assert.deepEqual(parseClaudeRegistration(body), { error }, JSON.stringify(body));
});

test("the registration route issues an opaque public client named Claude, and refuses malformed requests", async () => {
  await configured(async () => {
    const calls: any[] = [];
    const ctx: any = { runMutation: async (fn: any, args: any) => { calls.push([getFunctionName(fn), args]); return { createdAt: Date.parse("2030-01-01T00:00:00Z") }; } };
    const post = (body: string, type = "application/json") => new Request(`${origin}/oauth/register`, { method: "POST", headers: { "Content-Type": type }, body });
    const response = await registrationResponse(ctx, post(JSON.stringify({ ...claudeBody, client_name: "Definitely Not Claude" })));
    assert.equal(response.status, 201);
    const issued = await response.json();
    assert.match(issued.client_id, /^pbc_[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.client_name, REGISTERED_CLIENT_NAME);
    assert.equal(issued.token_endpoint_auth_method, "none");
    assert.deepEqual(issued.redirect_uris, [CLAUDE_REDIRECTS[0]]);
    assert.deepEqual(calls, [["oauth:register", { clientId: issued.client_id, redirectUris: [CLAUDE_REDIRECTS[0]] }]]);

    for (const bad of [post("{"), post(JSON.stringify(claudeBody), "text/plain"), post("x".repeat(5000)), post(JSON.stringify({ ...claudeBody, redirect_uris: ["https://evil.example/cb"] }))]) {
      assert.equal((await registrationResponse(ctx, bad)).status, 400);
    }
    assert.equal(calls.length, 1);
  });
});

test("an unused registration expires; the first approver owns it; others and expired ones are refused", async () => {
  const { ctx, rows } = store();
  await configured(async () => {
    await handler(register, ctx, { clientId: CLIENT, redirectUris: [CLAUDE_REDIRECTS[0]] });
    const client = await handler(registeredClient, ctx, { clientId: CLIENT });
    assert.deepEqual(client, { clientId: CLIENT, name: REGISTERED_CLIENT_NAME, redirectUris: [CLAUDE_REDIRECTS[0]], native: false });
    assert.equal(await handler(registeredClient, ctx, { clientId: `pbc_${"d".repeat(43)}` }), null);
    assert.equal(await handler(registeredClient, ctx, { clientId: "https://claude.ai/api/oauth/mcp-oauth-client-metadata" }), null);

    const pending = (userId: string, n: string) => ({
      requestHash: n.repeat(64), browserHash: "b".repeat(64), csrfHash: "c".repeat(64), clientId: CLIENT, clientName: REGISTERED_CLIENT_NAME,
      redirectUri: CLAUDE_REDIRECTS[0], resource: `${origin}/mcp`, scopes: ["planban:read"], level: "read", challenge: "x".repeat(43), state: "s",
      purpose: "oauth", status: "pending", expiresAt: Date.now() + 60_000, userId, sessionId: "sess",
    });
    await ctx.db.insert("oauthRequests", pending("alice", "1"));
    await ctx.db.insert("oauthRequests", pending("bob", "2"));
    const approveAs = (userId: string, n: string) => handler(approve, ctx, { requestHash: n.repeat(64), browserHash: "b".repeat(64), csrfHash: "c".repeat(64), userId, sessionId: "sess", codeHash: "e".repeat(64), deny: false });
    await approveAs("alice", "1");
    const registration = rows.find((row) => row._table === "oauthRegistrations");
    assert.equal(registration.userId, "alice");
    assert.equal(registration.expiresAt, undefined);
    await assert.rejects(approveAs("bob", "2"), /ended/);

    // Owned registrations don't expire; unowned ones do.
    await handler(register, ctx, { clientId: `pbc_${"f".repeat(43)}`, redirectUris: [CLAUDE_REDIRECTS[1]] });
    const RealNow = Date.now;
    Date.now = () => RealNow() + REGISTRATION_MS + 1;
    try {
      assert.ok(await handler(registeredClient, ctx, { clientId: CLIENT }));
      assert.equal(await handler(registeredClient, ctx, { clientId: `pbc_${"f".repeat(43)}` }), null);
    } finally { Date.now = RealNow; }
  });
});

test("revoking a Claude connection ends its registration and every grant made through it", async () => {
  const { ctx, rows } = store();
  const now = new Date().toISOString();
  const base = { userId: "alice", boards: "all", level: "complete", createdAt: now, lastUsedAt: now };
  const machine = await ctx.db.insert("connections", { ...base, kind: "machine", name: "Mac", clientName: "Mac", canAdminister: true });
  await ctx.db.insert("oauthRegistrations", { clientId: CLIENT, redirectUris: [CLAUDE_REDIRECTS[0]], createdAt: Date.now(), userId: "alice" });
  const grantA = await ctx.db.insert("connections", { ...base, kind: "oauth", name: REGISTERED_CLIENT_NAME, clientName: REGISTERED_CLIENT_NAME, canAdminister: false, oauthClientId: CLIENT, oauthResource: `${origin}/mcp`, authorizationVersion: 2 });
  const grantB = await ctx.db.insert("connections", { ...base, kind: "oauth", name: REGISTERED_CLIENT_NAME, clientName: REGISTERED_CLIENT_NAME, canAdminister: false, oauthClientId: CLIENT, oauthResource: `${origin}/mcp`, authorizationVersion: 2 });
  const other = await ctx.db.insert("connections", { ...base, kind: "oauth", name: "Codex", clientName: "Codex", canAdminister: false, oauthClientId: "https://chatgpt.com/oauth/codex/client.json", oauthResource: `${origin}/mcp`, authorizationVersion: 2 });
  await handler(revoke, ctx, { connectionId: machine, targetId: grantA });
  assert.ok(rows.find((row) => row._table === "oauthRegistrations").revokedAt);
  assert.ok((await ctx.db.get(grantA)).revokedAt);
  assert.ok((await ctx.db.get(grantB)).revokedAt);
  assert.equal((await ctx.db.get(other)).revokedAt, undefined);
  assert.equal(await handler(registeredClient, ctx, { clientId: CLIENT }), null);
});

test("authorization for a registered client uses the stored registration, never a metadata fetch", async () => {
  await configured(async () => {
    let fetched = 0;
    const created: any[] = [];
    const ctx: any = {
      runQuery: async (fn: any, args: any) => getFunctionName(fn) === "oauth:registeredClient" && args.clientId === CLIENT ? { clientId: CLIENT, name: REGISTERED_CLIENT_NAME, redirectUris: [CLAUDE_REDIRECTS[0]], native: false } : null,
      runMutation: async (fn: any, args: any) => { created.push([getFunctionName(fn), args]); return { created: true }; },
    };
    const fields = { client_id: CLIENT, redirect_uri: CLAUDE_REDIRECTS[0], response_type: "code", resource: `${origin}/mcp`, code_challenge: "a".repeat(43), code_challenge_method: "S256", scope: "planban:read offline_access", state: "st" };
    const loader = async () => { fetched++; return null; };
    const ok = await authorizationResponse(ctx, new Request(`${origin}/oauth/authorize?${new URLSearchParams(fields)}`), loader);
    assert.equal(ok.status, 303);
    assert.equal(fetched, 0);
    assert.equal(created[0][0], "oauth:createRequest");
    assert.equal(created[0][1].clientName, REGISTERED_CLIENT_NAME);
    const wrongCallback = await authorizationResponse(ctx, new Request(`${origin}/oauth/authorize?${new URLSearchParams({ ...fields, redirect_uri: CLAUDE_REDIRECTS[1] })}`), loader);
    assert.equal(wrongCallback.status, 400);
    const unknown = await authorizationResponse(ctx, new Request(`${origin}/oauth/authorize?${new URLSearchParams({ ...fields, client_id: `pbc_${"z".repeat(43)}` })}`), loader);
    assert.equal(unknown.status, 400);
  });
});
