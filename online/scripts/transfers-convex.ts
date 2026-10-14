// Crash tests for Take Online and Take Local against a local Convex backend.
// A board with about 10 MB of documents (several upload parts) is taken
// online and back, with the CLI killed mid-transfer each way; running the
// command again must finish exactly once with nothing lost.
// Uses a temporary PLANBAN_HOME and project; touches no real board.
//
//   PLANBAN_HOME=$(mktemp -d) PLANBAN_ONLINE_URL=http://127.0.0.1:3211 node --import tsx/esm online/scripts/transfers-convex.ts
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const home = process.env.PLANBAN_HOME ?? "";
if (!home.startsWith(tmpdir()) && !home.startsWith("/tmp") && !home.startsWith("/var/folders")) throw new Error("Run with PLANBAN_HOME set to a temporary folder.");
const url = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3211").replace(/\/+$/, "");
const execFileAsync = promisify(execFile);
const cli = resolve("src/cli.ts");
const storage = await import("../../src/core/storage");
const { onlineLogin } = await import("../../src/core/online/login");
const { takeOnline, takeLocal } = await import("../../src/core/online/transfers");

let step = 0;
const ok = (label: string) => console.log(`  ok ${++step} - ${label}`);

async function killedAt(point: string, args: string[]) {
  const failure = await execFileAsync(process.execPath, ["--import", "tsx/esm", cli, ...args], { env: { ...process.env, PLANBAN_TEST_CRASH_AT: point }, maxBuffer: 1 << 24 })
    .then(() => null, (error) => error);
  assert.equal(failure?.signal, "SIGKILL", `expected the CLI to be killed at ${point}: ${failure?.stderr ?? "it finished"}`);
}

const cwd = await mkdtemp(join(tmpdir(), "planban-transfer-"));
const repoId = `crash-${Date.now().toString(36)}`;
await storage.initializeProject({ cwd, title: "Crash test", repoId, updateAgents: false });
const filler = "Planning text that compresses about as well as real specs do. ".repeat(5000);
for (let index = 0; index < 32; index += 1) {
  const revision = (await storage.loadState(cwd)).roadmap.revision;
  await storage.createCard({ cwd, title: `Card ${index}`, specMarkdown: `# Card ${index}\n\n${index} ${filler}`, baseRevision: revision });
}
const original = await storage.loadState(cwd);
const originalSpecs = await Promise.all(original.roadmap.roadmapItems.map((item) => storage.readDoc({ cwd, cardId: item.id, kind: "spec" })));
await onlineLogin(url, { devUser: "owner" });
console.log(`Transfer crash tests against ${url}, board ${repoId} (${original.roadmap.roadmapItems.length} cards)`);

await killedAt("take-online:after-part", ["online", "take-online", url, "--cwd", cwd]);
assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
ok("Take Online killed after the first part leaves the project local");

await killedAt("take-online:after-commit", ["online", "take-online", url, "--cwd", cwd]);
assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
ok("Take Online run again resumes the same upload and is killed right after it commits");

const later = await storage.createCard({ cwd, title: "Made after the upload", baseRevision: (await storage.loadState(cwd)).roadmap.revision });
const result = await takeOnline(url, cwd);
assert.deepEqual(result.unsyncedLocalChanges?.map((change) => change.summary), [`Created ${later.createdCard.title}`]);
const online = await storage.loadState(cwd);
assert.equal(online.manifest.storage?.kind, "online");
assert.deepEqual(online.roadmap.roadmapItems.map((item) => item.id), original.roadmap.roadmapItems.map((item) => item.id));
for (const [index, item] of online.roadmap.roadmapItems.entries()) {
  assert.equal((await storage.readDoc({ cwd, cardId: item.id, kind: "spec" })).markdown, originalSpecs[index]!.markdown);
}
ok("running it a third time finishes once, with every card and document, and reports the later local edit");

const edited = await storage.updateCard({ cwd, cardId: online.roadmap.roadmapItems[0]!.id, summary: "Edited online", baseRevision: online.roadmap.revision });
await killedAt("take-local:mid-download", ["online", "take-local", "--cwd", cwd]);
assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
await assert.rejects(storage.updateCard({ cwd, cardId: online.roadmap.roadmapItems[0]!.id, summary: "late", baseRevision: edited.roadmap.revision + 1 }), /read-only online/);
ok("Take Local killed mid-download leaves the board online, frozen and intact");

await killedAt("take-local:after-stage", ["online", "take-local", "--cwd", cwd]);
assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
const returned = await takeLocal(cwd);
const local = await storage.loadState(cwd);
assert.equal(local.manifest.storage?.kind, "local");
assert.equal(local.planningRoot, returned.planningRoot);
assert.equal(local.roadmap.roadmapItems[0]!.summary, "Edited online");
for (const [index, item] of local.roadmap.roadmapItems.entries()) {
  assert.equal((await storage.readDoc({ cwd, cardId: item.id, kind: "spec" })).markdown, originalSpecs[index]!.markdown);
}
const history = await storage.historyPayload(cwd);
assert.ok(history.entries.some((entry) => entry.operation === "board.take-online"));
ok("Take Local killed after writing the local copy finishes on retry with the online edit, documents and history");

await takeOnline(url, cwd);
assert.equal((await storage.loadState(cwd)).manifest.storage?.kind, "online");
ok("the board can be taken online again afterwards");
console.log(`All ${step} checks passed.`);
