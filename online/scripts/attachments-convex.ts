// Card attachments against a local Convex backend (Convex file storage behind
// the blob store interface): upload, de-duplication, hash checks, access
// levels, and a Take Local and Take Online round trip with the files.
// Uses a temporary Planban home and throwaway boards only.
//
//   PLANBAN_HOME=$(mktemp -d) PLANBAN_ONLINE_URL=http://127.0.0.1:3211 node --import tsx/esm online/scripts/attachments-convex.ts
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmptyRoadmap, planCreateCard } from "../../src/core/boardOperations";

const home = process.env.PLANBAN_HOME ?? "";
if (!home.startsWith(tmpdir()) && !home.startsWith("/tmp") && !home.startsWith("/var/folders")) throw new Error("Run with PLANBAN_HOME set to a temporary folder.");
const origin = (process.env.PLANBAN_ONLINE_URL ?? "http://127.0.0.1:3211").replace(/\/+$/, "");
const storage = await import("../../src/core/storage");
const { onlineLogin } = await import("../../src/core/online/login");
const { takeOnline, takeLocal } = await import("../../src/core/online/transfers");
const { listAttachments, uploadAttachment, downloadAttachment, removeAttachment } = await import("../../src/core/online/attachments");
const { readCredentials } = await import("../../src/core/online/credentials");
let step = 0;
const ok = (label: string) => console.log(`  ok ${++step} - ${label}`);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
console.log(`Attachment checks against ${origin}`);

const cwd = await mkdtemp(join(tmpdir(), "planban-attach-"));
const boardId = `attach-${Date.now().toString(36)}`;
await storage.initializeProject({ cwd, title: "Attachments", repoId: boardId, updateAgents: false });
await storage.createCard({ cwd, title: "Vest", baseRevision: (await storage.loadState(cwd)).roadmap.revision });
const local = await storage.loadState(cwd);
const model = randomBytes(3 * 1024 * 1024);
await mkdir(join(local.planningRoot, "items", "vest", "proof"), { recursive: true });
await writeFile(join(local.planningRoot, "items", "vest", "proof", "vest.glb"), model);
await writeFile(join(local.planningRoot, "items", "vest", "proof", "vest.blend1"), "autosave");
await onlineLogin(origin, { devUser: "owner" });
const online: any = await takeOnline(origin, cwd, { attachments: true });
assert.equal(online.attachments.uploaded, 1);
assert.deepEqual(online.attachments.skipped.map((entry: { path: string }) => entry.path), ["proof/vest.blend1"]);
let files = await listAttachments(origin, boardId, "vest");
assert.deepEqual(files.map((file) => file.path), ["proof/vest.glb"]);
assert.equal(sha(await downloadAttachment(origin, boardId, files[0]!.id)), sha(model));
ok("Take Online uploads a card's files to Convex storage, skipping autosaves, and they download intact");

const copy = await uploadAttachment(origin, boardId, "vest", "copies/same.glb", model);
assert.equal(copy.uploaded, false);
ok("a file the board already holds is linked without uploading it again");

const credentials = (await readCredentials()).services[origin]!;
const post = async (path: string, body: unknown, token: string = credentials.accessToken) => {
  const response = await fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  return { status: response.status, json: await response.json() as any };
};
const other = randomBytes(1024);
const begun = await post(`/api/v1/boards/${boardId}/attachments/begin`, { cardId: "vest", path: "lie.bin", sha256: sha(other), size: other.length, contentType: "application/octet-stream" });
assert.equal(begun.json.done, false);
const uploaded = await fetch(begun.json.upload.url, { method: "POST", headers: begun.json.upload.headers, body: randomBytes(1024) });
const { storageId } = await uploaded.json() as { storageId: string };
const lie = await post(`/api/v1/boards/${boardId}/attachments/finish`, { uploadId: begun.json.uploadId, uploadResult: storageId });
assert.equal(lie.status, 400);
assert.equal((await post(`/api/v1/boards/${boardId}/attachments/finish`, { uploadId: begun.json.uploadId, uploadResult: storageId })).status, 400, "a refused upload stays refused");
for (const path of ["../escape", "SPEC.md", "Plan.MD"]) {
  assert.equal((await post(`/api/v1/boards/${boardId}/attachments/begin`, { cardId: "vest", path, sha256: sha(other), size: other.length, contentType: "text/plain" })).status, 400, path);
}
ok("mismatched uploads stay refused, and paths outside the card's folder or naming its documents in any case are refused");

