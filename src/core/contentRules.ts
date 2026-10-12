// Planban is an index, not storage (owner decisions 18 and 20). A board holds
// only its own text: cards, Specs, Plans and their history. Files stay where
// they live, and a card refers to them. These rules are shared by every write
// path into an Online Board (the hosted API, remote and local MCP, Take
// Online), so no route can turn a board into file storage; strict Local Mode
// can use the same rules.
//
// What this can and cannot do: it refuses files embedded the ordinary ways
// and with the standard encoders (data: addresses, base64 and base64url,
// hex, byte lists), whole, wrapped or split into pieces. No check on text can
// rule out data deliberately disguised as ordinary text (a file written out
// as words, say); the size limits below are the hard ceiling on that.
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
const DATA_URI = /data:[^\s,`]{0,100},([^\s)"'`<>\]]*)/gi;
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
 * encoded, unlike slugs, ids, hashes and words. Wrapped, split into short
 * pieces or interleaved with prose, a file still adds up.
 */
const ENCODED_TOKEN = /[A-Za-z0-9+/=_-]{24,}/g;
const ENCODED_LIMIT = 2048;
/**
 * Base64 of a real file mixes upper case, lower case and digits throughout
 * (about 40%, 40% and 15%); paths, ids, UUIDs, hashes and CamelCase names are
 * mostly one case or have no digits. Base64 of plain, repetitive bytes
 * repeats a short pattern instead ("BQUFBQUF…").
 */
function looksEncoded(token: string) {
  const upper = token.replace(/[^A-Z]/g, "").length / token.length;
  const lower = token.replace(/[^a-z]/g, "").length / token.length;
  const digits = token.replace(/[^0-9]/g, "").length / token.length;
  if (upper >= 0.12 && lower >= 0.12 && digits >= 0.04) return true;
  return /^(.{1,8}?)\1{5,}/.test(token) && /[A-Z]/.test(token) && !/^[a-z-]+$/.test(token);
}
/** Any payload, however plain, as one unbroken run of base64 or base64url. */
const ENCODED_RUN = /[A-Za-z0-9+/]{2048,}={0,2}|[A-Za-z0-9_-]{2048,}/;
/** A hex dump; lists of hashes are fine. */
const HEX_RUN = /[0-9a-fA-F]{4096,}/;
/**
 * What encoders write: blocks of lines that are almost nothing but payload
 * (base64 or base64url, hex, xxd dumps, byte lists in any syntax, wrapped at
 * any width, blank lines between or not). Real planning text mixes such
 * tokens with words; on the owner's real boards the largest block is under
 * 2,000 characters, while a 3 KB file makes over 4,000 in every encoding.
 */
const TOKEN_SEPARATORS = /[\s,;:\[\]{}()"'`<>|]+/;
const isPayloadToken = (token: string) => /^(?:0x)?[0-9a-fA-F]+$/.test(token)
  || (/^[A-Za-z0-9+/=_-]{8,}$/.test(token)
    // Not words, Names, or slugs and ids such as "improve-audit-2026-07-25-f60dc6e6".
    && !/^[a-z-]+$/.test(token) && !/^[A-Z][a-z]+$/.test(token) && !/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/.test(token));
const PAYLOAD_BLOCK_LIMIT = 4096;
/** Across a structured value's fields, only fields with at least this much payload count towards the limit. */
const FIELD_BLOCK_MIN = 64;
const HASH_FIELDS_LIMIT = 64;

/** Each payload-dominated line, with whether it continues the block before it. */
function payloadLines(text: string) {
  const lines: Array<{ index: number; payload: number }> = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/^[\s>*+-]*(?:\d+[.)]\s+)?/, "");
    if (!line.trim()) return;
    const tokens = line.split(TOKEN_SEPARATORS).filter(Boolean);
    const total = tokens.reduce((sum, token) => sum + token.length, 0);
    const payload = tokens.filter(isPayloadToken).reduce((sum, token) => sum + token.length, 0);
    lines.push({ index, payload: payload >= 8 && payload / total >= 0.6 ? payload : 0 });
  });
  return lines;
}

/** The largest block of payload lines (blank lines continue a block; any other line ends it). */
function largestPayloadBlock(text: string) {
  let block = 0;
  let largest = 0;
  for (const line of payloadLines(text)) {
    block = line.payload ? block + line.payload : 0;
    largest = Math.max(largest, block);
  }
  return largest;
}

