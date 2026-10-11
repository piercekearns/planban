// Where attachment contents live. The rest of the service only sees this
// interface, so Convex file storage (used now, and for local development)
// and Cloudflare R2 (recommended for large boards) are interchangeable.
import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../_generated/server";

export interface UploadTarget {
  url: string;
  method: "POST" | "PUT";
  headers: Record<string, string>;
}

export interface StoredBlob {
  storageKey: string;
  sha256: string;
  size: number;
  /** When the bytes were stored (ms since epoch). */
  createdAt: number;
}

export interface BlobStore {
  name: "convex" | "r2";
  /** Where the client uploads one file's bytes. */
  uploadTarget(ctx: MutationCtx, input: { sha256: string; size: number; contentType: string }): Promise<UploadTarget>;
  /** After an upload: what was actually stored, so it can be checked against the declared hash and size. */
  inspect(ctx: MutationCtx, uploadResult: string): Promise<StoredBlob | null>;
  /** The bytes, as a response to stream to the client. */
  download(ctx: ActionCtx, storageKey: string, contentType: string): Promise<Response | null>;
  remove(ctx: MutationCtx, storageKey: string): Promise<void>;
}

function base64ToHex(value: string) {
  const binary = atob(value);
  let hex = "";
  for (let index = 0; index < binary.length; index += 1) hex += binary.charCodeAt(index).toString(16).padStart(2, "0");
  return hex;
}

/** Convex file storage. The client POSTs the file to a one-hour upload URL and gets back a storage id. */
export const convexBlobStore: BlobStore = {
  name: "convex",
  async uploadTarget(ctx, input) {
    return { url: await ctx.storage.generateUploadUrl(), method: "POST", headers: { "Content-Type": input.contentType } };
  },
  async inspect(ctx, uploadResult) {
    const id = ctx.db.system.normalizeId("_storage", uploadResult);
    const file = id ? await ctx.db.system.get(id) : null;
    if (!file) return null;
    return { storageKey: file._id, sha256: base64ToHex(file.sha256), size: file.size, createdAt: file._creationTime };
  },
  async download(ctx, storageKey, contentType) {
    const blob = await ctx.storage.get(storageKey as Id<"_storage">);
    return blob ? new Response(blob, { headers: { "Content-Type": contentType, "Cache-Control": "private, no-store" } }) : null;
  },
  async remove(ctx, storageKey) {
    await ctx.storage.delete(storageKey as Id<"_storage">);
  },
};

/** The store new uploads go to. R2 replaces this once the owner chooses it and its bucket exists. */
export function activeBlobStore(): BlobStore {
  return convexBlobStore;
}

export function blobStoreNamed(name: "convex" | "r2"): BlobStore {
  if (name === "convex") return convexBlobStore;
  throw new Error("The R2 blob store is not configured yet.");
}
