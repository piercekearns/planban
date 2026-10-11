// Card attachments. Contents are stored once per board per content hash (see
// model/blobs.ts); a file already stored for the board is linked without
// uploading it again. Attachments are files beside the planning state, so
// adding or removing one does not change the board's revision.
//
// Upload: `begin` opens an upload session for one connection, board, card,
// path and content; the client sends the bytes in parts to Planban's own
// endpoint for that session; `finish` hashes what arrived and links it.
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { boardAccess } from "./model/access";
import { PART_BYTES, partsOf, removeParts } from "./model/blobs";
import { fail } from "./model/errors";
import { currentRoadmap, live } from "./model/rows";

/** Matches the design note's recommendation: larger files stay local. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/** Uploads not finished within this time are cancelled and their bytes removed. */
const UPLOAD_LIFETIME_MS = 2 * 60 * 60 * 1000;
const BATCH = 100;
/** Card ids become folder names on disk, so only plain ids may have files. */
const SAFE_CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const fileInput = { cardId: v.string(), path: v.string(), sha256: v.string(), size: v.number(), contentType: v.string() };

/** How a case-insensitive file system (macOS, Windows) sees a path. */
export function pathKey(path: string) {
  return path.normalize("NFC").toLowerCase();
}

export function partCount(size: number) {
  return Math.max(1, Math.ceil(size / PART_BYTES));
}

function checkFile(input: { cardId: string; path: string; sha256: string; size: number; contentType: string }) {
  if (!SAFE_CARD_ID.test(input.cardId) || input.cardId.includes("..")) fail("validation", "Files can only be attached to cards with a plain id.");
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

async function writableCard(ctx: QueryCtx, connectionId: Id<"connections">, boardId: string, cardId: string) {
  const access = await boardAccess(ctx, connectionId, boardId);
  if (access.board.authority !== "online") fail("conflict", "This board was taken back to Local Mode, so it is read-only online.");
  if (!access.canWrite) fail("forbidden", "This connection can only read this board.");
  const roadmap = await currentRoadmap(ctx, live(access.board));
  if (!roadmap.roadmapItems.some((item) => item.id === cardId)) fail("not_found", `Card not found: ${cardId}`);
  return access;
}

function describe(row: Doc<"attachments">) {
  const { _id, cardId, path, sha256, size, contentType, uploadedBy, uploadedAt } = row;
  return { id: _id, cardId, path, sha256, size, contentType, uploadedBy, uploadedAt };
}

/**
 * While files are being carried over from an earlier generation, a file at
 * the same card and path there is superseded by any change made now, so it
 * is dropped at once rather than resurfacing later.
 */
async function dropCarried(ctx: MutationCtx, board: Doc<"boards">, cardId: string, key: string) {
  if (board.carryFrom === undefined) return;
  const carried = await ctx.db.query("attachments").withIndex("by_board_card_pathKey", (q) => q.eq("boardId", board.boardId).eq("generation", board.carryFrom!).eq("cardId", cardId).eq("pathKey", key)).unique();
  if (!carried) return;
  await ctx.db.delete(carried._id);
  await releaseBlob(ctx, board.boardId, carried.sha256);
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
  await dropCarried(ctx, board, input.cardId, key);
  return describe((await ctx.db.get(id))!);
}

/** Removes a blob once no attachment of the board, in any generation, uses it. */
export async function releaseBlob(ctx: MutationCtx, boardId: string, sha256: string) {
  if (await ctx.db.query("attachments").withIndex("by_board_sha", (q) => q.eq("boardId", boardId).eq("sha256", sha256)).first()) return;
  const blob = await ctx.db.query("blobs").withIndex("by_board_sha", (q) => q.eq("boardId", boardId).eq("sha256", sha256)).unique();
  if (!blob) return;
  await removeParts(ctx, blob.storageKey);
  await ctx.db.delete(blob._id);
}

/**
 * The board's attachments: those of the live generation, plus those of an
 * earlier generation still being carried over (not yet replaced).
 */
async function visibleAttachments(ctx: QueryCtx, board: Doc<"boards">, cardId?: string) {
  const forGeneration = (generation: number) => cardId
    ? ctx.db.query("attachments").withIndex("by_board_card_path", (q) => q.eq("boardId", board.boardId).eq("generation", generation).eq("cardId", cardId)).collect()
    : ctx.db.query("attachments").withIndex("by_board_generation", (q) => q.eq("boardId", board.boardId).eq("generation", generation)).collect();
  const rows = await forGeneration(board.generation);
  if (board.carryFrom !== undefined) {
    const seen = new Set(rows.map((row) => `${row.cardId}/${row.pathKey}`));
    for (const row of await forGeneration(board.carryFrom)) if (!seen.has(`${row.cardId}/${row.pathKey}`)) rows.push(row);
  }
  return rows;
}

export const list = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), cardId: v.optional(v.string()) },
  handler: async (ctx, { connectionId, boardId, cardId }) => {
    const { board } = await boardAccess(ctx, connectionId, boardId);
    return { attachments: (await visibleAttachments(ctx, board, cardId)).map(describe) };
  },
});

