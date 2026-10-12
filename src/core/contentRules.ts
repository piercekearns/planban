// Planban is an index, not storage (owner decisions 18 and 20). A board holds
// only its own text: cards, Specs, Plans and their history. Files stay where
// they live, and a card refers to them. These rules are shared by every write
// path into an Online Board (the hosted API, remote and local MCP, Take
// Online), so no route can turn a board into file storage; strict Local Mode
// can use the same rules.
import { PlanbanValidationError } from "./boardOperations";

/** Larger than any real Spec or Plan seen so far (the largest is about 0.5 MB). */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
/** All of one card's own fields together (the largest seen is about 48 KB). */
export const MAX_CARD_BYTES = 128 * 1024;
/** Board details (title, description, columns), a history entry or settings: small text only. */
export const MAX_DETAILS_BYTES = 64 * 1024;

/** How to point at a file instead of embedding it; shown in errors, tool descriptions and the protocol. */
export const HOW_TO_REFER = "Refer to files where they live instead: a GitHub link, any web address, or a local path labelled with its machine, for example \"Mac mini: ~/Projects/northfold/renders/front.png\".";

export const INDEX_NOT_STORAGE = `Online Boards hold text only: cards, Specs, Plans and their history. Planban does not store files. ${HOW_TO_REFER}`;

