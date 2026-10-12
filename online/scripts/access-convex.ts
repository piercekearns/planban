// Connections, sign-out revocation and personal access keys against a local
// Convex backend. Uses temporary Planban homes and throwaway boards only.
//
//   PLANBAN_ONLINE_URL=http://127.0.0.1:3211 node --import tsx/esm online/scripts/access-convex.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ConvexClient } from "convex/browser";
import { createEmptyRoadmap, planCreateCard } from "../../src/core/boardOperations";

const origin = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3211").replace(/\/+$/, "");
const execFileAsync = promisify(execFile);
let step = 0;
const ok = (label: string) => console.log(`  ok ${++step} - ${label}`);
async function api(token: string | null, method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json().catch(() => null) as any };
}
async function cli(home: string, args: string[], env: Record<string, string> = {}) {
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx/esm", resolve("src/cli.ts"), ...args], { env: { ...process.env, PLANBAN_HOME: home, ...env } });
  return JSON.parse(stdout);
}
async function token(home: string) {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(join(home, "online", "credentials.json"), "utf8")).services[origin].accessToken as string;
}

console.log(`Access checks against ${origin}`);
const user = `person-${Date.now().toString(36)}`;
const macbook = await mkdtemp(join(tmpdir(), "planban-macbook-"));
const mini = await mkdtemp(join(tmpdir(), "planban-mini-"));
await cli(macbook, ["online", "login", origin, "--dev-user", user]);
await cli(mini, ["online", "login", origin, "--dev-user", user]);
const owner = await token(macbook);
const now = new Date().toISOString();
const boardId = `access-${Date.now().toString(36)}`;
const imported = await api(owner, "POST", "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap: planCreateCard(createEmptyRoadmap({ repoId: boardId, title: "Access", now }), { title: "Card" }, { now }).roadmap, docs: [], history: [] });
assert.equal(imported.status, 201);
const otherBoard = `${boardId}-other`;
assert.equal((await api(owner, "POST", "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap: createEmptyRoadmap({ repoId: otherBoard, title: "Other", now }), docs: [], history: [] })).status, 201);

const listed = await cli(macbook, ["online", "connections", origin]);
assert.equal(listed.connections.filter((connection: { active: boolean }) => connection.active).length, 2);
assert.equal(listed.connections.filter((connection: { current: boolean }) => connection.current).length, 1);
assert.ok(listed.connections.every((connection: Record<string, unknown>) => !("tokenHash" in connection)));
ok("a person's own connection lists both machines, and never shows secrets");

const created = await cli(macbook, ["online", "keys", "create", origin, "--board", boardId, "--level", "plan", "--name", "CI agent", "--expires-days", "30"]);
assert.match(created.key, /^pbk_/);
const key = created.key as string;
const revision = (await api(key, "GET", `/api/v1/boards/${boardId}`)).json.roadmap.revision;
assert.equal((await api(key, "POST", `/api/v1/boards/${boardId}/ops/updateCard`, { cardId: "card", summary: "By the CI key", baseRevision: revision })).status, 200);
assert.equal((await api(key, "GET", `/api/v1/boards/${otherBoard}`)).status, 404);
assert.equal((await api(key, "POST", `/api/v1/boards/${boardId}/ops/moveCard`, { cardId: "card", status: "complete", baseRevision: revision + 1 })).status, 403);
assert.equal((await api(key, "POST", "/api/v1/keys", { boardId, level: "plan", name: "nested" })).status, 403);
assert.deepEqual((await api(key, "GET", "/api/v1/connections")).json.connections.map((connection: { name: string }) => connection.name), ["CI agent"]);
ok("a personal access key reaches only its board at its level, cannot make keys, and sees only itself");

const keyHome = await mkdtemp(join(tmpdir(), "planban-ci-"));
const keyLogin = await cli(keyHome, ["online", "login", origin, "--key-env", "PLANBAN_TEST_KEY"], { PLANBAN_TEST_KEY: key });
assert.equal(keyLogin.identity.kind, "key");
ok("the CLI signs in with a key held in an environment variable");

const keyId = (await cli(macbook, ["online", "connections", origin])).connections.find((connection: { name: string }) => connection.name === "CI agent").id;
await cli(macbook, ["online", "revoke", origin, keyId]);
assert.equal((await api(key, "GET", `/api/v1/boards/${boardId}`)).status, 401);
ok("revoking the key cuts it off at once");

// A live subscription stops when its connection is revoked.
const miniToken = await token(mini);
const live = await api(miniToken, "POST", "/api/v1/live-token", {});
const client = new ConvexClient(live.json.convexUrl, { unsavedChangesWarning: false });
client.setAuth(async () => (await api(miniToken, "POST", "/api/v1/live-token", {})).json?.token ?? null);
const stopped = new Promise<string>((resolveStop) => {
  let seen = 0;
  client.onUpdate("live:revision" as never, { boardId } as never, () => { seen += 1; }, (error: Error) => resolveStop(error.message));
  void seen;
});
await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
const logout = await cli(mini, ["online", "logout", origin]);
assert.equal(logout.revoked, true);
const reason = await Promise.race([stopped, new Promise<string>((_, reject) => setTimeout(() => reject(new Error("the subscription was not stopped")), 10_000))]);
assert.match(reason, /signed out|revoked/);
await client.close();
assert.equal((await api(miniToken, "GET", "/api/v1/me")).status, 401);
assert.equal((await api(owner, "GET", "/api/v1/me")).status, 200);
ok("signing out on one machine revokes its connection, stops its live updates, and leaves the other machine signed in");

const viewerKey = await api(owner, "POST", "/api/v1/keys", { boardId, level: "complete", name: "Completer" });
assert.equal(viewerKey.status, 201, "the owner may create a key that completes cards");
const editor = `${user}-editor`;
const editorHome = await mkdtemp(join(tmpdir(), "planban-editor-"));
await cli(editorHome, ["online", "login", origin, "--dev-user", editor]);
await api(owner, "POST", `/api/v1/boards/${boardId}/members`, { userId: editor });
assert.equal((await api(await token(editorHome), "POST", "/api/v1/keys", { boardId, level: "complete", name: "Too much" })).status, 403);
const editorKey = await api(await token(editorHome), "POST", "/api/v1/keys", { boardId, level: "plan", name: "Editor agent" });
assert.equal(editorKey.status, 201);
ok("only the board owner can create a key that completes cards");

assert.equal((await api(await token(editorHome), "GET", `/api/v1/boards/${boardId}`)).status, 200);
assert.equal((await api(editorKey.json.key, "GET", `/api/v1/boards/${boardId}`)).status, 200);
const unconfirmed = await api(owner, "POST", `/api/v1/boards/${boardId}/take-local/fence`, { transferId: `take-local-${Date.now()}-a`, acknowledgedOthers: [] });
assert.equal(unconfirmed.status, 409, "freezing must name exactly who loses access");
assert.equal((await api(await token(editorHome), "GET", `/api/v1/boards/${boardId}`)).status, 200, "nothing changed");
const fenced = await api(owner, "POST", `/api/v1/boards/${boardId}/take-local/fence`, { transferId: `take-local-${Date.now()}`, acknowledgedOthers: [editor] });
assert.equal(fenced.status, 200, JSON.stringify(fenced.json));
assert.deepEqual(fenced.json.removedPeople, [editor]);
assert.equal((await api(await token(editorHome), "GET", `/api/v1/boards/${boardId}`)).status, 404, "the other person loses access");
assert.equal((await api(editorKey.json.key, "GET", `/api/v1/boards/${boardId}`)).status, 404, "and so does their agent");
const kept = await api(owner, "GET", `/api/v1/boards/${boardId}`);
assert.equal(kept.status, 200, "the online copy is kept for the person taking it local");
assert.equal(kept.json.authority, "returned-local");
assert.equal((await api(owner, "POST", `/api/v1/boards/${boardId}/members`, { userId: editor })).status, 409, "nobody can be added back to the retained copy");
ok("taking a shared board local removes everyone else's access, and their agents'; the online copy is kept, read-only");
console.log(`All ${step} checks passed.`);