/** Step 1: link a file the board already has, or open an upload session for exactly this caller and file. */
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
    return { done: false as const, uploadId, partBytes: PART_BYTES, partCount: partCount(input.size) };
  },
});

async function ownUpload(ctx: QueryCtx, connectionId: Id<"connections">, boardId: string, uploadId: string) {
  const id = ctx.db.normalizeId("uploads", uploadId);
  const upload = id ? await ctx.db.get(id) : null;
  if (!upload || upload.boardId !== boardId || upload.connectionId !== connectionId) fail("not_found", "Upload not found.");
  return upload!;
}

/** Before storing a part: the session must be this caller's, still open, and the part one it expects. */
export const partAllowed = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), uploadId: v.string(), index: v.number() },
  handler: async (ctx, { connectionId, boardId, uploadId, index }) => {
    const upload = await ownUpload(ctx, connectionId, boardId, uploadId);
    await writableCard(ctx, connectionId, boardId, upload.cardId);
    if (upload.state !== "open") fail("conflict", "This upload is no longer open.");
    const count = partCount(upload.size);
    if (!Number.isInteger(index) || index < 0 || index >= count) fail("validation", "No such part of this upload.");
    const expected = index < count - 1 ? PART_BYTES : upload.size - PART_BYTES * (count - 1);
    return { expected };
  },
});

/** Records a part stored by the upload endpoint for this session; resending a part replaces it. */
export const recordPart = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), uploadId: v.string(), index: v.number(), storageId: v.id("_storage"), size: v.number() },
  handler: async (ctx, { connectionId, boardId, uploadId, index, storageId, size }) => {
    // Access may have changed while the part was arriving: check it all again.
    const upload = await ownUpload(ctx, connectionId, boardId, uploadId)
      .then(async (found) => (await writableCard(ctx, connectionId, boardId, found.cardId), found))
      .catch((error) => error as Error);
    if (upload instanceof Error || upload.state !== "open") {
      await ctx.storage.delete(storageId);
      return { stored: false };
    }
    const previous = await ctx.db.query("uploadParts").withIndex("by_upload_index", (q) => q.eq("uploadId", uploadId).eq("index", index)).unique();
    if (previous) {
      await ctx.storage.delete(previous.storageId);
      await ctx.db.delete(previous._id);
    }
    await ctx.db.insert("uploadParts", { uploadId, index, storageId, size });
    return { stored: true };
  },
});

/** For `finish`: this caller's upload and the parts that arrived, to be hashed. */
export const partsToVerify = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), uploadId: v.string() },
  handler: async (ctx, { connectionId, boardId, uploadId }) => {
    const upload = await ownUpload(ctx, connectionId, boardId, uploadId);
    await boardAccess(ctx, connectionId, boardId);
    return { state: upload.state, parts: (await partsOf(ctx, uploadId)).map(({ _id, index, storageId, size }) => ({ id: _id, index, storageId, size })) };
  },
});

/**
 * Step 2: link the upload once its parts, hashed by the finish endpoint,
 * match the declared hash and size. Finishing again returns the same
 * attachment. A mismatch removes the parts and reports the refusal without
 * undoing that removal.
 */
export const complete = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), uploadId: v.string(), sha256: v.string(), size: v.number(), partIds: v.array(v.id("uploadParts")) },
  handler: async (ctx, { connectionId, boardId, uploadId, sha256, size, partIds }) => {
    const upload = await ownUpload(ctx, connectionId, boardId, uploadId);
    if (upload.state === "finished") {
      await boardAccess(ctx, connectionId, boardId);
      const attachment = upload.attachmentId ? await ctx.db.get(upload.attachmentId as Id<"attachments">) : null;
      if (attachment) return { done: true as const, attachment: describe(attachment) };
      fail("conflict", "This upload finished, but its attachment has since been removed.");
    }
    if (upload.state === "rejected") fail("validation", "This upload was refused. Start it again.");
    const access = await writableCard(ctx, connectionId, boardId, upload.cardId);
    // The parts hashed must be exactly the parts stored now.
    const parts = await partsOf(ctx, uploadId);
    if (parts.length !== partCount(upload.size) || parts.some((part, index) => part.index !== index || part._id !== partIds[index]) || partIds.length !== parts.length) {
      fail("conflict", "The upload's parts changed while it was being checked, or some are missing. Send them again.");
    }
    if (sha256 !== upload.sha256 || size !== upload.size) {
      await removeParts(ctx, uploadId);
      await ctx.db.patch(upload._id, { state: "rejected" });
      return { done: false as const, rejected: "The uploaded bytes do not match the declared hash and size." };
    }
    const existing = await ctx.db.query("blobs").withIndex("by_board_sha", (q) => q.eq("boardId", boardId).eq("sha256", upload.sha256)).unique();
    if (existing) await removeParts(ctx, uploadId); // the same contents arrived twice; keep the first
    else await ctx.db.insert("blobs", { boardId, sha256: upload.sha256, size: upload.size, store: "convex", storageKey: uploadId, createdAt: new Date().toISOString() });
    const attachment = await link(ctx, access.board, access.connection.userId, upload);
    await ctx.db.patch(upload._id, { state: "finished", attachmentId: attachment.id });
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
    const visible = row && row.boardId === boardId && (row.generation === access.board.generation || row.generation === access.board.carryFrom);
    if (!visible) fail("not_found", "Attachment not found.");
    await ctx.db.delete(row!._id);
    await releaseBlob(ctx, boardId, row!.sha256);
    // Removing a file removes it in every generation, so an older copy never reappears.
    await dropCarried(ctx, access.board, row!.cardId, row!.pathKey);
    return { removed: true };
  },
});