/** Control characters other than tab, newline and carriage return mean binary content. */
const BINARY = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** A picture whose destination is the file itself, however small. */
const DATA_IMAGE = /!\[[^\]\n]*\]\(\s*<?data:|<(?:img|source)\b[^>]*\b(?:src|srcset)\s*=\s*["']?\s*data:|^[ \t]{0,3}\[[^\]\n]+\]:[ \t]*<?data:/im;
/**
 * Markdown with its code taken out: fenced blocks (``` or ~~~, any length)
 * and inline code spans (any number of backticks). Code shows examples; a
 * picture or address in code is not one.
 */
export function withoutCode(markdown: string): string {
  return markdown
    .replace(/^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm, " ")
    .replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " ");
}

interface Payload {
  binary: boolean;
  /** A picture stored in the text. */
  image: boolean;
  data: number;
  encoded: number;
  /** One unbroken run of base64 or hex. */
  run: boolean;
  /** Payload lines: within one text its largest block; across a value's fields, the total of the substantial ones. */
  block: number;
}

const nothing = (): Payload => ({ binary: false, image: false, data: 0, encoded: 0, run: false, block: 0 });

/** Adds the file-like content in one piece of text to `into`. */
function measure(text: string, into: Payload, minBlock = 0) {
  if (BINARY.test(text)) into.binary = true;
  if (/data:/i.test(text) && DATA_IMAGE.test(withoutCode(text))) into.image = true;
  for (const match of text.matchAll(DATA_URI)) into.data += match[1]!.length;
  const rest = text.replace(DATA_URI, " ").replace(WEB_ADDRESS, " ");
  for (const match of rest.matchAll(ENCODED_TOKEN)) if (looksEncoded(match[0])) into.encoded += match[0].length;
  if (HEX_RUN.test(rest) || ENCODED_RUN.test(rest)) into.run = true;
  const block = largestPayloadBlock(rest);
  if (block >= minBlock) into.block += block;
  return into;
}

function verdict(payload: Payload): string | null {
  if (payload.binary) return "binary content";
  if (payload.image) return "a picture stored in the text (a data: address)";
  if (payload.data > DATA_PAYLOAD_LIMIT) return "an embedded file (data: addresses)";
  if (payload.run || payload.block > PAYLOAD_BLOCK_LIMIT || payload.encoded > ENCODED_LIMIT) return "an encoded file (base64, hex or a list of bytes)";
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
    // History only: every data: address goes, however short.
    .replace(DATA_URI, () => placeholder)
    .replace(new RegExp(HEX_RUN.source, "g"), placeholder)
    .replace(new RegExp(ENCODED_RUN.source, "g"), placeholder)
    .replace(ENCODED_TOKEN, (token) => looksEncoded(token) ? placeholder : token);
  // Every payload line becomes the placeholder, one per block.
  const lines = cleaned.split(/\r?\n/);
  const payload = new Set(payloadLines(cleaned).filter((line) => line.payload).map((line) => line.index));
  const out: string[] = [];
  lines.forEach((line, index) => {
    if (!payload.has(index)) out.push(line);
    else if (out.at(-1) !== placeholder) out.push(placeholder);
  });
  // Pieces already replaced line by line leave a column of placeholders: keep one.
  return out.filter((line, index) => !(line.trim() === placeholder && out[index - 1]?.trim() === placeholder)).join("\n");
}

/**
 * A structured value (an old card, a history entry) with embedded files taken
 * out: strings cleaned, offending keys renamed, long number lists dropped.
 * For history, which cannot be edited.
 */
export function withoutEmbeddedValue<T>(value: T, placeholder: string): T {
  const clean = (entry: unknown): unknown => {
    if (typeof entry === "string") return withoutEmbeddedFiles(entry, placeholder);
    if (Array.isArray(entry)) {
      return entry.length > 16 && entry.every((item) => typeof item === "number") ? [] : entry.map(clean);
    }
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry).map(([key, item], index) => [embeddedFileIn(key) ? `${placeholder} ${index}` : key, clean(item)]));
    }
    return entry;
  };
  return clean(value) as T;
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
  let numbersInLists = 0;
  // Fields that are exactly one hash (asset checksums, commits) are normal in
  // card metadata; only very many of them together look like a split file.
  let hashFields = 0;
  let hashChars = 0;
  const visit = (entry: unknown) => {
    if (typeof entry === "string") {
      if (/^[0-9a-fA-F]{32}$|^[0-9a-fA-F]{40}$|^[0-9a-fA-F]{64}$|^[0-9a-fA-F]{128}$/.test(entry)) {
        hashFields += 1;
        hashChars += entry.length;
        return;
      }
      // Short fields (dates, ids, tags) never add up to a file; pieces of one do.
      measure(entry, payload, FIELD_BLOCK_MIN);
    } else if (Array.isArray(entry)) {
      // Numbers in lists add up across the whole value, however they are nested.
      numbersInLists += entry.filter((item) => typeof item === "number").length;
      if (numbersInLists > BYTES_ARRAY_LIMIT) refuse(where, "long lists of numbers, which is how files are smuggled in");
      for (const item of entry) visit(item);
    } else if (entry && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) {
        measure(key, payload, FIELD_BLOCK_MIN);
        visit(item);
      }
    }
  };
  visit(value);
  if (hashFields > HASH_FIELDS_LIMIT) payload.block += hashChars;
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
