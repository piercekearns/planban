// More than one Planban account on one computer (owner request, 15 October
// 2026), run against the service's real handlers: the email shown for the
// sign-in, the warning before signing in as someone else, the plain "this
// board belongs to another account" message, and that a second account can't
// take the first account's online board online by any route.
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import { manifestPath } from "../src/core/paths";
import { startServer } from "../src/server/server";
import { PlanbanNotFoundError } from "../src/core/boardOperations";
import { onlineRequest } from "../src/core/online/client";
import { onlineStatus, readCredentials, saveCredentials } from "../src/core/online/credentials";
import { onlineLogin } from "../src/core/online/login";
import { AccountInUseError, BoardOfAnotherAccountError, boardAccount, recordBoardAccountAs, rememberIdentity } from "../src/core/online/accounts";
import { backupRoot } from "../src/core/online/backup";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { restoreBackup, takeOnline } from "../src/core/online/transfers";
import { serviceBridge } from "./service-bridge";

let root: string;
let url: string;
let service: Awaited<ReturnType<typeof serviceBridge>>["service"];
let close: () => Promise<void>;
let control: Awaited<ReturnType<typeof serviceBridge>>["control"];
const savedHome = process.env.PLANBAN_HOME;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-accounts-"));
  process.env.PLANBAN_HOME = join(root, "home");
  const bridge = await serviceBridge();
  ({ url, service, close, control } = bridge);
  resetCopyChecks();
});

