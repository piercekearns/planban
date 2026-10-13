import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { authenticate, connectionOrigin, EDGE_PROOF_HEADER, requestOrigin } from "../online/service/convex/model/auth";
import { createKey, resolveToken } from "../online/service/convex/connections";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const handler = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);
const PUBLIC = "https://app.planban.example";
const NATIVE = "https://native-315.convex.example";
const PROOF = "synthetic-edge-proof-only";
const BEARER = `Bearer pbm_${"a".repeat(32)}`;

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const names = ["PLANBAN_PUBLIC_URL", "CONVEX_SITE_URL", "PLANBAN_EDGE_PROOF_SHA256"];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) {
    if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name];
  }
  return run().finally(() => {
    for (const name of names) {
      if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name];
    }
  });
}

const edge = { PLANBAN_PUBLIC_URL: PUBLIC, CONVEX_SITE_URL: NATIVE, PLANBAN_EDGE_PROOF_SHA256: digest(PROOF) };
const request = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers: { Authorization: BEARER, ...headers } });
const resolving = (row: Record<string, unknown>): any => ({ runQuery: async () => ({ connectionId: "c1", lastUsedAt: new Date().toISOString(), ...row }) });

test("one address: the public address is trusted only when it is the native one", async () => {
  await withEnv({ PLANBAN_PUBLIC_URL: PUBLIC }, async () => {
    assert.equal(await requestOrigin(request(`${PUBLIC}/mcp`)), PUBLIC);
  });
  await withEnv({ PLANBAN_PUBLIC_URL: `${NATIVE}/`, CONVEX_SITE_URL: NATIVE }, async () => {
    assert.equal(await requestOrigin(request(`${NATIVE}/mcp`)), NATIVE);
    assert.deepEqual(await authenticate(resolving({}), request(`${NATIVE}/mcp`)), { connectionId: "c1" });
  });
  // A separate public address without the edge proof setting fails closed.
  await withEnv({ PLANBAN_PUBLIC_URL: PUBLIC, CONVEX_SITE_URL: NATIVE }, async () => {
    assert.equal(await requestOrigin(request(`${PUBLIC}/mcp`)), null);
    assert.equal(await authenticate(resolving({ oauthResource: PUBLIC }), request(`${PUBLIC}/mcp`)), null);
  });
});

test("behind the edge: only the shared proof makes a request public, never host or forwarding headers", async () => {
  await withEnv(edge, async () => {
    assert.equal(await requestOrigin(request(`${NATIVE}/mcp`, { [EDGE_PROOF_HEADER]: PROOF })), PUBLIC);
    assert.equal(await requestOrigin(request(`${NATIVE}/mcp`)), NATIVE);
    assert.equal(await requestOrigin(request(`${NATIVE}/mcp`, { [EDGE_PROOF_HEADER]: "wrong" })), NATIVE);
    assert.equal(await requestOrigin(request(`${PUBLIC}/mcp`, { Host: "app.planban.example", "X-Forwarded-Host": "app.planban.example", Origin: PUBLIC })), NATIVE);
  });
  for (const broken of [{ ...edge, PLANBAN_EDGE_PROOF_SHA256: "not-a-hash" }, { ...edge, CONVEX_SITE_URL: undefined }, { ...edge, CONVEX_SITE_URL: PUBLIC }]) {
    await withEnv(broken, async () => {
      assert.equal(await requestOrigin(request(`${NATIVE}/mcp`, { [EDGE_PROOF_HEADER]: PROOF })), null);
    });
  }
});

test("behind the edge: every credential kind works only through the address it belongs to", async () => {
  await withEnv(edge, async () => {
    const viaEdge = request(`${NATIVE}/mcp`, { [EDGE_PROOF_HEADER]: PROOF });
    const direct = request(`${NATIVE}/mcp`);
    // App credentials and machine sign-ins are bound by their OAuth resource.
    for (const resource of [PUBLIC, `${PUBLIC}/mcp`]) {
      assert.deepEqual(await authenticate(resolving({ oauthResource: resource }), viaEdge), { connectionId: "c1" });
      assert.equal(await authenticate(resolving({ oauthResource: resource }), direct), null);
    }
    assert.equal(await authenticate(resolving({ oauthResource: "" }), viaEdge), null);
    // Personal keys and dev sign-ins carry their address.
    assert.deepEqual(await authenticate(resolving({ serviceOrigin: PUBLIC }), viaEdge), { connectionId: "c1" });
    assert.equal(await authenticate(resolving({ serviceOrigin: PUBLIC }), direct), null);
    // Older credentials without an address belong to the native address only.
    assert.equal(await authenticate(resolving({}), viaEdge), null);
    assert.deepEqual(await authenticate(resolving({}), direct), { connectionId: "c1" });
    assert.equal(await authenticate(resolving({ oauthResource: NATIVE }), viaEdge), null);
  });
});

function store(rows: any[]) {
  let sequence = 0;
  const db: any = {
    get: async (id: string) => rows.find((row) => row._id === id) ?? null,
    insert: async (table: string, value: any) => { const id = `${table}-${++sequence}`; rows.push({ ...value, _id: id, table }); return id; },
    query: (table: string) => ({
      withIndex: (_name: string, range: (q: any) => any) => {
        const wanted: Record<string, unknown> = {};
        const q: any = { eq: (field: string, value: unknown) => { wanted[field] = value; return q; } };
        range(q);
        const found = rows.filter((row) => row.table === table && Object.entries(wanted).every(([field, value]) => row[field] === value));
        return { unique: async () => found[0] ?? null };
      },
    }),
  };
  return { db, normalizeId: () => null };
}

test("machine sign-ins expose their resource, and personal keys inherit their creator's address", async () => {
  const now = new Date().toISOString();
  const base = { userId: "u1", boards: "all", level: "complete", createdAt: now, lastUsedAt: now };
  const rows: any[] = [
    { ...base, _id: "machine-new", table: "connections", kind: "machine", name: "Mac", clientName: "Mac", tokenHash: "h1", canAdminister: true, oauthClientId: "planban-cli", oauthResource: PUBLIC, authorizationVersion: 2 },
    { ...base, _id: "dev-old", table: "connections", kind: "dev", name: "Dev", clientName: "Dev", tokenHash: "h2", canAdminister: true },
    { _id: "board-1", table: "boards", boardId: "b1" },
    { _id: "member-1", table: "members", boardId: "b1", userId: "u1", role: "owner" },
  ];
  const ctx = store(rows);
  await withEnv(edge, async () => {
    assert.equal((await handler(resolveToken, ctx, { tokenHash: "h1" })).oauthResource, PUBLIC);
    assert.equal((await handler(resolveToken, ctx, { tokenHash: "h2" })).oauthResource, undefined);
    assert.equal(connectionOrigin(rows[0]), PUBLIC);
    assert.equal(connectionOrigin(rows[1]), NATIVE);
    await handler(createKey, ctx, { connectionId: "machine-new", tokenHash: "k1", name: "From new", boardId: "b1", level: "read" });
    await handler(createKey, ctx, { connectionId: "dev-old", tokenHash: "k2", name: "From old", boardId: "b1", level: "read" });
    // A sign-in that only works directly cannot mint a key for the public address.
    assert.equal(rows.find((row) => row.tokenHash === "k1").serviceOrigin, PUBLIC);
    assert.equal(rows.find((row) => row.tokenHash === "k2").serviceOrigin, NATIVE);
    assert.equal((await handler(resolveToken, ctx, { tokenHash: "k1" })).serviceOrigin, PUBLIC);
  });
});
