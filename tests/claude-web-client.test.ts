import assert from "node:assert/strict";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { CLAUDE_WEB_CLIENT_ID, clientRedirectAllowed, loadOAuthClient, metadataClientAllowed, parseClientMetadata, REGISTERED_CLIENT_NAME } from "../online/service/convex/model/oauthClient";
import { authorizationResponse } from "../online/service/convex/model/oauthConsent";
import { tokenResponse } from "../online/service/convex/model/oauthHttp";

// Exactly as claude.ai publishes it (fetched 14 October 2026).
const PUBLISHED = { client_id: CLAUDE_WEB_CLIENT_ID, client_name: "Claude", client_uri: "https://claude.ai", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"], response_types: ["code"], token_endpoint_auth_method: "none" };
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const origin = "https://planban.example";

async function configured(run: () => Promise<void>) {
  const values = { PLANBAN_PUBLIC_URL: origin, CLERK_ISSUER: "https://fixture.clerk.example", CLERK_PUBLISHABLE_KEY: "pk_test_" + btoa("fixture.clerk.example$"), CLERK_SECRET_KEY: "synthetic-fixture-only" };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try { Object.assign(process.env, values); await run(); }
  finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
}

test("claude.ai's published connector document is accepted and named as Claude (claude.ai)", () => {
  assert.equal(metadataClientAllowed(CLAUDE_WEB_CLIENT_ID), true);
  const client = parseClientMetadata(CLAUDE_WEB_CLIENT_ID, PUBLISHED)!;
  assert.ok(client, "the extra jwt-bearer grant is ignored, not refused");
  assert.equal(client.name, REGISTERED_CLIENT_NAME);
  assert.equal(client.native, false);
  assert.deepEqual(client.redirectUris, [CALLBACK]);
  assert.equal(clientRedirectAllowed(client, CALLBACK), true);
  for (const uri of [CALLBACK + "?x=1", CALLBACK + "/", "https://claude.ai/api/mcp/other", "https://attacker.example/api/mcp/auth_callback", "http://127.0.0.1/callback"]) assert.equal(clientRedirectAllowed(client, uri), false, uri);
});

test("the claude.ai document is refused if it strays from Claude's own callback or public sign-in", () => {
  for (const override of [
    { redirect_uris: [CALLBACK, "https://attacker.example/callback"] },
    { redirect_uris: ["https://claude.com/api/mcp/auth_callback"] },
    { application_type: "native", redirect_uris: [CALLBACK] },
    { token_endpoint_auth_method: "client_secret_basic" },
    { grant_types: ["urn:ietf:params:oauth:grant-type:jwt-bearer", "refresh_token"] },
    { response_types: ["token"] },
    { client_id: "https://claude.ai/oauth/claude-code-client-metadata" },
  ]) assert.equal(parseClientMetadata(CLAUDE_WEB_CLIENT_ID, { ...PUBLISHED, ...override }), null, JSON.stringify(override));
});

test("the loader reads the published document, and authorization reaches consent with Claude's exact callback", async () => configured(async () => {
  const fetcher: typeof fetch = async (input) => {
    assert.equal(String(input), CLAUDE_WEB_CLIENT_ID);
    return new Response(JSON.stringify(PUBLISHED), { headers: { "Content-Type": "application/json" } });
  };
  const stored: any[] = [];
  const ctx: any = { runMutation: async (fn: any, args: any) => {
    if (getFunctionName(fn) === "oauth:reserveMetadataFetch") return true;
    assert.equal(getFunctionName(fn), "oauth:createRequest");
    stored.push(args);
  } };
  const fields = { client_id: CLAUDE_WEB_CLIENT_ID, redirect_uri: CALLBACK, response_type: "code", resource: origin + "/mcp", code_challenge: "a".repeat(43), code_challenge_method: "S256", scope: "planban:read offline_access", state: "claude-state" };
  const authorize = (values: Record<string, string>) => new Request(origin + "/oauth/authorize?" + new URLSearchParams(values));
  const response = await authorizationResponse(ctx, authorize(fields), (id) => loadOAuthClient(id, fetcher));
  assert.equal(response.status, 303);
  assert.equal(new URL(response.headers.get("Location")!).pathname, "/oauth/consent");
  assert.equal(stored[0].clientId, CLAUDE_WEB_CLIENT_ID);
  assert.equal(stored[0].clientName, "Claude (claude.ai)");
  assert.equal(stored[0].redirectUri, CALLBACK);

  const refused = await authorizationResponse(ctx, authorize({ ...fields, redirect_uri: "https://attacker.example/callback" }), (id) => loadOAuthClient(id, fetcher));
  assert.equal(refused.status, 400);
  assert.equal(refused.headers.get("Location"), null);
  assert.equal(stored.length, 1);
}));

test("the token endpoint never issues the jwt-bearer grant Claude's document lists", async () => configured(async () => {
  const touched: string[] = [];
  const ctx: any = { runMutation: async () => { touched.push("mutation"); }, runQuery: async () => { touched.push("query"); } };
  const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", client_id: CLAUDE_WEB_CLIENT_ID, resource: origin + "/mcp", assertion: "x.y.z" });
  const response = await tokenResponse(ctx, new Request(origin + "/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "unsupported_grant_type");
  assert.deepEqual(touched, []);
}));