test.afterEach(async () => {
  await close();
  await rm(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
});

/** A's board, online, with a copy of its planning folder from before it went online. */
async function anasOnlineBoard() {
  const cwd = join(root, "ana-project");
  await storage.initializeProject({ cwd, repoId: "roadmap", title: "Roadmap", updateAgents: false });
  await storage.createCard({ cwd, title: "Alpha", specMarkdown: "# Spec" });
  const planningRoot = (await storage.loadState(cwd)).planningRoot;
  // Another machine's (or an old checkout's) local copy, made while the board was still local.
  const staleRoot = join(root, "stale-planning");
  await cp(planningRoot, staleRoot, { recursive: true });
  await onlineLogin(url, { devUser: "ana" });
  await takeOnline(url, cwd);
  return { cwd, planningRoot, staleRoot };
}

const anasBoardRow = () => service.rows.find((row) => row._table === "boards" && row.boardId === "roadmap");
const boardsOf = (userId: string) => service.rows.filter((row) => row._table === "boards" && row.ownerId === userId).map((row) => row.boardId).sort();

/** A project folder that holds a local board in `planningRoot`, with the given id. */
async function localProject(name: string, planningRoot: string, repoId = "roadmap") {
  const cwd = join(root, name);
  await storage.initializeProject({ cwd, repoId: `${name}-placeholder`, title: "Placeholder", updateAgents: false });
  await writeFile(manifestPath(cwd), JSON.stringify({ version: 1, repoId, enabled: true, storage: { kind: "local", root: planningRoot } }));
  resetCopyChecks();
  return cwd;
}

test("the sign-in shows its email, and signing in as someone else asks first", async () => {
  await onlineLogin(url, { devUser: "ana" });
  const status = await onlineStatus();
  assert.deepEqual(status.map((entry) => entry.signedInAs), ["ana@example.com"]);
  assert.equal(JSON.stringify(status).includes("\"ana\""), false, "status names the email, not the service's id");

  await assert.rejects(onlineLogin(url, { devUser: "ben" }), (error: unknown) => error instanceof AccountInUseError
    && error.message.startsWith("This computer is signed in as ana@example.com. Signing in as a different account signs ana@example.com out here.")
    && error.message.includes("won't open here until you sign back in as ana@example.com")
    && error.message.includes("--switch-account"));
  assert.deepEqual((await onlineStatus()).map((entry) => entry.signedInAs), ["ana@example.com"], "nothing changed");

  await onlineLogin(url, { devUser: "ben", switchAccount: true });
  assert.deepEqual((await onlineStatus()).map((entry) => entry.signedInAs), ["ben@example.com"]);
});

test("a board of another account says so plainly here, while the service still answers only not found", async () => {
  const { cwd } = await anasOnlineBoard();
  await onlineLogin(url, { devUser: "ben", switchAccount: true });
  await assert.rejects(storage.loadState(cwd), (error: unknown) => error instanceof BoardOfAnotherAccountError
    && error.message === "This board belongs to another Planban account (ana@example.com). Sign in as that account, or ask its owner to invite ben@example.com.");
  await assert.rejects(onlineRequest(url, "/api/v1/boards/roadmap"), PlanbanNotFoundError, "the service reveals nothing");

  // Signing back in as Ana opens it again.
  await onlineLogin(url, { devUser: "ana", switchAccount: true });
  assert.equal((await storage.loadState(cwd)).roadmap.roadmapItems[0]!.title, "Alpha");
});

test("a second account can't take the first account's online board online by any route", async () => {
  const { cwd, planningRoot, staleRoot } = await anasOnlineBoard();
  const before = structuredClone(anasBoardRow());
  assert.equal(before.ownerId, "ana");
  await onlineLogin(url, { devUser: "ben", switchAccount: true });

  // 1. The project folder that now points online.
  await assert.rejects(takeOnline(url, cwd), /already online/);

  // 2. The copy kept from before it went online: an old checkout still pointing at it has no
  // live board left to take online (its roadmap was set aside when the board went online),
  await assert.rejects(takeOnline(url, await localProject("old-checkout", planningRoot)), /Planban roadmap is missing/);
  // and so does that copy put back as a live board, in a folder of its own.
  const revived = join(root, "revived-planning");
  await cp(planningRoot, revived, { recursive: true });
  const snapshot = (await readdir(revived)).find((name) => name.startsWith("roadmap.local-before-online-"));
  assert.ok(snapshot, "the copy from before it went online is kept");
  await rename(join(revived, snapshot), join(revived, "roadmap.json"));
  await rm(join(revived, "ONLINE-BOARD.txt"), { force: true });
  await assert.rejects(takeOnline(url, await localProject("revived", revived)), /An Online Board called roadmap already exists/);

  // 3. A backup restored with restore-backup: it can't keep the board's id,
  const backup = join(backupRoot(url, "roadmap"), "latest");
  await assert.rejects(restoreBackup(backup, join(root, "restored-same-id"), "roadmap"), /needs its own id/);
  // so it goes online only as a second, separate board, named as a restored copy.
  const restoredCwd = join(root, "restored");
  const restored = await restoreBackup(backup, restoredCwd, "roadmap-restored");
  assert.match(restored.title, /^Roadmap \(copy restored from a backup of \d{4}-\d{2}-\d{2}\)$/);
  assert.match(restored.message, /a separate local board \(roadmap-restored\) copied from a backup of the online board roadmap\. It is not linked to that board; taking it online makes a second, separate board\./);
  await takeOnline(url, restoredCwd);
  assert.deepEqual(boardsOf("ben"), ["roadmap-restored"]);
  assert.match(service.rows.find((row) => row._table === "boards" && row.boardId === "roadmap-restored").title, /copy restored from a backup/);

  // 4. A stale local copy with the same board id, also once Ben has been invited to edit it.
  const stale = await localProject("stale", staleRoot);
  await assert.rejects(takeOnline(url, stale), /An Online Board called roadmap already exists/);
  await service.ctx.db.insert("members", { boardId: "roadmap", userId: "ben", role: "editor" });
  resetCopyChecks();
  await assert.rejects(takeOnline(url, stale), /An Online Board called roadmap already exists/);

  // Ana's board is exactly as it was, and still only hers.
  assert.deepEqual(anasBoardRow(), before);
  assert.deepEqual(boardsOf("ana"), ["roadmap"]);
  assert.equal(service.rows.filter((row) => row._table === "transfers" && row.userId === "ben" && row.boardId === "roadmap").length, 0);
});

test("the board page names the account, asks before switching, and explains another account's board", async () => {
  const { cwd } = await anasOnlineBoard();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const status = await (await fetch(`${server.url}/api/boards/roadmap/online`)).json();
    assert.deepEqual(status.accounts, { [url]: "ana@example.com" });

    // Sign-in from the page while Ana is still signed in: the page must ask first, and nothing starts.
    const signIn = (body: Record<string, unknown>) => fetch(`${server.url}/api/online/sign-in`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, ...body }) });
    const refused = await signIn({});
    assert.equal(refused.status, 409);
    assert.deepEqual((await refused.json()).accountInUse, { url, email: "ana@example.com" });
    // Continue: the page asks again with switchAccount and the sign-in goes ahead (this test
    // service has no browser sign-in, so it stops there, past the account check).
    const started = await signIn({ switchAccount: true });
    assert.notEqual(started.status, 409);
    assert.doesNotMatch((await started.json()).error ?? "", /signed in as/);

    // Signed in as Ben (as Continue would, through the browser), the board says whose it is.
    await onlineLogin(url, { devUser: "ben", switchAccount: true });
    const state = await fetch(`${server.url}/api/boards/roadmap/state`);
    assert.equal(state.status, 403);
    const body = await state.json();
    assert.match(body.error, /^This board belongs to another Planban account/);
    assert.deepEqual({ ...body.otherAccount, signInCommand: undefined }, { url, boardAccount: "ana@example.com", signedInAs: "ben@example.com", signInCommand: undefined });
    assert.match(body.otherAccount.signInCommand, /online login .* --switch-account$/);
  } finally { await server.close(); }
});