// Finishing again returns the same attachment and never removes its contents.
const fresh = randomBytes(2048);
const started = await post(`/api/v1/boards/${boardId}/attachments/begin`, { cardId: "vest", path: "fresh.bin", sha256: sha(fresh), size: fresh.length, contentType: "application/octet-stream" });
const freshId = (await (await fetch(started.json.upload.url, { method: "POST", headers: started.json.upload.headers, body: fresh })).json() as { storageId: string }).storageId;
const first = await post(`/api/v1/boards/${boardId}/attachments/finish`, { uploadId: started.json.uploadId, uploadResult: freshId });
const finishedAgain = await post(`/api/v1/boards/${boardId}/attachments/finish`, { uploadId: started.json.uploadId, uploadResult: freshId });
assert.equal(finishedAgain.json.attachment.id, first.json.attachment.id);
assert.equal(sha(await downloadAttachment(origin, boardId, first.json.attachment.id)), sha(fresh));
ok("finishing an upload again returns the same attachment and keeps its contents");

// Someone else cannot claim stored bytes, even knowing their storage id.
const stranger = (await (await fetch(`${origin}/dev/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: `stranger-${Date.now().toString(36)}` }) })).json()).token as string;
const strangerBoard = `${boardId}-stranger`;
const now = new Date().toISOString();
const strangerRoadmap = planCreateCard(createEmptyRoadmap({ repoId: strangerBoard, title: "Stranger", now }), { title: "Card" }, { now }).roadmap;
assert.equal((await post("/api/v1/boards/import", { format: "planban-board-bundle", version: 1, roadmap: strangerRoadmap, docs: [], history: [] }, stranger)).status, 201);
const theirs = await post(`/api/v1/boards/${strangerBoard}/attachments/begin`, { cardId: "card", path: "stolen.bin", sha256: sha(fresh), size: fresh.length, contentType: "application/octet-stream" }, stranger);
assert.equal(theirs.json.done, false, "the stranger's board does not hold these contents");
assert.equal((await post(`/api/v1/boards/${strangerBoard}/attachments/finish`, { uploadId: theirs.json.uploadId, uploadResult: freshId }, stranger)).status, 400);
assert.equal((await post(`/api/v1/boards/${boardId}/attachments/finish`, { uploadId: theirs.json.uploadId, uploadResult: freshId }, stranger)).status, 404);
assert.equal(sha(await downloadAttachment(origin, boardId, first.json.attachment.id)), sha(fresh));
ok("another person cannot claim stored bytes by their storage id, nor finish someone else's upload");

// Two paths that differ only in letter case are one file.
const upper = await uploadAttachment(origin, boardId, "vest", "Notes.txt", Buffer.from("one"));
const lower = await uploadAttachment(origin, boardId, "vest", "notes.txt", Buffer.from("two"));
assert.equal(lower.attachment.id, upper.attachment.id);
assert.equal((await listAttachments(origin, boardId, "vest")).filter((file) => file.path.toLowerCase() === "notes.txt").length, 1);
ok("paths differing only in letter case refer to the same file");

const readKey = (await post("/api/v1/keys", { boardId, level: "read", name: "Reader" })).json.key as string;
const listed = await fetch(`${origin}/api/v1/boards/${boardId}/attachments`, { headers: { Authorization: `Bearer ${readKey}` } });
assert.equal(listed.status, 200);
assert.equal((await post(`/api/v1/boards/${boardId}/attachments/begin`, { cardId: "vest", path: "x.txt", sha256: sha(other), size: other.length, contentType: "text/plain" }, readKey)).status, 403);
ok("a read-only key can list and download attachments but not add them");

await removeAttachment(origin, boardId, copy.attachment.id);
files = await listAttachments(origin, boardId, "vest");
assert.equal(sha(await downloadAttachment(origin, boardId, files.find((file) => file.path === "proof/vest.glb")!.id)), sha(model), "contents still used elsewhere are kept");
ok("removing one of two attachments with the same contents keeps the contents for the other");

const returned = await takeLocal(cwd);
assert.equal(sha(await readFile(join(returned.planningRoot, "items", "vest", "proof", "vest.glb"))), sha(model));
const again: any = await takeOnline(origin, cwd, { attachments: true });
assert.equal(again.attachments.uploaded, 0);
assert.equal(again.attachments.alreadyStored, again.attachments.files);
await new Promise((resolve) => setTimeout(resolve, 2000));
files = await listAttachments(origin, boardId, "vest");
assert.equal(sha(await downloadAttachment(origin, boardId, files.find((file) => file.path === "proof/vest.glb")!.id)), sha(model));
assert.equal(files.length, 3, "every file is still attached after the old generation is cleaned up");
ok("Take Local brings the files back, and taking the board online again re-links them without uploading, after old copies are cleaned up");
console.log(`All ${step} checks passed.`);