/** For streaming a download: the parts behind an attachment the caller may read. */
export const locate = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), attachmentId: v.string() },
  handler: async (ctx, { connectionId, boardId, attachmentId }) => {
    const { board } = await boardAccess(ctx, connectionId, boardId);
    const id = ctx.db.normalizeId("attachments", attachmentId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row || row.boardId !== boardId || (row.generation !== board.generation && row.generation !== board.carryFrom)) fail("not_found", "Attachment not found.");
    const blob = await ctx.db.query("blobs").withIndex("by_board_sha", (q) => q.eq("boardId", boardId).eq("sha256", row!.sha256)).unique();
    if (!blob) fail("not_found", "Attachment contents are missing.");
    return { contentType: row!.contentType, parts: (await partsOf(ctx, blob!.storageKey)).map(({ storageId }) => ({ storageId })) };
  },
});

/**
 * After a board is taken online again, its files move to the new generation
 * in batches (for cards that still exist and paths not already re-linked);
 * the rest are removed and their contents released when unused. Runs as part
 * of cleaning up the previous generation, so there is no limit on file count.
 * While it runs, the board cannot be frozen for Take Local.
 */
export async function carryOrReleaseAttachments(ctx: MutationCtx, boardId: string, generation: number): Promise<number> {
  const rows = await ctx.db.query("attachments").withIndex("by_board_generation", (q) => q.eq("boardId", boardId).eq("generation", generation)).take(BATCH);
  const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", boardId)).unique();
  if (rows.length === 0) {
    if (board?.carryFrom === generation) await ctx.db.patch(board._id, { carryFrom: undefined });
    return 0;
  }
  const carrying = board && board.carryFrom === generation && board.generation !== generation;
  const liveCards = carrying ? new Set((await currentRoadmap(ctx, live(board))).roadmapItems.map((item) => item.id)) : new Set<string>();
  for (const row of rows) {
    const taken = carrying && await ctx.db.query("attachments").withIndex("by_board_card_pathKey", (q) => q.eq("boardId", boardId).eq("generation", board!.generation).eq("cardId", row.cardId).eq("pathKey", row.pathKey)).first();
    if (carrying && liveCards.has(row.cardId) && !taken) {
      await ctx.db.patch(row._id, { generation: board!.generation });
    } else {
      await ctx.db.delete(row._id);
      await releaseBlob(ctx, boardId, row.sha256);
    }
  }
  return rows.length;
}

/** Removes uploads nobody finished, with their stored parts. */
export const sweepUploads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = new Date(Date.now() - UPLOAD_LIFETIME_MS).toISOString();
    for (const state of ["open", "rejected", "finished"] as const) {
      for (const upload of await ctx.db.query("uploads").withIndex("by_state_created", (q) => q.eq("state", state).lt("createdAt", cutoff)).take(BATCH)) {
        // A finished upload's parts are its blob's contents; only the session record goes.
        if (state !== "finished") await removeParts(ctx, upload._id);
        await ctx.db.delete(upload._id);
      }
    }
    // Bytes stored by the upload endpoint whose part was never recorded (the
    // request died in between) belong to nothing; the scan walks all stored
    // files a page at a time, remembering where it got to.
    const counter = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", "storage-sweep")).unique();
    const after = counter?.value ?? 0;
    const files = await ctx.db.system.query("_storage").withIndex("by_creation_time", (q) => q.gt("_creationTime", after)).take(BATCH);
    let reached = after;
    for (const file of files) {
      if (file._creationTime > Date.parse(cutoff)) break;
      reached = file._creationTime;
      if (await ctx.db.query("uploadParts").withIndex("by_storageId", (q) => q.eq("storageId", file._id)).first()) continue;
      await ctx.storage.delete(file._id);
    }
    const next = files.length < BATCH ? 0 : reached;
    if (counter) await ctx.db.patch(counter._id, { value: next });
    else await ctx.db.insert("counters", { name: "storage-sweep", value: next });
  },
});