test("a slow answer about an earlier sign-in never lands on a newer one", async () => {
  await onlineLogin(url, { devUser: "ana" });
  let reached!: () => void;
  const atMe = new Promise<void>((resolve) => { reached = resolve; });
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  control.intercept = async (path) => {
    if (path !== "/api/v1/me" || held) return;
    held = true;
    reached();
    await released;
  };
  const slow = rememberIdentity(url, 1);
  await atMe;
  await onlineLogin(url, { devUser: "ben", switchAccount: true });
  release();
  await slow;
  assert.deepEqual((await onlineStatus()).map((entry) => entry.signedInAs), ["ben@example.com"]);
  assert.equal(Object.values((await readCredentials()).services)[0]!.person, "ben");
});

test("when the service can't be asked, the saved sign-in still needs --switch-account", async () => {
  await onlineLogin(url, { devUser: "ana" });
  control.intercept = async (path) => path === "/api/v1/me" ? { status: 500, body: { error: { code: "internal", message: "down" } } } : undefined;
  await assert.rejects(onlineLogin(url, { devUser: "ben" }), (error: unknown) => error instanceof AccountInUseError && error.message.includes("ana@example.com"));
  // An ended sign-in, though, is nothing to lose.
  control.intercept = async (path) => path === "/api/v1/me" ? { status: 401, body: { error: { code: "unauthorized", message: "ended" } } } : undefined;
  await assert.doesNotReject(onlineLogin(url, { devUser: "ben" }).catch((error) => { if (error instanceof AccountInUseError) throw error; }));
});

test("a board is never noted under an account that signed in after it was opened", async () => {
  await onlineLogin(url, { devUser: "ana" });
  const pinned = Object.values((await readCredentials()).services)[0]!;
  await onlineLogin(url, { devUser: "ben", switchAccount: true });
  await recordBoardAccountAs(url, "roadmap", pinned);
  assert.equal(await boardAccount(url, "roadmap"), null);
  await recordBoardAccountAs(url, "roadmap", Object.values((await readCredentials()).services)[0]!);
  assert.equal((await boardAccount(url, "roadmap"))?.email, "ben@example.com");
});

test("a sign-in from before emails were kept gets its email on the board page", async () => {
  const { cwd } = await anasOnlineBoard();
  const [key, credentials] = Object.entries((await readCredentials()).services)[0]!;
  const { email: _email, ...older } = credentials;
  await saveCredentials(key, older);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const status = await (await fetch(`${server.url}/api/boards/roadmap/online`)).json();
    assert.deepEqual(status.accounts, { [url]: "ana@example.com" });
  } finally { await server.close(); }
});
