// Inviting people, joining, roles and agent permissions against a local
// Convex backend (owner decisions 8 and 15). Throwaway boards and temporary
// Planban homes only.
//
//   PLANBAN_ONLINE_URL=http://127.0.0.1:3411 node --import tsx/esm online/scripts/invites-convex.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { createEmptyRoadmap, planCreateCard } from "../../src/core/boardOperations";

const origin = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3411").replace(/\/+$/, "");
const execFileAsync = promisify(execFile);
let step = 0;
const ok = (label: string) => console.log(`  ok ${++step} - ${label}`);
async function api(token: string | null, method: string, path: string, body?: unknown) {
  const response = await fetch(`${origin}${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json().catch(() => null) as any };
}
async function cli(home: string, args: string[]) {
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx/esm", resolve("src/cli.ts"), ...args], { env: { ...process.env, PLANBAN_HOME: home } });
  return JSON.parse(stdout);
}
async function signIn(userId: string) {
  const home = await mkdtemp(join(tmpdir(), `planban-${userId}-`));
  await cli(home, ["online", "login", origin, "--dev-user", userId]);
  const token = JSON.parse(await readFile(join(home, "online", "credentials.json"), "utf8")).services[origin].accessToken as string;
  return { home, token };
}

console.log(`Invite checks against ${origin}`);
const stamp = Date.now().toString(36);
const owner = await signIn(`owner-${stamp}`);
const maya = await signIn(`maya-${stamp}`);
const jo = await signIn(`jo-${stamp}`);
const boardId = `invites-${stamp}`;
const now = new Date().toISOString();
assert.equal((await api(owner.token, "POST", "/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap: planCreateCard(createEmptyRoadmap({ repoId: boardId, title: "Northfold", now }), { title: "Card" }, { now }).roadmap, docs: [], history: [] })).status, 201);

const made = await api(owner.token, "POST", `/api/v1/boards/${boardId}/invites`, { role: "editor" });
assert.equal(made.status, 201, JSON.stringify(made.json));
assert.match(made.json.link, /\/invite\/pbi_/);
assert.equal(Date.parse(made.json.invite.expiresAt) - Date.parse(made.json.invite.createdAt), 7 * 24 * 60 * 60 * 1000);
assert.equal((await api(maya.token, "POST", `/api/v1/boards/${boardId}/invites`, { role: "viewer" })).status, 404, "people not on the board cannot invite");
ok("the owner makes an invite link that lasts 7 days");

const page = await fetch(made.json.link.replace(/^https?:\/\/[^/]+/, origin));
assert.equal(page.status, 200);
const html = await page.text();
assert.match(html, /Join Northfold on Planban/);
assert.match(html, /planban online join/);
assert.equal((await fetch(`${origin}/invite/pbi_${"x".repeat(43)}`)).status, 404);
ok("the link opens a page saying what it is for and how to join; a made-up link shows nothing");

const joined = await cli(maya.home, ["online", "join", made.json.link.replace(/^https?:\/\/[^/]+/, origin)]);
assert.equal(joined.boardId, boardId);
assert.equal(joined.role, "editor");
const joinedAgain = await cli(jo.home, ["online", "join", made.json.link.replace(/^https?:\/\/[^/]+/, origin)]);
assert.equal(joinedAgain.role, "editor", "a link works for anyone until it expires");
assert.equal((await api(maya.token, "GET", `/api/v1/boards/${boardId}`)).status, 200);
ok("anyone with the link joins with their own sign-in, as the invite's role");

const agent = await api(null, "POST", "/dev/token", { userId: `maya-${stamp}`, boards: [boardId], level: "plan", clientName: "Claude" });
const second = await api(owner.token, "POST", `/api/v1/boards/${boardId}/invites`, { role: "viewer" });
assert.equal((await api(agent.json.token, "POST", "/api/v1/invites/accept", { token: second.json.link })).status, 403, "an agent cannot accept invites");
assert.equal((await api(owner.token, "POST", `/api/v1/boards/${boardId}/invites/${second.json.invite.id}/revoke`, {})).status, 200);
const outsider = await signIn(`outsider-${stamp}`);
assert.equal((await api(outsider.token, "POST", "/api/v1/invites/accept", { token: second.json.link })).status, 404, "a cancelled invite no longer works");
const emailInvite = await api(owner.token, "POST", `/api/v1/boards/${boardId}/invites`, { role: "viewer", email: "someone@example.com" });
assert.equal(emailInvite.status, 201);
assert.equal(emailInvite.json.emailSent, false, "no email is sent unless the service is set up to send them");
assert.equal((await api(outsider.token, "POST", "/api/v1/invites/accept", { token: emailInvite.json.link })).status, 403, "an email invite only works for that email's account");
ok("agents cannot accept invites; cancelled invites stop working; an email invite is for one account");

const listed = (await api(maya.token, "GET", `/api/v1/boards/${boardId}/people`)).json;
assert.deepEqual(listed.people.map((person: { role: string }) => person.role).sort(), ["editor", "editor", "owner"]);
assert.equal(listed.people.find((person: { userId: string }) => person.userId === `maya-${stamp}`).agentLevel, "plan");
assert.equal((await api(maya.token, "POST", `/api/v1/boards/${boardId}/people/me/agents`, { level: "read" })).status, 200);
assert.equal((await api(jo.token, "GET", `/api/v1/boards/${boardId}/people`)).json.people.find((person: { userId: string }) => person.userId === `maya-${stamp}`).agentLevel, "read", "everyone sees each person's choice");
ok("everyone on the board sees each person's role and what their agents may do; each person sets their own");

assert.equal((await api(maya.token, "POST", `/api/v1/boards/${boardId}/members/${encodeURIComponent(`jo-${stamp}`)}/remove`, {})).status, 403, "only the owner changes who is on the board");
assert.equal((await api(owner.token, "POST", `/api/v1/boards/${boardId}/members/${encodeURIComponent(`jo-${stamp}`)}/role`, { role: "viewer" })).status, 200);
const joEdit = await api(jo.token, "POST", `/api/v1/boards/${boardId}/ops/createCard`, { title: "Nope", baseRevision: (await api(jo.token, "GET", `/api/v1/boards/${boardId}`)).json.roadmap.revision });
assert.equal(joEdit.status, 403, "a viewer cannot edit");
assert.equal((await api(owner.token, "POST", `/api/v1/boards/${boardId}/members/${encodeURIComponent(`jo-${stamp}`)}/remove`, {})).status, 200);
assert.equal((await api(jo.token, "GET", `/api/v1/boards/${boardId}`)).status, 404);
ok("the owner changes roles and removes people; their access follows at once");
console.log(`All ${step} checks passed.`);
