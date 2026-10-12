import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAUDE_CODE_CLIENT_ID, clientRedirectAllowed, loadOAuthClient, parseClientMetadata } from "../online/service/convex/model/oauthClient";

const codexId = "https://chatgpt.com/oauth/codex/client.json";
const chatId = "https://chatgpt.com/oauth/client.json";
const metadata = (clientId = codexId) => ({ client_id: clientId, client_name: "Codex", application_type: "native", redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });

test("client metadata binds publisher identity and public method, with an exact native callback path", () => {
  const client = parseClientMetadata(codexId, metadata())!;
  assert.ok(client);
  assert.equal(clientRedirectAllowed(client, "http://127.0.0.1:53419/callback"), true);
  assert.equal(clientRedirectAllowed(client, "http://127.0.0.1:80/callback"), true);
  const portRegistered = parseClientMetadata(codexId, { ...metadata(), redirect_uris: ["http://127.0.0.1:53419/callback"] })!;
  assert.equal(clientRedirectAllowed(portRegistered, "http://127.0.0.1/callback"), true);
  assert.equal(clientRedirectAllowed(portRegistered, "http://127.0.0.1:80/callback"), true);
  assert.equal(Object.isFrozen(client), true);
  assert.equal(Object.isFrozen(client.redirectUris), true);
  assert.equal(clientRedirectAllowed(client, "http://localhost/callback"), true);
  for (const uri of ["http://localhost:53419/callback", "http://127.0.0.2:53419/callback", "http://[::1]:53419/callback", "http://127.0.0.1:53419/callback/other", "http://127.0.0.1:53419/callback?", "http://127.0.0.1:53419/callback#", "http://127.0.0.1:53419/callback?extra=1", "http://127.0.0.1:53419/callback#token", "http://attacker@127.0.0.1:53419/callback", " http://127.0.0.1:53419/callback", "https://attacker.example/callback"]) assert.equal(clientRedirectAllowed(client, uri), false, uri);
  const hosted = { ...metadata(chatId), client_name: "ChatGPT", application_type: "web", redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], token_endpoint_auth_method: "private_key_jwt", token_endpoint_auth_methods_supported: ["none", "private_key_jwt"] };
  const chat = parseClientMetadata(chatId, hosted)!;
  assert.ok(chat, "public method must be a supported intersection even when publisher prefers a different method");
  assert.equal(clientRedirectAllowed(chat, hosted.redirect_uris[0]!), true);
  assert.equal(clientRedirectAllowed(chat, hosted.redirect_uris[0] + "?attacker=1"), false);
  assert.equal(parseClientMetadata(chatId, { ...hosted, token_endpoint_auth_methods_supported: ["private_key_jwt"] }), null);
  for (const override of [{ client_id: chatId }, { client_name: "" }, { redirect_uris: ["http://private.example/callback"] }, { redirect_uris: ["javascript:alert(1)"] }, { response_types: ["token"] }, { grant_types: ["client_credentials"] }, { token_endpoint_auth_method: "client_secret_basic" }]) assert.equal(parseClientMetadata(codexId, { ...metadata(), ...override }), null);
});

test("metadata loader never fetches unreviewed URLs or secondary locations and bounds response bytes", async () => {
  let calls = 0, requestOptions: any;
  let response = () => new Response(JSON.stringify({ ...metadata(), logo_uri: "http://private.example/logo", jwks_uri: "http://private.example/keys" }), { headers: { "Content-Type": "application/json" } });
  const fetcher: typeof fetch = async (_input, init) => { calls++; requestOptions = init; return response(); };
  for (const id of ["http://127.0.0.1/secrets", "https://chatgpt.com.attacker.example/oauth/client.json", codexId + "?target=private", "https://chatgpt.com/oauth/other/client.json", "https://attacker.example/client.json"]) assert.equal(await loadOAuthClient(id, fetcher), null);
  assert.equal(calls, 0);
  assert.ok(await loadOAuthClient(codexId, fetcher));
  assert.equal(calls, 1, "logo and key URLs are ignored");
  assert.equal(requestOptions.redirect, "error");
  assert.ok(requestOptions.signal instanceof AbortSignal);
  for (const body of ["x".repeat(5121), "not JSON"]) {
    response = () => new Response(body, { headers: { "Content-Type": "application/json" } });
    assert.equal(await loadOAuthClient(codexId, fetcher), null);
  }
  response = () => new Response("{}", { headers: { "Content-Type": "text/html" } });
  assert.equal(await loadOAuthClient(codexId, fetcher), null);
  response = () => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "6000" } });
  assert.equal(await loadOAuthClient(codexId, fetcher), null);
  response = () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/secrets" } });
  assert.equal(await loadOAuthClient(codexId, fetcher), null);
});

test("only the reviewed Claude Code publisher may omit its native application type", () => {
  const { application_type: _unused, ...doc } = metadata(CLAUDE_CODE_CLIENT_ID);
  const client = parseClientMetadata(CLAUDE_CODE_CLIENT_ID, { ...doc, client_name: "Claude Code" })!;
  assert.ok(client?.native);
  assert.equal(clientRedirectAllowed(client, "http://127.0.0.1:54321/callback"), true);
  for (const uri of ["http://localhost:54321/callback", "http://127.0.0.1:54321/callback?", "http://127.0.0.1:54321/callback/other", "http://attacker.example/callback"]) assert.equal(clientRedirectAllowed(client, uri), false);
  assert.equal(parseClientMetadata(codexId, { ...doc, client_id: codexId }), null);
  assert.equal(parseClientMetadata(CLAUDE_CODE_CLIENT_ID, { ...doc, application_type: "web" }), null);
  assert.equal(parseClientMetadata("https://claude.ai/api/oauth/mcp-oauth-client-metadata", { ...doc, client_id: "https://claude.ai/api/oauth/mcp-oauth-client-metadata" }), null);
});
