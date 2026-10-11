// Checks how the service accepts sign-in-server (Clerk) access tokens, using a
// stand-in sign-in server with its own signing key, so every rule can be
// tested without real accounts. Run against a local backend whose environment
// points at this stand-in (the script prints the settings it needs):
//
//   CLERK_ISSUER=http://127.0.0.1:3499
//   CLERK_JWKS_URL=http://127.0.0.1:3499/.well-known/jwks.json
//   PLANBAN_CLI_CLIENT_ID=test-cli
//
//   PLANBAN_ONLINE_URL=http://127.0.0.1:3411 node --import tsx/esm online/scripts/clerk-tokens-convex.ts
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createEmptyRoadmap } from "../../src/core/boardOperations";

const origin = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3411").replace(/\/+$/, "");
const issuer = "http://127.0.0.1:3499";
let step = 0;
const ok = (label: string) => console.log(`  ok ${++step} - ${label}`);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = randomUUID();
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }] };
const server = createServer((req, res) => {
  res.writeHead(req.url === "/.well-known/jwks.json" ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(req.url === "/.well-known/jwks.json" ? jwks : {}));
});
await new Promise<void>((resolve) => server.listen(3499, "127.0.0.1", resolve));

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(claims: Record<string, unknown>, options: { key?: typeof privateKey; kid?: string } = {}) {
  const head = encode({ alg: "RS256", typ: "JWT", kid: options.kid ?? kid });
  const body = encode({ iss: issuer, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  const signature = createSign("RSA-SHA256").update(`${head}.${body}`).sign(options.key ?? privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
}
async function api(bearer: string | null, method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}${path}`, { method, headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json().catch(() => null) as any };
}

try {
  console.log(`Sign-in server token checks against ${origin}`);
  const discovery = (await api(null, "GET", "/.well-known/planban.json")).json;
  assert.equal(discovery?.signIn?.issuer, issuer, "the backend's environment must point at this stand-in (see the top of this script)");
  assert.equal(discovery.signIn.cliClientId, "test-cli");
  const resource = (await api(null, "GET", "/.well-known/oauth-protected-resource")).json;
  assert.deepEqual(resource.authorization_servers, [issuer]);
  ok("discovery and protected resource metadata name the sign-in server");

  const person = `person-${Date.now().toString(36)}`;
  const owner = (await api(null, "POST", "/dev/token", { userId: person })).json.token as string;
  const boardId = `clerk-${Date.now().toString(36)}`;
  assert.equal((await api(owner, "POST", "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap: createEmptyRoadmap({ repoId: boardId, title: "Clerk", now: new Date().toISOString() }), docs: [], history: [] })).status, 201);

  const claude = token({ sub: person, client_id: "https://claude.ai/oauth/mcp-client-metadata" });
  const me = await api(claude, "GET", "/api/v1/me");
  assert.equal(me.status, 200, JSON.stringify(me.json));
  assert.equal(me.json.kind, "oauth");
  assert.equal(me.json.level, "plan");
  assert.equal(me.json.canAdminister, false);
  assert.equal(me.json.clientName, "claude.ai");
  assert.deepEqual((await api(claude, "GET", "/api/v1/boards")).json.boards.map((board: { boardId: string }) => board.boardId), [boardId]);
  assert.equal((await api(token({ sub: person, client_id: "https://claude.ai/oauth/mcp-client-metadata" }), "GET", "/api/v1/me")).json.connectionId, me.json.connectionId, "one connection per person and app");
  ok("an AI app's token becomes one planning-only connection for that person and app");

  const refused: Array<[string, string]> = [
    [token({ sub: person, sid: "sess_1", azp: "https://app.example" }), "a browser session token"],
    [token({ sub: person, client_id: "x", iss: "https://other.example" }), "another issuer"],
    [token({ sub: person, client_id: "x", exp: Math.floor(Date.now() / 1000) - 3600 }), "an expired token"],
    [token({ sub: person, client_id: "x" }, { key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey }), "a token signed with another key"],
    [token({ sub: person, client_id: "x" }, { kid: "unknown" }), "an unknown key id"],
    [token({ sub: person, client_id: "x", aud: "https://elsewhere.example" }), "a token for another audience"],
    [token({ sub: person, client_id: "test-cli" }), "the command line's own client, outside the sign-in exchange"],
    [`${token({ sub: person, client_id: "x" }).slice(0, -4)}AAAA`, "a tampered signature"],
  ];
  for (const [bad, what] of refused) assert.equal((await api(bad, "GET", "/api/v1/me")).status, 401, what);
  ok("session tokens, other issuers, expired, foreign-key, unknown-key, wrong-audience, tampered and command-line tokens are refused");
  assert.equal((await api(token({ sub: person, client_id: "y", aud: origin }), "GET", "/api/v1/me")).status, 200);
  ok("a token naming this service as its audience is accepted");

  const machine = await api(token({ sub: person, client_id: "test-cli" }), "POST", "/api/v1/auth/machine", { name: "Test Mac" });
  assert.equal(machine.status, 201, JSON.stringify(machine.json));
  assert.match(machine.json.token, /^pbm_/);
  const machineMe = (await api(machine.json.token, "GET", "/api/v1/me")).json;
  assert.equal(machineMe.kind, "machine");
  assert.equal(machineMe.canAdminister, true);
  assert.equal(machineMe.userId, person);
  assert.equal((await api(token({ sub: person, client_id: "test-cli", iat: Math.floor(Date.now() / 1000) - 3600 }), "POST", "/api/v1/auth/machine", {})).status, 401, "an old sign-in");
  assert.equal((await api(token({ sub: person, client_id: "https://claude.ai/oauth/mcp-client-metadata" }), "POST", "/api/v1/auth/machine", {})).status, 401, "another app's token");
  ok("the command line's fresh sign-in becomes this machine's own sign-in; old or other apps' tokens do not");

  const claudeId = me.json.connectionId as string;
  assert.equal((await api(machine.json.token, "POST", `/api/v1/connections/${claudeId}/access`, { level: "read" })).status, 200);
  assert.equal((await api(claude, "GET", "/api/v1/me")).json.level, "read");
  assert.equal((await api(claude, "POST", `/api/v1/connections/${claudeId}/access`, { level: "complete" })).status, 403, "an app cannot raise its own access");
  ok("the person can change an app's access from their own sign-in; the app cannot");

  assert.equal((await api(machine.json.token, "POST", `/api/v1/connections/${claudeId}/revoke`, {})).status, 200);
  assert.equal((await api(claude, "GET", "/api/v1/me")).status, 401);
  assert.equal((await api(token({ sub: person, client_id: "https://claude.ai/oauth/mcp-client-metadata" }), "GET", "/api/v1/me")).status, 401, "a new token from the revoked app");
  assert.equal((await api(machine.json.token, "POST", `/api/v1/connections/${claudeId}/restore`, {})).status, 200);
  assert.equal((await api(token({ sub: person, client_id: "https://claude.ai/oauth/mcp-client-metadata" }), "GET", "/api/v1/me")).status, 200);
  ok("revoking an app sticks even for its new tokens, until the person re-enables it");

  const mcp = await fetch(`${origin}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token({ sub: person, client_id: "https://chatgpt.com/connector" })}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "planban_list_boards", arguments: {} } }) });
  assert.equal(mcp.status, 200);
  assert.match(await mcp.text(), new RegExp(boardId));
  ok("remote MCP accepts an AI app's token");
  console.log(`All ${step} checks passed.`);
} finally {
  server.close();
}
