// Card attachments. Contents go to the blob store (see model/blobs.ts), once
// per board per content hash; a file already stored for the board is linked
// without uploading it again. Attachments are files beside the planning
// state, so adding or removing one does not change the board's revision.
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { boardAccess } from "./model/access";
import { activeBlobStore, blobStoreNamed } from "./model/blobs";
import { fail } from "./model/errors";
import { currentRoadmap, live } from "./model/rows";

/** Matches the design note's recommendation: larger files stay local. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const fileInput = { cardId: v.string(), path: v.string(), sha256: v.string(), size: v.number(), contentType: v.string() };

function checkFile(input: { path: string; sha256: string; size: number; contentType: string }) {
  const parts = input.path.split("/");
  if (!input.path || input.path.length > 300 || input.path.startsWith("/") || parts.some((part) => !part || part === "." || part === ".." || part.includes("\\"))) {
    fail("validation", "Attachment paths are relative paths inside the card's folder.");
  }
  if (parts.length === 1 && (input.path === "spec.md" || input.path === "plan.md")) fail("validation", "spec.md and plan.md are the card's documents, not attachments.");
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

async function link(ctx: MutationCtx, access: Awaited<ReturnType<typeof writableCard>>, input: { cardId: string; path: string; sha256: string; size: number; contentType: string }) {
  const at = live(access.board);
  const existing = await ctx.db.query("attachments").withIndex("by_board_card_path", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", input.cardId).eq("path", input.path)).unique();
  const fields = { sha256: input.sha256, size: input.size, contentType: input.contentType, uploadedBy: access.connection.userId, uploadedAt: new Date().toISOString() };
  const previousSha = existing?.sha256;
  const id = existing ? (await ctx.db.patch(existing._id, fields), existing._id) : await ctx.db.insert("attachments", { ...at, cardId: input.cardId, path: input.path, ...fields });
  if (previousSha && previousSha !== input.sha256) await releaseBlob(ctx, at.boardId, previousSha);
  return { id, cardId: input.cardId, path: input.path, ...fields };
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

/** Step 1: link a file the board already has, or say where to upload it. */
export const begin = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), ...fileInput },
  handler: async (ctx, { connectionId, boardId, ...input }) => {
    checkFile(input);
    const access = await writableCard(ctx, connectionId, boardId, input.cardId);
    const stored = await ctx.db.query("blobs").withIndex("by_board_sha", (q) => q.eq("boardId", boardId).eq("sha256", input.sha256)).unique();
    if (stored) return { done: true as const, attachment: await link(ctx, access, input) };
    return { done: false as const, upload: await activeBlobStore().uploadTarget(ctx, input) };
  },
});

/** Step 2, after uploading: the stored bytes must match the declared hash and size. */
export const finish = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), uploadResult: v.string(), ...fileInput },
  handler: async (ctx, { connectionId, boardId, uploadResult, ...input }) => {
    checkFile(input);
    const access = await writableCard(ctx, connectionId, boardId, input.cardId);
    const store = activeBlobStore();
    const stored = await store.inspect(ctx, uploadResult);
    if (!stored) fail("validation", "The upload was not found. Upload the file again.");
    if (stored!.sha256 !== input.sha256 || stored!.size !== input.size) {
      await store.remove(ctx, stored!.storageKey);
      fail("validation", "The uploaded bytes do not match the declared hash and size.");
    }
    const existing = await ctx.db.query("blobs").withIndex("by_board_sha", (q) => q.eq("boardId", boardId).eq("sha256", input.sha256)).unique();
    if (existing) await store.remove(ctx, stored!.storageKey); // stored twice by racing uploads
    else await ctx.db.insert("blobs", { boardId, sha256: input.sha256, size: input.size, store: store.name, storageKey: stored!.storageKey, createdAt: new Date().toISOString() });
    return { done: true as const, attachment: await link(ctx, access, input) };
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
