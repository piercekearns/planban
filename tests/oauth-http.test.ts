import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { tokenResponse, revocationResponse } from "../online/service/convex/model/oauthHttp";

const resource = "https://planban.example/mcp";
const base = { grant_type: "authorization_code", client_id: "https://chatgpt.com/oauth/codex/client.json", resource, code: "pbc_" + "a".repeat(43), code_verifier: "b".repeat(43), redirect_uri: "http://127.0.0.1:54321/callback" };
const request = (data: Record<string, string>, extra: Record<string, string> = {}) => new Request("https://planban.example/oauth/token", { method: "POST", body: new URLSearchParams(data), headers: extra });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("code transport rechecks stored active session, ignores caller identity and sends only independent credential hashes to mutations", async () => {
  const previous = process.env.PLANBAN_PUBLIC_URL;
  process.env.PLANBAN_PUBLIC_URL = "https://planban.example";
  const mutations: any[] = [];
  const context = { sessionId: "sess_fixture", userId: "user_fixture" };
  const ctx: any = { runQuery: async (fn: any, args: any) => { assert.equal(getFunctionName(fn), "oauth:redemptionContext"); assert.equal(args.codeHash, digest(base.code)); return context; }, runMutation: async (fn: any, args: any) => { mutations.push({ fn: getFunctionName(fn), args }); return { machine: false, scope: "planban:read offline_access", expiresIn: 300, refresh: true }; } };
  try {
    const checked: any[] = [];
    const response = await tokenResponse(ctx, request({ ...base, userId: "attacker", sessionId: "attacker" }), async (...ids) => { checked.push(ids); return context; });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const value = await response.json();
    assert.match(value.access_token, /^pba_[A-Za-z0-9_-]{43}$/);
    assert.match(value.refresh_token, /^pbr_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(value.access_token.slice(4), value.refresh_token.slice(4));
    assert.deepEqual(checked, [[context.sessionId, context.userId]]);
    assert.equal(mutations[0].fn, "oauth:redeem");
    assert.equal(mutations[0].args.sessionUserId, context.userId);
    assert.equal(mutations[0].args.challenge, createHash("sha256").update(base.code_verifier).digest("base64url"));
    assert.equal(mutations[0].args.accessHash, digest(value.access_token));
    assert.equal(mutations[0].args.refreshHash, digest(value.refresh_token));
    assert.ok(!JSON.stringify(mutations).includes(value.access_token));
    for (const proof of [null, { ...context, userId: "user_wrong" }, { ...context, sessionId: "sess_wrong" }]) {
      assert.equal((await tokenResponse(ctx, request(base), async () => proof)).status, 400);
    }
    assert.equal(mutations.length, 1, "failed session proofs never consume the code");
  } finally { if (previous === undefined) delete process.env.PLANBAN_PUBLIC_URL; else process.env.PLANBAN_PUBLIC_URL = previous; }
});

test("token transport rejects malformed, ambiguous, oversized, wrong-resource and retired provider credentials before mutation", async () => {
  const previous = process.env.PLANBAN_PUBLIC_URL;
  process.env.PLANBAN_PUBLIC_URL = "https://planban.example";
  let calls = 0;
  const ctx: any = { runQuery: async () => { calls++; return null; }, runMutation: async () => { calls++; return {}; } };
  try {
    for (const override of [{ resource: "https://attacker.example/mcp" }, { resource: "" }, { client_id: "" }, { code: "old.clerk.jwt" }, { code_verifier: "short" }, { redirect_uri: "" }, { scope: "planban:complete" }, { grant_type: "password" }]) assert.equal((await tokenResponse(ctx, request({ ...base, ...override }))).status, 400);
    assert.equal((await tokenResponse(ctx, request(base, { Authorization: "Bearer old.clerk.jwt" }))).status, 400);
    assert.equal((await tokenResponse(ctx, new Request("https://planban.example/oauth/token", { method: "POST", body: JSON.stringify(base), headers: { "Content-Type": "application/json" } }))).status, 400);
    const duplicate = new URLSearchParams(base); duplicate.append("client_id", "attacker");
    assert.equal((await tokenResponse(ctx, new Request("https://planban.example/oauth/token", { method: "POST", body: duplicate }))).status, 400);
    assert.equal((await tokenResponse(ctx, request({ ...base, padding: "x".repeat(8193) }))).status, 400);
    for (const encoded of ["%FF", "%C0%AF", "%", "%GG"]) {
      const body = new URLSearchParams(base).toString() + "&unused=" + encoded;
      assert.equal((await tokenResponse(ctx, new Request("https://planban.example/oauth/token", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }))).status, 400);
    }
    assert.equal((await tokenResponse(ctx, request({ grant_type: "refresh_token", client_id: base.client_id, resource, refresh_token: "old.clerk.jwt" }))).status, 400);
    assert.equal(calls, 0);
  } finally { if (previous === undefined) delete process.env.PLANBAN_PUBLIC_URL; else process.env.PLANBAN_PUBLIC_URL = previous; }
});

test("refresh errors remain errors without exposing replacement secrets, and revocation hides whether a token exists", async () => {
  const previous = process.env.PLANBAN_PUBLIC_URL;
  process.env.PLANBAN_PUBLIC_URL = "https://planban.example";
  const calls: any[] = [];
  const ctx: any = { runMutation: async (fn: any, args: any) => { calls.push({ fn: getFunctionName(fn), args }); return { error: "invalid_grant" }; } };
  try {
    const token = "pbr_" + "c".repeat(43);
    const response = await tokenResponse(ctx, request({ grant_type: "refresh_token", client_id: base.client_id, resource, refresh_token: token }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_grant" });
    assert.equal(calls[0].fn, "oauth:refresh");
    assert.equal(calls[0].args.tokenHash, digest(token));
    const explicit = await tokenResponse(ctx, request({ grant_type: "refresh_token", client_id: base.client_id, resource, refresh_token: token, scope: "offline_access planban:read" }));
    assert.deepEqual(await explicit.json(), { error: "invalid_grant" });
    assert.deepEqual(calls.at(-1).args.requestedScopes, ["offline_access", "planban:read"], "the stored mutation decides equality, not transport input");
    for (const token of ["unknown", "old.clerk.jwt", "pba_" + "d".repeat(43), "pbr_" + "e".repeat(43)]) {
      const response = await revocationResponse(ctx, request({ client_id: base.client_id, token }));
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {});
      assert.equal(calls.at(-1).fn, "oauth:revokeToken");
      assert.equal(calls.at(-1).args.tokenHash, digest(token));
    }
  } finally { if (previous === undefined) delete process.env.PLANBAN_PUBLIC_URL; else process.env.PLANBAN_PUBLIC_URL = previous; }
});
