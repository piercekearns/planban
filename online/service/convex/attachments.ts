// Card attachments. Contents go to the blob store (see model/blobs.ts), once
// per board per content hash; a file already stored for the board is linked
// without uploading it again. Attachments are files beside the planning
// state, so adding or removing one does not change the board's revision.
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { boardAccess } from "./model/access";
import { activeBlobStore, blobStoreNamed } from "./model/blobs";
import { fail } from "./model/errors";
import { currentRoadmap, live } from "./model/rows";

/** Matches the design note's recommendation: larger files stay local. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/** Uploads not finished within this time are cancelled and their bytes removed. */
const UPLOAD_LIFETIME_MS = 2 * 60 * 60 * 1000;
const BATCH = 100;

const fileInput = { cardId: v.string(), path: v.string(), sha256: v.string(), size: v.number(), contentType: v.string() };

/** How a case-insensitive file system (macOS, Windows) sees a path. */
export function pathKey(path: string) {
  return path.normalize("NFC").toLowerCase();
}

function checkFile(input: { path: string; sha256: string; size: number; contentType: string }) {
  const parts = input.path.split("/");
  if (!input.path || input.path.length > 300 || input.path.startsWith("/") || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes(":"))) {
    fail("validation", "Attachment paths are relative paths inside the card's folder.");
  }
  // spec.md and plan.md are the card's documents, in any letter case.
  if (parts.length === 1 && ["spec.md", "plan.md"].includes(pathKey(input.path))) fail("validation", "spec.md and plan.md are the card's documents, not attachments.");
  if (!/^[a-f0-9]{64}$/.test(input.sha256)) fail("validation", "sha256 must be the file's SHA-256 in hex.");
  if (!Number.isInteger(input.size) || input.size < 0 || input.size > MAX_ATTACHMENT_BYTES) fail("validation", `Attachments are at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(input.contentType)) fail("validation", "contentType must be a media type such as image/png.");
}

async function writableCard(ctx: MutationCtx, connectionId: Parameters<typeof boardAccess>[1], boardId: string, cardId: string) {
  const access = await boardAccess(ctx, connectionId, boardId);
  if (access.board.authority !== "online") fail("conflict", "This board was taken back to Local Mode, so it is read-only online.");
  if (!access.canWrite) fail("forbidden", "This connection can only read this board.");
  const roadmap = await currentRoadmap(ctx, live(access.board));
  if (!roadmap.roadmapItems.some((item) => item.id === cardId)) fail("not_found", `Card not found: ${cardId}`);
  return access;
}

/** Points a path at stored contents, replacing the file already at that path (in any letter case). */
async function link(ctx: MutationCtx, board: Doc<"boards">, userId: string, input: { cardId: string; path: string; sha256: string; size: number; contentType: string }) {
  const at = live(board);
  const key = pathKey(input.path);
  const existing = await ctx.db.query("attachments").withIndex("by_board_card_pathKey", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", input.cardId).eq("pathKey", key)).unique();
  const fields = { path: input.path, pathKey: key, sha256: input.sha256, size: input.size, contentType: input.contentType, uploadedBy: userId, uploadedAt: new Date().toISOString() };
  const previousSha = existing?.sha256;
  let id: Id<"attachments">;
  if (existing) {
    await ctx.db.patch(existing._id, fields);
    id = existing._id;
  } else {
    id = await ctx.db.insert("attachments", { ...at, cardId: input.cardId, ...fields });
  }
  if (previousSha && previousSha !== input.sha256) await releaseBlob(ctx, at.boardId, previousSha);
  return { id, cardId: input.cardId, ...fields };
}

/** Removes a blob once no attachment of the board, in any generation, uses it. */
export async function releaseBlob(ctx: MutationCtx, boardId: string, sha256: string) {
  if (await ctx.db.query("attachments").withIndex("by_board_sha", (q) => q.eq("boardId", boardId).eq("sha256", sha256)).first()) return;
  const blob = await ctx.db.query("blobs").withIndex("by_board_sha", (q) => q.eq("boardId", boardId).eq("sha256", sha256)).unique();
  if (!blob) return;
  await blobStoreNamed(blob.store).remove(ctx, blob.storageKey);
  await ctx.db.delete(blob._id);
}

export const list = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), cardId: v.optional(v.string()) },
  handler: async (ctx, { connectionId, boardId, cardId }) => {
    const { board } = await boardAccess(ctx, connectionId, boardId);
    const rows = cardId
      ? await ctx.db.query("attachments").withIndex("by_board_card_path", (q) => q.eq("boardId", boardId).eq("generation", board.generation).eq("cardId", cardId)).collect()
      : await ctx.db.query("attachments").withIndex("by_board_generation", (q) => q.eq("boardId", boardId).eq("generation", board.generation)).collect();
    return { attachments: rows.map(({ _id, cardId: card, path, sha256, size, contentType, uploadedBy, uploadedAt }) => ({ id: _id, cardId: card, path, sha256, size, contentType, uploadedBy, uploadedAt })) };
  },
});

/**
 * Step 1: link a file the board already has, or open an upload for exactly
 * this caller, board, card, path and content, and say where to send the bytes.
 */
export const begin = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), ...fileInput },
  handler: async (ctx, { connectionId, boardId, ...input }) => {
    checkFile(input);
    const access = await writableCard(ctx, connectionId, boardId, input.cardId);
    const stored = await ctx.db.query("blobs").withIndex("by_board_sha", (q) => q.eq("boardId", boardId).eq("sha256", input.sha256)).unique();
    if (stored) return { done: true as const, attachment: await link(ctx, access.board, access.connection.userId, input) };
    const uploadId = await ctx.db.insert("uploads", {
      boardId, userId: access.connection.userId, connectionId, ...input, state: "open", createdAt: new Date().toISOString(),
    });
    return { done: false as const, uploadId, upload: await activeBlobStore().uploadTarget(ctx, input) };
  },
});

/**
 * Step 2, after sending the bytes. Only the upload's own caller can finish
 * it; the stored bytes must be new (stored after the upload began, used by
 * nothing yet) and match the declared hash and size. Finishing again returns
 * the same attachment. A mismatch removes the bytes and reports the refusal
 * without undoing that removal.
 */
export const finish = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), uploadId: v.string(), uploadResult: v.string() },
  handler: async (ctx, { connectionId, boardId, uploadId, uploadResult }) => {
    const id = ctx.db.normalizeId("uploads", uploadId);
    const upload = id ? await ctx.db.get(id) : null;
    if (!upload || upload.boardId !== boardId || upload.connectionId !== connectionId) fail("not_found", "Upload not found.");
    if (upload!.state === "finished") {
      const attachment = upload!.attachmentId ? await ctx.db.get(upload!.attachmentId as Id<"attachments">) : null;
      if (attachment) return { done: true as const, attachment: { id: attachment._id, cardId: attachment.cardId, path: attachment.path, sha256: attachment.sha256, size: attachment.size, contentType: attachment.contentType, uploadedBy: attachment.uploadedBy, uploadedAt: attachment.uploadedAt } };
      fail("conflict", "This upload finished, but its attachment has since been removed.");
    }
    if (upload!.state === "rejected") fail("validation", "This upload was refused. Start it again.");
    const access = await writableCard(ctx, connectionId, boardId, upload!.cardId);
    const store = activeBlobStore();
    const stored = await store.inspect(ctx, uploadResult);
    // Bytes already in use, or stored before this upload began, belong to someone else.
    const claimed = stored && await ctx.db.query("blobs").withIndex("by_storageKey", (q) => q.eq("storageKey", stored.storageKey)).first();
    if (!stored || claimed || stored.createdAt < Date.parse(upload!.createdAt)) fail("validation", "The upload was not found. Upload the file again.");
    if (stored!.sha256 !== upload!.sha256 || stored!.size !== upload!.size) {
      await store.remove(ctx, stored!.storageKey);
      await ctx.db.patch(upload!._id, { state: "rejected" });
      return { done: false as const, rejected: "The uploaded bytes do not match the declared hash and size." };
    }
    const existing = await ctx.db.query("blobs").withIndex("by_board_sha", (q) => q.eq("boardId", boardId).eq("sha256", upload!.sha256)).unique();
    if (existing) await store.remove(ctx, stored!.storageKey); // the same contents arrived twice; keep the first
    else await ctx.db.insert("blobs", { boardId, sha256: upload!.sha256, size: upload!.size, store: store.name, storageKey: stored!.storageKey, createdAt: new Date().toISOString() });
    const attachment = await link(ctx, access.board, access.connection.userId, upload!);
    await ctx.db.patch(upload!._id, { state: "finished", attachmentId: attachment.id });
    return { done: true as const, attachment };
  },
});

export const remove = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), attachmentId: v.string() },
  handler: async (ctx, { connectionId, boardId, attachmentId }) => {
    const access = await boardAccess(ctx, connectionId, boardId);
    if (access.board.authority !== "online") fail("conflict", "This board was taken back to Local Mode, so it is read-only online.");
    if (!access.canWrite) fail("forbidden", "This connection can only read this board.");
    const id = ctx.db.normalizeId("attachments", attachmentId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.boardId !== boardId || row.generation !== access.board.generation) fail("not_found", "Attachment not found.");
    await ctx.db.delete(row!._id);
    await releaseBlob(ctx, boardId, row!.sha256);
    return { removed: true };
  },
});

/** For streaming a download: the blob behind an attachment the caller may read. */
export const locate = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), attachmentId: v.string() },
  handler: async (ctx, { connectionId, boardId, attachmentId }) => {
    const { board } = await boardAccess(ctx, connectionId, boardId);
    const id = ctx.db.normalizeId("attachments", attachmentId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.boardId !== boardId || row.generation !== board.generation) fail("not_found", "Attachment not found.");
    const blob = await ctx.db.query("blobs").withIndex("by_board_sha", (q) => q.eq("boardId", boardId).eq("sha256", row!.sha256)).unique();
    if (!blob) fail("not_found", "Attachment contents are missing.");
    return { store: blob!.store, storageKey: blob!.storageKey, contentType: row!.contentType, path: row!.path };
  },
});

/**
 * After a board is taken online again, its files move to the new generation
 * in batches (for cards that still exist and paths not already re-linked);
 * the rest are removed and their contents released when unused. Runs as part
 * of cleaning up the previous generation, so there is no limit on file count.
 */
export async function carryOrReleaseAttachments(ctx: MutationCtx, boardId: string, generation: number): Promise<number> {
  const rows = await ctx.db.query("attachments").withIndex("by_board_generation", (q) => q.eq("boardId", boardId).eq("generation", generation)).take(BATCH);
  if (rows.length === 0) return 0;
  const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", boardId)).unique();
  const liveCards = board && board.authority === "online" && board.generation !== generation
    ? new Set((await currentRoadmap(ctx, live(board))).roadmapItems.map((item) => item.id))
    : new Set<string>();
  for (const row of rows) {
    const taken = board && await ctx.db.query("attachments").withIndex("by_board_card_pathKey", (q) => q.eq("boardId", boardId).eq("generation", board.generation).eq("cardId", row.cardId).eq("pathKey", row.pathKey)).first();
    if (board && liveCards.has(row.cardId) && !taken) {
      await ctx.db.patch(row._id, { generation: board.generation });
    } else {
      await ctx.db.delete(row._id);
      await releaseBlob(ctx, boardId, row.sha256);
    }
  }
  return rows.length;
}

/** Removes bytes nobody finished linking: rejected uploads, abandoned uploads, stray storage. */
export const sweepUploads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = new Date(Date.now() - UPLOAD_LIFETIME_MS).toISOString();
    for (const state of ["open", "rejected", "finished"] as const) {
      for (const upload of await ctx.db.query("uploads").withIndex("by_state_created", (q) => q.eq("state", state).lt("createdAt", cutoff)).take(BATCH)) {
        await ctx.db.delete(upload._id);
      }
    }
    // Stored bytes older than an upload's lifetime that no blob refers to were
    // never finished. The scan walks all stored files a page at a time,
    // remembering where it got to.
    const counter = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "storage-sweep")).unique();
    const after = counter?.value ?? 0;
    const files = await ctx.db.system.query("_storage").withIndex("by_creation_time", (q) => q.gt("_creationTime", after)).take(500);
    let removed = 0;
    let reached = after;
    for (const file of files) {
      if (file._creationTime > Date.parse(cutoff)) break;
      reached = file._creationTime;
      if (await ctx.db.query("blobs").withIndex("by_storageKey", (q) => q.eq("storageKey", file._id)).first()) continue;
      await ctx.storage.delete(file._id);
      removed += 1;
    }
    // A short page means the end was reached: start from the beginning next time.
    const next = files.length < 500 ? 0 : reached;
    if (counter) await ctx.db.patch(counter._id, { value: next });
    else await ctx.db.insert("counters", { name: "storage-sweep", value: next });
    return { removed };
  },
});
