import assert from "node:assert/strict";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { fail } from "../online/service/convex/model/errors";
import { mcp } from "../online/service/convex/http";
import { mcpPermissions } from "../online/service/convex/boards";
import { discoverTools, handleMcp, McpService, TOOLS } from "../online/service/convex/model/mcp";

function fixture() {
  const now = new Date().toISOString();
  const rows: any[] = [
    { _id: "grant", table: "connections", userId: "person", kind: "oauth", level: "complete", boards: "all", canAdminister: false, authorizationVersion: 2, oauthClientId: "client", oauthResource: "resource", lastUsedAt: now },
    { _id: "token", table: "connections", userId: "person", kind: "oauth", level: "read", boards: "all", canAdminister: false, authorizationVersion: 2, oauthConnectionId: "grant", oauthClientId: "client", oauthResource: "resource", lastUsedAt: now },
    { _id: "board", table: "boards", boardId: "one", authority: "online" },
    { _id: "member", table: "members", boardId: "one", userId: "person", role: "owner", agentLevel: "complete" },
  ];
  const db: any = { get: async (id: string) => rows.find((row) => row._id === id) ?? null, query(table: string) {
    const filters: Array<(row: any) => boolean> = [];
    const matches = () => rows.filter((row) => row.table === table && filters.every((filter) => filter(row)));
    const query: any = { withIndex(_name: string, build: any) { const index: any = { eq(key: string, value: unknown) { filters.push((row) => row[key] === value); return index; } }; build(index); return query; }, collect: async () => matches(), unique: async () => matches()[0] ?? null };
    return query;
  } };
  const permissions = () => (mcpPermissions as any)._handler({ db }, { connectionId: "token" });
  return { rows, permissions };
}

test("discovery uses immutable token ceiling and live grant, person, board and revocation state", async () => {
  const f = fixture(), grant = f.rows[0], token = f.rows[1], board = f.rows[2], member = f.rows[3];
  const writes = async () => discoverTools(await f.permissions()).filter((tool) => !tool.annotations.readOnlyHint);
  assert.equal((await writes()).length, 0, "a read token stays read even under a complete grant and owner role");
  token.level = "plan";
  assert.ok((await writes()).length > 0);
  grant.level = "read";
  assert.equal((await writes()).length, 0);
  grant.level = token.level = "complete"; member.agentLevel = "read";
  assert.equal((await writes()).length, 0);
  member.agentLevel = "complete"; member.role = "viewer";
  assert.equal((await writes()).length, 0);
  member.role = "editor"; delete member.agentLevel;
  const editor = (await f.permissions())[0];
  assert.equal(editor.canWrite, true);
  assert.equal(editor.canComplete, false, "an editor's default agent choice is planning");
  board.authority = "local";
  assert.equal((await writes()).length, 0);
  board.authority = "online"; grant.boards = ["other"];
  assert.deepEqual(await f.permissions(), []);
  grant.boards = "all"; grant.revokedAt = new Date().toISOString();
  await assert.rejects(f.permissions(), /revoked/);
  delete grant.revokedAt; token.expiresAt = "2000-01-01T00:00:00Z";
  await assert.rejects(f.permissions(), /revoked/);
  delete token.expiresAt;
  f.rows.splice(3, 1);
  assert.deepEqual(await f.permissions(), [], "removed membership removes capabilities");
});

test("plan and mixed-board completion schemas preserve exact targets without mutating another caller's catalog", () => {
  const original = JSON.stringify(TOOLS);
  const plan = discoverTools([{ boardId: "plan", canWrite: true, canComplete: false }]);
  const create = plan.find((tool) => tool.name === "planban_create_card")!;
  const properties: any = create.inputSchema.properties;
  assert.equal(properties.status.enum.includes("complete"), false);
  assert.equal(properties.completionConfirmed, undefined);
  const mixed = discoverTools([{ boardId: "read", canWrite: false, canComplete: false }, { boardId: "plan", canWrite: true, canComplete: false }, { boardId: "finish", canWrite: true, canComplete: true }]);
  const move = mixed.find((tool) => tool.name === "planban_move_card")!;
  const schema: any = move.inputSchema;
  assert.deepEqual(schema.properties.boardId.enum, ["finish", "plan"]);
  assert.deepEqual(schema.allOf[0].then.properties.boardId.enum, ["finish"]);
  assert.equal(schema.allOf[0].then.properties.completionConfirmed.const, true);
  const read = discoverTools([{ boardId: "read", canWrite: false, canComplete: false }]);
  assert.ok(read.every((tool) => tool.annotations.readOnlyHint));
  assert.equal(JSON.stringify(TOOLS), original, "scoped schemas never alter the shared catalog");
});

test("tools/list queries current permissions on each request and never declares a public cache", async () => {
  let count = 0, writable = true;
  const ctx: any = { runQuery: async (fn: any) => { assert.equal(getFunctionName(fn), "boards:mcpPermissions"); count++; return [{ boardId: "one", canWrite: writable, canComplete: writable }]; } };
  const service = new McpService(ctx, "token" as any);
  const list = async () => (await handleMcp(new Request("https://planban.example/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), service, "https://planban.example")).json();
  assert.ok((await list()).result.tools.some((tool: any) => !tool.annotations.readOnlyHint));
  writable = false;
  const response = await list();
  assert.ok(response.result.tools.every((tool: any) => tool.annotations.readOnlyHint));
  assert.equal(response.result.ttlMs, 0);
  assert.equal(response.result.cacheScope, "private");
  assert.equal(count, 2);
});

test("revocation between HTTP authentication and discovery retains the same OAuth challenge", async () => {
  const previous = process.env.PLANBAN_PUBLIC_URL;
  process.env.PLANBAN_PUBLIC_URL = "https://planban.example";
  const request = () => new Request("https://planban.example/mcp", {
    method: "POST", headers: { Authorization: "Bearer pba_" + "a".repeat(43) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const invoke = (ctx: any) => (mcp as any)._handler(ctx, request());
  try {
    const initial = await invoke({ runQuery: async () => null });
    let queries = 0;
    const raced = await invoke({ runQuery: async (fn: any) => {
      queries++;
      if (getFunctionName(fn) === "connections:resolveToken") return { connectionId: "token", lastUsedAt: new Date().toISOString() };
      assert.equal(getFunctionName(fn), "boards:mcpPermissions");
      fail("unauthorized", "Connection revoked.");
    } });
    assert.equal(queries, 2);
    assert.equal(initial.status, 401);
    assert.equal(raced.status, 401);
    assert.equal(raced.headers.get("Cache-Control"), "no-store");
    assert.equal(raced.headers.get("WWW-Authenticate"), initial.headers.get("WWW-Authenticate"));
    assert.match(raced.headers.get("WWW-Authenticate")!, /resource_metadata="https:\/\/planban.example\/\.well-known\/oauth-protected-resource\/mcp"/);
    assert.deepEqual(await raced.json(), await initial.json());
    const forbidden = await invoke({ runQuery: async (fn: any) => {
      if (getFunctionName(fn) === "connections:resolveToken") return { connectionId: "token", lastUsedAt: new Date().toISOString() };
      fail("forbidden", "Not permitted.");
    } });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers.get("WWW-Authenticate"), null);
  } finally {
    if (previous === undefined) delete process.env.PLANBAN_PUBLIC_URL; else process.env.PLANBAN_PUBLIC_URL = previous;
  }
});
