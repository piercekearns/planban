// Several Planban accounts signed in on one computer at once, like the
// GitHub CLI (owner decision, 15 October 2026): each online board uses the
// account its link here names, never another's.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import { credentialsRoot, onlineStatus, readCredentials } from "../src/core/online/credentials";
import { onlineLogin } from "../src/core/online/login";
import { listAccounts } from "../src/core/online/accounts";
import { refreshBackup } from "../src/core/online/backup";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { attachOnline, takeOnline } from "../src/core/online/transfers";
import { serviceBridge } from "./service-bridge";

let root: string;
let bridge: Awaited<ReturnType<typeof serviceBridge>>;
const savedHome = process.env.PLANBAN_HOME;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-several-"));
  process.env.PLANBAN_HOME = join(root, "home");
  bridge = await serviceBridge([["ana", "Ana"], ["ben", "Ben"]]);
  resetCopyChecks();
});

test.afterEach(async () => {
  await bridge.close();
  await rm(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
});

async function project(name: string, repoId: string) {
  const cwd = join(root, name);
  await storage.initializeProject({ cwd, repoId, title: name, updateAgents: false });
  await storage.createCard({ cwd, title: "Alpha" });
  return cwd;
}
const lastEditor = (boardId: string) => bridge.service.rows.filter((row) => row._table === "history" && row.boardId === boardId).sort((a, b) => b.version - a.version)[0]!.entry.attribution.userId;
const owner = (boardId: string) => bridge.service.rows.find((row) => row._table === "boards" && row.boardId === boardId)!.ownerId;

test("two accounts, two boards, at the same time: each board's edits go as its own account", async () => {
  const revival = await project("revival", "revival");
  const planban = await project("planban", "planban");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, revival);
  await onlineLogin(bridge.url, { devUser: "ben" });
  await takeOnline(bridge.url, planban);
  assert.deepEqual([owner("revival"), owner("planban")], ["ana", "ben"]);
  // Edits to both, interleaved, with Ben the default throughout.
  await Promise.all([
    storage.updateCard({ cwd: revival, cardId: "alpha", summary: "Revival work", baseRevision: (await storage.loadState(revival)).roadmap.revision, actor: "agent" }),
    storage.updateCard({ cwd: planban, cardId: "alpha", summary: "Planban work", baseRevision: (await storage.loadState(planban)).roadmap.revision, actor: "agent" }),
  ]);
  assert.deepEqual([lastEditor("revival"), lastEditor("planban")], ["ana", "ben"]);
  // The automatic backup of Ana's board is taken as Ana too.
  await refreshBackup(bridge.url, "revival", { force: true });
  const accounts = await listAccounts();
  assert.deepEqual(accounts[0]!.accounts.map((account) => [account.email, account.default, account.boards.map((board) => board.boardId)]),
    [["ana@example.com", false, ["revival"]], ["ben@example.com", true, ["planban"]]]);
});

test("take-online and attach can name the account; the board then uses it", async () => {
  const revival = await project("revival", "revival");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await onlineLogin(bridge.url, { devUser: "ben" });
  await takeOnline(bridge.url, revival, { account: "ana@example.com" });
  assert.equal(owner("revival"), "ana");
  // Another folder on this computer attaches it as Ana, though Ben is the default.
  const second = join(root, "second");
  await attachOnline(bridge.url, "revival", second, { account: "ana@example.com" });
  assert.equal((await storage.loadState(second)).roadmap.roadmapItems[0]!.title, "Alpha");
  await assert.rejects(takeOnline(bridge.url, await project("other", "other"), { account: "nobody@example.com" }), /nobody@example\.com isn't signed in/);
});

test("a board linked before several accounts existed is found by the account that can open it, and linked", async () => {
  const revival = await project("revival", "revival");
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, revival);
  await onlineLogin(bridge.url, { devUser: "ben" });
  // No link on this computer (as on a computer that attached it before this version).
  await rm(join(credentialsRoot(), "board-accounts.json"));
  assert.equal((await storage.loadState(revival)).roadmap.roadmapItems[0]!.title, "Alpha");
  const links = JSON.parse(await readFile(join(credentialsRoot(), "board-accounts.json"), "utf8"));
  assert.equal(links.boards[`${bridge.url}|revival`].person, "ana");
});

test("credentials kept in the old one-account form migrate on read, and the next save writes the new form", async () => {
  await mkdir(credentialsRoot(), { recursive: true });
  await writeFile(join(credentialsRoot(), "credentials.json"), JSON.stringify({ version: 1, services: { [bridge.url]: { clientId: "machine", accessToken: "pbm_old", refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z", person: "ana", email: "ana@example.com" } } }));
  assert.deepEqual((await onlineStatus())[0]!.accounts, [{ email: "ana@example.com", default: true }]);
  assert.equal((await readCredentials()).services[bridge.url]!.accessToken, "pbm_old");
  await onlineLogin(bridge.url, { devUser: "ben" });
  const stored = JSON.parse(await readFile(join(credentialsRoot(), "credentials.json"), "utf8"));
  assert.equal(stored.version, 2);
  assert.deepEqual(Object.keys(stored.services[bridge.url].accounts).sort(), ["ana", "ben"]);
  assert.equal(stored.services[bridge.url].default, "ben");
});