/** A data: address and its payload. */
const DATA_URI = /data:[^\s,]{0,100},([^\s)"'<>\]]*)/gi;
/**
 * All data: payloads in one value together. A short example in prose or code
 * (`data:image/png;base64,AAAA`) is fine; a file needs far more, even split
 * into many short pieces.
 */
const DATA_PAYLOAD_LIMIT = 256;
/** Web addresses are references, whatever their query strings hold (up to 8 KB each). */
const WEB_ADDRESS = /\bhttps?:\/\/[^\s<>()"'`]{1,8192}/gi;
/**
 * Runs that could be base64, counted across the whole value when they look
 * random (upper and lower case and digits), unlike slugs, ids, hashes and
 * words. Wrapped, split or interleaved with prose, a file still adds up.
 */
const ENCODED_TOKEN = /[A-Za-z0-9+/=_-]{40,}/g;
const ENCODED_LIMIT = 2048;
/**
 * Base64 of a real file mixes upper case, lower case and digits throughout
 * (about 40%, 40% and 15%). Paths, ids, UUIDs, hashes and CamelCase names do
 * not: they are mostly one case, or have no digits.
 */
function looksEncoded(token: string) {
  const upper = token.replace(/[^A-Z]/g, "").length / token.length;
  const lower = token.replace(/[^a-z]/g, "").length / token.length;
  const digits = token.replace(/[^0-9]/g, "").length / token.length;
  return upper >= 0.15 && lower >= 0.15 && digits >= 0.05;
}
/** Any payload, however plain, as one unbroken run of base64. */
const ENCODED_RUN = /[A-Za-z0-9+/]{2048,}={0,2}/;
/** Or as encoders wrap it: whole lines of nothing but base64, added up block by block. */
const ENCODED_LINE_SHAPE = /^[\s>]*[A-Za-z0-9+/]{60,}={0,2}\s*$/;
/** A column of hex hashes is never mistaken for wrapped base64. */
const isEncodedLine = (line: string) => ENCODED_LINE_SHAPE.test(line) && /[g-zG-Z+/]/.test(line);
/** A hex dump; lists of hashes are fine. */
const HEX_RUN = /[0-9a-fA-F]{4096,}/;
/** Control characters other than tab, newline and carriage return mean binary content. */
const BINARY = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

interface Payload {
  binary: boolean;
  data: number;
  encoded: number;
  /** A plain payload: an unbroken run, or a block of wrapped lines. */
  run: boolean;
  hex: boolean;
}

const nothing = (): Payload => ({ binary: false, data: 0, encoded: 0, run: false, hex: false });

/** Adds the file-like content in one piece of text to `into`. */
function measure(text: string, into: Payload) {
  if (BINARY.test(text)) into.binary = true;
  for (const match of text.matchAll(DATA_URI)) into.data += match[1]!.length;
  const rest = text.replace(DATA_URI, " ").replace(WEB_ADDRESS, " ");
  for (const match of rest.matchAll(ENCODED_TOKEN)) if (looksEncoded(match[0])) into.encoded += match[0].length;
  if (HEX_RUN.test(rest)) into.hex = true;
  if (ENCODED_RUN.test(rest)) into.run = true;
  let block = 0;
  for (const line of rest.split(/\r?\n/)) {
    block = isEncodedLine(line) ? block + line.trim().length : 0;
    if (block > ENCODED_LIMIT) into.run = true;
  }
  return into;
}

function verdict(payload: Payload): string | null {
  if (payload.binary) return "binary content";
  if (payload.data > DATA_PAYLOAD_LIMIT) return "an embedded file (data: addresses)";
  if (payload.hex) return "an encoded file (a long run of hex)";
  if (payload.encoded > ENCODED_LIMIT || payload.run) return "an encoded file (base64)";
  return null;
}

/** What kind of embedded file a piece of text contains, if any. */
export function embeddedFileIn(text: string): string | null {
  return verdict(measure(text, nothing()));
}

/** Text with embedded files replaced by `placeholder` (for history, which cannot be edited). */
export function withoutEmbeddedFiles(text: string, placeholder: string): string {
  if (!embeddedFileIn(text)) return text;
  const cleaned = text
    .replace(new RegExp(BINARY.source, "g"), "")
    .replace(DATA_URI, (whole, payload: string) => payload.length > 16 ? placeholder : whole)
    .replace(new RegExp(HEX_RUN.source, "g"), placeholder)
    .replace(new RegExp(ENCODED_RUN.source, "g"), placeholder)
    .replace(ENCODED_TOKEN, (token) => looksEncoded(token) ? placeholder : token)
    .split(/\r?\n/)
    // Each wrapped line, and the shorter last line of a wrapped block, becomes the placeholder.
    .map((line, index, lines) => isEncodedLine(line) || (index > 0 && isEncodedLine(lines[index - 1]!) && /^[\s>]*[A-Za-z0-9+/]{4,}={0,2}\s*$/.test(line)) ? placeholder : line)
    .join("\n");
  // A wrapped payload leaves a column of placeholders: keep one.
  const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return cleaned.replace(new RegExp(`(?:${escaped}[ \\t]*\\r?\\n)+(?=${escaped})`, "g"), "");
}

/** Numbers standing in for bytes: a long array of small whole numbers. */
const BYTES_ARRAY_LIMIT = 1024;

function refuse(where: string, found: string): never {
  throw new PlanbanValidationError(`Not saved: ${where} contains ${found}. ${INDEX_NOT_STORAGE}`);
}

function checkSize(bytes: number, where: string, maxBytes: number) {
  if (bytes > maxBytes) {
    throw new PlanbanValidationError(`Not saved: ${where} is ${Math.ceil(bytes / 1024)} KB; the limit is ${Math.floor(maxBytes / 1024)} KB. Keep long material where it lives and link to it. ${HOW_TO_REFER}`);
  }
}

/**
 * Checks any structured value bound for a board (card fields, metadata,
 * board details, history entries): every key and string for embedded files,
 * added up across the whole value; long number arrays for bytes; and the
 * whole for size.
 */
export function checkIndexValue(value: unknown, where: string, maxBytes: number) {
  const payload = nothing();
  const visit = (entry: unknown) => {
    if (typeof entry === "string") {
      measure(entry, payload);
    } else if (Array.isArray(entry)) {
      if (entry.length > BYTES_ARRAY_LIMIT && entry.every((item) => typeof item === "number")) {
        refuse(where, "a long list of numbers, which is how files are smuggled in");
      }
      for (const item of entry) visit(item);
    } else if (entry && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) {
        measure(key, payload);
        visit(item);
      }
    }
  };
  visit(value);
  const found = verdict(payload);
  if (found) refuse(where, found);
  checkSize(new TextEncoder().encode(JSON.stringify(value) ?? "").length, where, maxBytes);
}

/** Refuses text that embeds a file or is too large for an index. `where` names it for the person, e.g. "the Spec of card x". */
export function checkIndexText(text: string, where: string, maxBytes: number) {
  const found = embeddedFileIn(text);
  if (found) refuse(where, found);
  checkSize(new TextEncoder().encode(text).length, where, maxBytes);
}

export function checkIndexDocument(markdown: string, cardId: string, kind: string) {
  checkIndexText(markdown, `the ${kind === "plan" ? "Plan" : "Spec"} of card ${cardId}`, MAX_DOCUMENT_BYTES);
}

/** Checks one card's own fields (title, summary, notes, metadata and the rest). */
export function checkIndexCard(card: { id: string }) {
  checkIndexValue(card, `card ${card.id}`, MAX_CARD_BYTES);
}
