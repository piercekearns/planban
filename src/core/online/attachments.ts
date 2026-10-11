// Card attachments on Online Boards: files beside a card's Spec and Plan
// (images, models, exports). Uploads are content-addressed, so a file the
// board already holds is linked without sending it again, and re-running an
// upload is safe.
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, sep } from "node:path";
import { PlanbanValidationError } from "../boardOperations";
import { isPathInsideRoot } from "../paths";
import { boardPath, onlineRequest, putBytes, requestBytes } from "./client";

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const SAFE_CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Files left behind by Take Online's attachment upload (design note recommendation). */
const SKIPPED_NAMES = new Set([".DS_Store", "Thumbs.db"]);
const SKIPPED_DIRS = new Set(["__pycache__", "node_modules", ".git", ".cache", "cache", "tmp"]);
const SKIPPED_EXTENSIONS = new Set([".blend1", ".log", ".tmp", ".swp"]);

const TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".html": "text/html", ".py": "text/x-python", ".zip": "application/zip",
};

export interface AttachmentRecord {
  id: string;
  cardId: string;
  path: string;
  sha256: string;
  size: number;
  contentType: string;
  uploadedBy: string;
  uploadedAt: string;
}

export function contentTypeFor(path: string) {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export async function listAttachments(url: string, boardId: string, cardId?: string) {
  const query = cardId ? `?cardId=${encodeURIComponent(cardId)}` : "";
  return (await onlineRequest<{ attachments: AttachmentRecord[] }>(url, boardPath(boardId, `/attachments${query}`))).attachments;
}

/** Uploads one file as `path` in a card's folder, replacing any file already there. */
export async function uploadAttachment(url: string, boardId: string, cardId: string, path: string, bytes: Uint8Array, contentType = contentTypeFor(path)) {
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new PlanbanValidationError(`Attachments are at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB: ${path}`);
  const file = { cardId, path, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength, contentType };
  const begun = await onlineRequest<{ done: boolean; attachment?: AttachmentRecord; uploadId?: string; partBytes?: number; partCount?: number }>(
    url, boardPath(boardId, "/attachments/begin"), file);
  if (begun.done) return { attachment: begun.attachment!, uploaded: false };
  // The bytes go in parts to Planban's own endpoint for this upload only.
  for (let index = 0; index < begun.partCount!; index += 1) {
    const part = bytes.subarray(index * begun.partBytes!, (index + 1) * begun.partBytes!);
    await putBytes(url, boardPath(boardId, `/attachments/uploads/${encodeURIComponent(begun.uploadId!)}/parts/${index}`), part);
  }
  const finished = await onlineRequest<{ attachment: AttachmentRecord }>(url, boardPath(boardId, "/attachments/finish"), { uploadId: begun.uploadId });
  return { attachment: finished.attachment, uploaded: true };
}

export async function downloadAttachment(url: string, boardId: string, attachmentId: string): Promise<Uint8Array> {
  return requestBytes(url, boardPath(boardId, `/attachments/${encodeURIComponent(attachmentId)}`));
}

export async function removeAttachment(url: string, boardId: string, attachmentId: string) {
  return onlineRequest(url, boardPath(boardId, `/attachments/${encodeURIComponent(attachmentId)}/delete`), {});
}

/** The files Take Online would upload from a local board's card folders, and what it would leave. */
export async function localAttachments(planningRoot: string, cardIds: Iterable<string>) {
  const files: Array<{ cardId: string; path: string; absolute: string; size: number }> = [];
  const skipped: Array<{ cardId: string; path: string; reason: string }> = [];
  for (const cardId of cardIds) {
    // Only plain card ids name folders; anything else could point outside the board.
    if (!SAFE_CARD_ID.test(cardId) || cardId.includes("..")) continue;
    const folder = join(planningRoot, "items", cardId);
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const absolute = join(dir, entry.name);
        const path = relative(folder, absolute).split(sep).join("/");
        if (entry.isDirectory()) {
          if (SKIPPED_DIRS.has(entry.name)) skipped.push({ cardId, path, reason: "cache folder" });
          else await walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        if (dir === folder && (entry.name === "spec.md" || entry.name === "plan.md")) continue;
        if (SKIPPED_NAMES.has(entry.name) || SKIPPED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
          skipped.push({ cardId, path, reason: "autosave, log or system file" });
          continue;
        }
        const size = (await stat(absolute)).size;
        if (size > MAX_ATTACHMENT_BYTES) skipped.push({ cardId, path, reason: "over 100 MB" });
        else files.push({ cardId, path, absolute, size });
      }
    };
    await walk(folder);
  }
  return { files, skipped };
}

/** Uploads a local board's card files to its Online Board. Safe to repeat. */
export async function uploadLocalAttachments(url: string, boardId: string, planningRoot: string, cardIds: Iterable<string>) {
  const { files, skipped } = await localAttachments(planningRoot, cardIds);
  let uploaded = 0;
  let linked = 0;
  let bytes = 0;
  for (const file of files) {
    const result = await uploadAttachment(url, boardId, file.cardId, file.path, await readFile(file.absolute));
    if (result.uploaded) {
      uploaded += 1;
      bytes += file.size;
    } else {
      linked += 1;
    }
  }
  return { files: files.length, uploaded, alreadyStored: linked, uploadedBytes: bytes, skipped };
}

/** Downloads every attachment of an Online Board into a local planning folder. */
export async function downloadAttachments(url: string, boardId: string, planningRoot: string) {
  const attachments = await listAttachments(url, boardId);
  const written = new Set<string>();
  const items = join(planningRoot, "items");
  for (const attachment of attachments) {
    if (!SAFE_CARD_ID.test(attachment.cardId) || attachment.cardId.includes("..")) throw new PlanbanValidationError(`Unsafe card id for an attachment: ${attachment.cardId}`);
    const folder = join(items, attachment.cardId);
    if (!isPathInsideRoot(items, folder)) throw new PlanbanValidationError(`Unsafe card id for an attachment: ${attachment.cardId}`);
    const destination = join(folder, ...attachment.path.split("/"));
    const key = relative(planningRoot, destination).normalize("NFC").toLowerCase();
    // Never let a file replace a card's documents or another file, in any letter case.
    if (!isPathInsideRoot(folder, destination) || ["spec.md", "plan.md"].includes(attachment.path.normalize("NFC").toLowerCase())
      || written.has(key) || await stat(destination).then(() => true, () => false)) {
      throw new PlanbanValidationError(`Attachment ${attachment.cardId}/${attachment.path} would overwrite another file in the local copy.`);
    }
    written.add(key);
    const bytes = await downloadAttachment(url, boardId, attachment.id);
    if (createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) throw new Error(`Attachment ${attachment.path} did not download intact.`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  return attachments.length;
}
