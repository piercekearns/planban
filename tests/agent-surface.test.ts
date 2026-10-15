// The contract agents rely on, the same from every Planban surface
// (agent-surface audit, 15 October 2026): a reusable key makes a retried edit
// apply once; failures keep their kind and details as JSON; an online board
// isn't deleted from a computer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as storage from "../src/core/storage";
import { deleteBoard, listBoards } from "../src/core/registry";
import { errorReport } from "../src/core/errorReport";
import { onlineLogin } from "../src/core/online/login";
import { resetCopyChecks } from "../src/core/online/copyCheck";
import { takeOnline } from "../src/core/online/transfers";
import { serviceBridge } from "./service-bridge";

let root: string;
let bridge: Awaited<ReturnType<typeof serviceBridge>>;
const savedHome = process.env.PLANBAN_HOME;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-agent-surface-"));
  process.env.PLANBAN_HOME = join(root, "home");
  bridge = await serviceBridge();
  resetCopyChecks();
});

test.afterEach(async () => {
  await bridge.close();
  await rm(root, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.PLANBAN_HOME;
  else process.env.PLANBAN_HOME = savedHome;
});

async function onlineBoard() {
  const cwd = join(root, "project");
  await storage.initializeProject({ cwd, repoId: "roadmap", title: "Roadmap", updateAgents: false });
  await storage.createCard({ cwd, title: "Alpha" });
  await onlineLogin(bridge.url, { devUser: "ana" });
  await takeOnline(bridge.url, cwd);
  return cwd;
}

/** Runs the CLI without blocking this process, which also serves the test service. */
function run(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", "src/cli.ts", ...args], { env: process.env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
const cli = (cwd: string, ...args: string[]) => run([...args, "--cwd", cwd]);

test("a retry with the same key applies the edit once; the board says it was a replay", async () => {
  const cwd = await onlineBoard();
  const base = (await storage.loadState(cwd)).roadmap.revision;
  const edit = { cwd, cardId: "alpha", summary: "Once", baseRevision: base, actor: "agent" as const, idempotencyKey: "retry-key-0001" };
  const first = await storage.updateCard(edit);
  const again = await storage.updateCard(edit);
  assert.equal(first.roadmap.revision, base + 1);
  assert.equal(again.onlineReplay?.replayed, true);
  assert.equal((await storage.loadState(cwd)).roadmap.revision, base + 1, "applied once");
  // The same key for a different edit is refused, so a revised edit needs a new key.
  await assert.rejects(storage.updateCard({ ...edit, summary: "Revised" }), /already used for a different request/);

  // The command line takes the key too.
  const revision = String((await storage.loadState(cwd)).roadmap.revision);
  for (let i = 0; i < 2; i += 1) {
    const result = await cli(cwd, "update-card", "alpha", "--summary", "From the CLI", "--base-revision", revision, "--idempotency-key", "cli-key-00001", "-o", "json");
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal((await storage.loadState(cwd)).roadmap.revision, Number(revision) + 1);
});

test("a JSON caller gets a failure as JSON, with its kind and the details to act on", async () => {
  const cwd = await onlineBoard();
  const stale = await cli(cwd, "update-card", "alpha", "--summary", "Stale", "--base-revision", "0", "-o", "json");
  assert.equal(stale.status, 1);
  const report = JSON.parse(stale.stdout).error;
  assert.equal(report.category, "conflict");
  assert.equal(typeof report.details.currentRevision, "number");
  assert.match(stale.stderr, /Roadmap changed|revision/);

  // The online commands take -o json as well.
  const status = await run(["online", "status", "-o", "json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).map((entry: { signedInAs: string }) => entry.signedInAs), ["ana@example.com"]);
  const another = await run(["online", "login", bridge.url, "--dev-user", "ben", "-o", "json"]);
  assert.equal(another.status, 1);
  assert.deepEqual(JSON.parse(another.stdout).error.details, { url: bridge.url, signedInAs: "ana@example.com", retryWith: "--switch-account" });
});

test("an online board isn't deleted from a computer; it can only be removed from this one", async () => {
  const cwd = await onlineBoard();
  await storage.loadState(cwd);
  const { registerBoardFromCwd } = await import("../src/core/registry");
  await registerBoardFromCwd(cwd);
  const refusal = await deleteBoard("roadmap").then(() => null, (error: unknown) => error);
  assert.ok(refusal);
  assert.equal(errorReport(refusal).category, "validation");
  assert.match((refusal as Error).message, /"Roadmap" is an online board, so deleting it here would only remove it from this computer: it stays online for everyone on it\. To delete the board itself, its owner takes it local \(Board settings, Take local\) and then deletes the online copy at app\.planban\.ai/);
  const removed = await deleteBoard("roadmap", { thisComputerOnly: true });
  assert.equal(removed.removedFromThisComputerOnly, true);
  assert.equal((await listBoards()).some((board) => board.repoId === "roadmap"), false);
  assert.equal(bridge.service.rows.find((row) => row._table === "boards" && row.boardId === "roadmap").authority, "online", "the board is still online");
});
