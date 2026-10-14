import assert from "node:assert/strict";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import worker, { type Env } from "../online/edge/worker";
import { authorizeEntry, verifyTurnstile } from "../online/service/convex/model/humanCheck";
import { CLAUDE_WEB_CLIENT_ID } from "../online/service/convex/model/oauthClient";

const origin = "https://planban.example";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const PUBLISHED = { client_id: CLAUDE_WEB_CLIENT_ID, client_name: "Claude", redirect_uris: [CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
const fields = { client_id: CLAUDE_WEB_CLIENT_ID, redirect_uri: CALLBACK, response_type: "code", resource: origin + "/mcp", code_challenge: "a".repeat(43), code_challenge_method: "S256", scope: "planban:read", state: "s" };
const url = `${origin}/oauth/authorize?${new URLSearchParams(fields)}`;

async function configured(turnstile: boolean, run: () => Promise<void>) {
  const values: Record<string, string | undefined> = {
    PLANBAN_PUBLIC_URL: origin, CLERK_ISSUER: "https://fixture.clerk.example", CLERK_PUBLISHABLE_KEY: "pk_test_" + btoa("fixture.clerk.example$"), CLERK_SECRET_KEY: "synthetic-fixture-only",
    PLANBAN_TURNSTILE_SITE_KEY: turnstile ? "0x4AAAAAAAsynthetic" : undefined, PLANBAN_TURNSTILE_SECRET: turnstile ? "0x4AAAAAAAsynthetic-secret" : undefined,
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await run();
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

function backend() {
  const calls: string[] = [];
  const ctx: any = {
    runQuery: async (fn: any) => { calls.push(getFunctionName(fn)); return null; },
    runMutation: async (fn: any) => { calls.push(getFunctionName(fn)); return getFunctionName(fn) === "oauth:reserveMetadataFetch" ? true : undefined; },
  };
  return { ctx, calls };
}
const post = (body: string, headers: Record<string, string> = {}) => new Request(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin, "CF-Connecting-IP": "203.0.113.7", ...headers } });

test("without Turnstile settings the sign-in start is unchanged", async () => configured(false, async () => {
  const { ctx, calls } = backend();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(PUBLISHED), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    const response = await authorizeEntry(ctx, new Request(url));
    assert.equal(response.status, 303);
    assert.ok(calls.includes("oauth:createRequest"));
  } finally { globalThis.fetch = realFetch; }
}));

test("with Turnstile, a visit gets the person-check page and touches nothing in the service", async () => configured(true, async () => {
  const { ctx, calls } = backend();
  const response = await authorizeEntry(ctx, new Request(url));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Checking you're a person/);
  assert.match(html, /data-sitekey="0x4AAAAAAAsynthetic" data-action="authorize"/);
  assert.match(html, /<form id="check" method="post" action="">/);
  const csp = response.headers.get("Content-Security-Policy")!;
  assert.match(csp, /script-src 'nonce-[A-Za-z0-9_-]+' https:\/\/challenges\.cloudflare\.com;/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(calls, [], "no request row, no budget spent, no fetch");
}));

test("only a passing, same-origin proof reaches the sign-in start", async () => configured(true, async () => {
  const cases: Array<[Request, boolean | null, number]> = [
    [post("cf-turnstile-response=t", { Origin: "https://attacker.example" }), true, 403],
    [post("other=1"), true, 403],
    [post("cf-turnstile-response=t", { "Content-Type": "text/plain" }), true, 400],
    [post("cf-turnstile-response=t"), false, 403],
    [post("cf-turnstile-response=t"), null, 503],
  ];
  for (const [request, verdict, status] of cases) {
    const { ctx, calls } = backend();
    const response = await authorizeEntry(ctx, request, async () => verdict);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Location"), null);
    assert.deepEqual(calls, [], `refused before any service work (${status})`);
  }

  const { ctx, calls } = backend();
  const seen: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(PUBLISHED), { headers: { "Content-Type": "application/json" } })) as typeof fetch;
  try {
    const passed = await authorizeEntry(ctx, post("cf-turnstile-response=good"), async (_secret, token, ip) => { seen.push(token, ip); return true; });
    assert.equal(passed.status, 303);
    assert.equal(new URL(passed.headers.get("Location")!).pathname, "/oauth/consent");
    assert.deepEqual(seen, ["good", "203.0.113.7"]);
    assert.ok(calls.includes("oauth:createRequest"));
  } finally { globalThis.fetch = realFetch; }
}));

test("Cloudflare's answer must be a success for this address and this action", async () => configured(true, async () => {
  const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  assert.equal(await verifyTurnstile("s", "t", null, answer({ success: true, hostname: "planban.example", action: "authorize" })), true);
  assert.equal(await verifyTurnstile("s", "t", null, answer({ success: true, hostname: "evil.example", action: "authorize" })), false);
  assert.equal(await verifyTurnstile("s", "t", null, answer({ success: true, hostname: "planban.example", action: "other" })), false);
  assert.equal(await verifyTurnstile("s", "t", null, answer({ success: false, "error-codes": ["timeout-or-duplicate"] })), false);
  assert.equal(await verifyTurnstile("s", "t", null, answer({}, 500)), null);
  assert.equal(await verifyTurnstile("s", "t", null, (async () => { throw new Error("down"); }) as unknown as typeof fetch), null);
}));

test("the edge passes the proof's POST to the sign-in start, limited per caller like the visit", async () => {
  const keys: string[] = [];
  const env: Env = { UPSTREAM: "https://native-123.eu-west-1.convex.site", PUBLIC_HOST: "app.planban.example", EDGE_PROOF: "p".repeat(48), SIGNIN_LIMITER: { limit: async ({ key }) => { keys.push(key); return { success: true }; } } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok")) as typeof fetch;
  try {
    const response = await worker.fetch(new Request("https://app.planban.example/oauth/authorize?x=1", { method: "POST", body: "cf-turnstile-response=t", headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.9" } }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(keys, ["203.0.113.9"]);
  } finally { globalThis.fetch = realFetch; }
});
