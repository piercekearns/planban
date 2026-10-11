// Where attachment contents live. The rest of the service only sees this
// module's functions, so Convex file storage (used now, and for local
// development) can be replaced by Cloudflare R2 for large boards.
//
// With Convex storage, a file arrives in parts through Planban's own upload
// endpoint, which stores each part for one upload session only; nobody can
// attach bytes that were not uploaded to their own session. A blob is the
// ordered parts of one finished upload.
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";

/** Parts are small enough for an HTTP action to hold in memory. */
export const PART_BYTES = 8 * 1024 * 1024;

export async function partsOf(ctx: QueryCtx, uploadId: string) {
  return ctx.db.query("uploadParts").withIndex("by_upload_index", (q) => q.eq("uploadId", uploadId)).collect();
}

/** Removes an upload's stored parts and their records. */
export async function removeParts(ctx: MutationCtx, uploadId: string) {
  for (const part of await partsOf(ctx, uploadId)) {
    await ctx.storage.delete(part.storageId);
    await ctx.db.delete(part._id);
  }
}

/** The bytes of a blob (its parts in order), streamed. */
export function streamParts(ctx: ActionCtx, parts: Array<{ storageId: string }>, contentType: string): Response {
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const part = parts[next];
      next += 1;
      if (!part) {
        controller.close();
        return;
      }
      const blob = await ctx.storage.get(part.storageId as never);
      if (!blob) {
        controller.error(new Error("Attachment contents are missing."));
        return;
      }
      controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
    },
  });
  return new Response(body, { headers: { "Content-Type": contentType, "Cache-Control": "private, no-store" } });
}
