// Planban is an index, not storage (owner decisions 18 and 20). A board, local
// or online, holds only its own text: cards, Specs, Plans and their history.
// Files stay where they live, and a card refers to them. These rules are shared
// by every write path into a board (local MCP, the CLI and the web board's API
// in Local Mode; the hosted API, remote MCP and Take Online for Online Boards),
// so no route can turn a board into file storage.
import { PlanbanValidationError } from "./boardOperations";

/** Larger than any real Spec or Plan seen so far (the largest is about 0.5 MB). */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
/** All of one card's own fields together (the largest seen is about 48 KB). */
export const MAX_CARD_BYTES = 128 * 1024;

/** How to point at a file instead of embedding it; shown in errors, tool descriptions and the protocol. */
export const HOW_TO_REFER = "Refer to files where they live instead: a GitHub link, any web address, or a local path labelled with its machine, for example \"Mac mini: ~/Projects/northfold/renders/front.png\".";

export const INDEX_NOT_STORAGE = `Planban boards hold text only: cards, Specs, Plans and their history. Planban does not store files. ${HOW_TO_REFER}`;

/**
 * A data: address carrying a payload. A short one is an example in prose or
 * code (`data:image/png;base64,AAAA`); a real file needs far more than this.
 */
const DATA_URI = /data:[^\s,]{0,100},([^\s)"'<>\]]*)/gi;
const DATA_PAYLOAD_LIMIT = 256;
/** Long unbroken runs of base64, base64url or hex are files, not prose. */
const ENCODED_RUN = /[A-Za-z0-9+/]{2048,}={0,2}|[A-Za-z0-9_-]{4096,}|[0-9a-fA-F]{4096,}/;
/** Lines of nothing but base64 (as encoders wrap it), counted together. */
const ENCODED_LINE = /^[\s>]*[A-Za-z0-9+/]{32,}={0,2}\s*$/;
const ENCODED_BLOCK_LIMIT = 2048;
/** Control characters other than tab, newline and carriage return mean binary content. */
const BINARY = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** What kind of embedded file a piece of text contains, if any. */
export function embeddedFileIn(text: string): string | null {
  if (BINARY.test(text)) return "binary content";
  for (const match of text.matchAll(DATA_URI)) {
    if (match[1]!.length > DATA_PAYLOAD_LIMIT) return "an embedded file (a data: address)";
  }
  if (ENCODED_RUN.test(text)) return "an encoded file (a long run of base64)";
  let block = 0;
  for (const line of text.split(/\r?\n/)) {
    if (ENCODED_LINE.test(line)) {
      block += line.trim().length;
      if (block > ENCODED_BLOCK_LIMIT) return "an encoded file (lines of base64)";
    } else {
      block = 0;
    }
  }
  return null;
}

/** Text with every embedded file replaced by `placeholder` (for history, which cannot be edited). */
export function withoutEmbeddedFiles(text: string, placeholder: string): string {
  if (!embeddedFileIn(text)) return text;
  const lines = text
    .replace(BINARY_ALL, "")
    .replace(DATA_URI, (whole, payload: string) => payload.length > DATA_PAYLOAD_LIMIT ? placeholder : whole)
    .replace(ENCODED_RUN_ALL, placeholder)
    .split(/\r?\n/);
  // Wrapped base64: runs of encoded lines become one placeholder.
  const out: string[] = [];
  let block: string[] = [];
  const flush = () => {
    if (block.join("").length > ENCODED_BLOCK_LIMIT) out.push(placeholder);
    else out.push(...block);
    block = [];
  };
  for (const line of lines) {
    if (ENCODED_LINE.test(line)) block.push(line);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out.join("\n");
}
const BINARY_ALL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ENCODED_RUN_ALL = new RegExp(ENCODED_RUN.source, "g");

/** Numbers standing in for bytes: a long array of small whole numbers. */
const BYTES_ARRAY_LIMIT = 1024;

/**
 * Checks any structured value bound for an Online Board (card fields,
 * metadata, project details, history entries): every string for embedded
 * files, long number arrays for bytes, and the whole for size.
 */
export function checkIndexValue(value: unknown, where: string, maxBytes: number) {
  const visit = (entry: unknown) => {
    if (typeof entry === "string") {
      const found = embeddedFileIn(entry);
      if (found) throw new PlanbanValidationError(`Not saved: ${where} contains ${found}. ${INDEX_NOT_STORAGE}`);
    } else if (Array.isArray(entry)) {
      if (entry.length > BYTES_ARRAY_LIMIT && entry.every((item) => typeof item === "number")) {
        throw new PlanbanValidationError(`Not saved: ${where} contains a long list of numbers, which is how files are smuggled in. ${INDEX_NOT_STORAGE}`);
      }
      for (const item of entry) visit(item);
    } else if (entry && typeof entry === "object") {
      for (const item of Object.values(entry)) visit(item);
    }
  };
  visit(value);
  const bytes = new TextEncoder().encode(JSON.stringify(value) ?? "").length;
  if (bytes > maxBytes) {
    throw new PlanbanValidationError(`Not saved: ${where} is ${Math.ceil(bytes / 1024)} KB; the limit is ${Math.floor(maxBytes / 1024)} KB. Keep long material where it lives and link to it. ${HOW_TO_REFER}`);
  }
}

/** Refuses text that embeds a file or is too large for an index. `where` names it for the person, e.g. "the Spec of card x". */
export function checkIndexText(text: string, where: string, maxBytes: number) {
  const found = embeddedFileIn(text);
  if (found) throw new PlanbanValidationError(`Not saved: ${where} contains ${found}. ${INDEX_NOT_STORAGE}`);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > maxBytes) {
    throw new PlanbanValidationError(`Not saved: ${where} is ${Math.ceil(bytes / 1024)} KB; the limit is ${Math.floor(maxBytes / 1024)} KB. Keep long material where it lives and link to it. ${HOW_TO_REFER}`);
  }
}

export function checkIndexDocument(markdown: string, cardId: string, kind: string) {
  checkIndexText(markdown, `the ${kind === "plan" ? "Plan" : "Spec"} of card ${cardId}`, MAX_DOCUMENT_BYTES);
}

/** Checks one card's own fields (title, summary, notes, metadata and the rest). */
export function checkIndexCard(card: { id: string }) {
  checkIndexValue(card, `card ${card.id}`, MAX_CARD_BYTES);
}

/** Board details (title, description, tags), a history entry or settings: small text only. */
export const MAX_DETAILS_BYTES = 64 * 1024;
