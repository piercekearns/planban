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
import { createHash, createPrivateKey, createPublicKey, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createEmptyRoadmap } from "../../src/core/boardOperations";

const origin = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3411").replace(/\/+$/, "");
const issuer = "http://127.0.0.1:3499";
let step = 0;
const ok = (label: string) => console.log(`  ok ${++step} - ${label}`);

// The stand-in's key is kept between runs: the service refetches a key set at
// most every 30 seconds, so a new key each run would be refused for a while.
const keyFile = join(tmpdir(), "planban-clerk-stand-in-key.pem");
if (!existsSync(keyFile)) writeFileSync(keyFile, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
const privateKey = createPrivateKey(readFileSync(keyFile));
const publicKey = createPublicKey(privateKey);
const kid = createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex").slice(0, 16);
const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" }] };
let keyFetches = 0;
const server = createServer((req, res) => {
  if (req.url === "/.well-known/jwks.json") keyFetches += 1;
  res.writeHead(req.url === "/.well-known/jwks.json" ? 200 : 404, { "Content-Type": "application/json" });
  res.end(JSON.stringify(req.url === "/.well-known/jwks.json" ? jwks : {}));
});
await new Promise<void>((resolve) => server.listen(3499, "127.0.0.1", resolve));

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
function token(claims: Record<string, unknown>, options: { key?: typeof privateKey; kid?: string } = {}) {
  const head = encode({ alg: "RS256", typ: "JWT", kid: options.kid ?? kid });
  const body = encode({ iss: issuer, jti: randomUUID(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
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
    [token({ sub: person, sid: "sess_1", client_id: "x" }), "a session token that also names a client"],
    [token({ sub: person, client_id: "x", iat: undefined }), "a token without an issue time"],
    [token({ sub: person, client_id: "x", iat: Math.floor(Date.now() / 1000) + 3600 }), "a token issued in the future"],
    [token({ sub: person, client_id: "x", nbf: String(Math.floor(Date.now() / 1000) + 3600) }), "a token with a malformed start time"],
    [`${encode(null)}.${token({ sub: person, client_id: "x" }).split(".")[1]}.AAAA`, "a token whose header is not an object"],
    [`${token({ sub: person, client_id: "x" }).split(".").slice(0, 2).join(".")}.!!!`, "a token whose signature is not base64"],
  ];
  for (const [bad, what] of refused) assert.equal((await api(bad, "GET", "/api/v1/me")).status, 401, what);
  ok("session tokens, other issuers, expired, foreign-key, unknown-key, wrong-audience, tampered, badly timed, malformed and command-line tokens are refused");
  const fetchesBefore = keyFetches;
  for (let i = 0; i < 5; i += 1) assert.equal((await api(token({ sub: person, client_id: "x" }, { kid: randomUUID() }), "GET", "/api/v1/me")).status, 401);
  assert.ok(keyFetches - fetchesBefore <= 1, `made-up key ids fetched the key set ${keyFetches - fetchesBefore} times`);
  ok("made-up key ids cannot make the service keep refetching the sign-in server's keys");
  assert.equal((await api(token({ sub: person, client_id: "y", aud: origin }), "GET", "/api/v1/me")).status, 200);
  ok("a token naming this service as its audience is accepted");

  const cliToken = token({ sub: person, client_id: "test-cli" });
  const machine = await api(cliToken, "POST", "/api/v1/auth/machine", { name: "Test Mac" });
  assert.equal(machine.status, 201, JSON.stringify(machine.json));
  assert.match(machine.json.token, /^pbm_/);
  const machineMe = (await api(machine.json.token, "GET", "/api/v1/me")).json;
  assert.equal(machineMe.kind, "machine");
  assert.equal(machineMe.canAdminister, true);
  assert.equal(machineMe.userId, person);
  assert.equal((await api(token({ sub: person, client_id: "test-cli", iat: Math.floor(Date.now() / 1000) - 3600 }), "POST", "/api/v1/auth/machine", {})).status, 401, "an old sign-in");
  assert.equal((await api(token({ sub: person, client_id: "https://claude.ai/oauth/mcp-client-metadata" }), "POST", "/api/v1/auth/machine", {})).status, 401, "another app's token");
  ok("the command line's fresh sign-in becomes this machine's own sign-in; old or other apps' tokens do not");
  assert.equal((await api(cliToken, "POST", "/api/v1/auth/machine", {})).status, 401, "the same sign-in a second time");
  // The same token spelled differently: padded, or with the signature's unused low bits changed.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const respelled = `${cliToken.slice(0, -1)}${alphabet[alphabet.indexOf(cliToken.at(-1)!) ^ 1]}`;
  assert.equal((await api(`${cliToken}=`, "POST", "/api/v1/auth/machine", {})).status, 401, "the same sign-in, padded");
  assert.equal((await api(respelled, "POST", "/api/v1/auth/machine", {})).status, 401, "the same sign-in, respelled");
  const spareToken = token({ sub: person, client_id: "test-cli" });
  const spare = await api(spareToken, "POST", "/api/v1/auth/machine", { name: "Spare" });
  assert.equal(spare.status, 201);
  assert.equal((await api(spare.json.token, "POST", `/api/v1/connections/${spare.json.connectionId}/revoke`, {})).status, 200);
  assert.equal((await api(spareToken, "POST", "/api/v1/auth/machine", {})).status, 401, "the same sign-in after signing out");
  ok("a command-line sign-in token works once, however it is spelled and even after the machine signs out");

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
