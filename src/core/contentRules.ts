// Planban is an index, not storage (owner decision 18). An Online Board holds
// only its own text: cards, Specs, Plans and their history. Files stay where
// they live, and a card refers to them. These rules are shared by every write
// path into an Online Board (the hosted API, remote and local MCP, Take
// Online), so no route can turn a board into file storage.
import { PlanbanValidationError } from "./boardOperations";

/** Larger than any real Spec or Plan seen so far (the largest is about 0.5 MB). */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;
/** All of one card's own fields together (the largest seen is about 48 KB). */
export const MAX_CARD_BYTES = 128 * 1024;

/** How to point at a file instead of embedding it; shown in errors, tool descriptions and the protocol. */
export const HOW_TO_REFER = "Refer to files where they live instead: a GitHub link, any web address, or a local path labelled with its machine, for example \"Mac mini: ~/Projects/northfold/renders/front.png\".";

export const INDEX_NOT_STORAGE = `Online Boards hold text only: cards, Specs, Plans and their history. Planban does not store files. ${HOW_TO_REFER}`;

const DATA_URI = /data:[a-z]+\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[^;,]*)*;base64,/i;
/** A long unbroken run of base64 is a file, not prose (2 KB of it is about 1.5 KB of binary). */
const BASE64_RUN = /[A-Za-z0-9+/]{2048,}={0,2}|[A-Za-z0-9_-]{4096,}/;
/** Control characters other than tab, newline and carriage return mean binary content. */
const BINARY = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** What kind of embedded file a piece of text contains, if any. */
export function embeddedFileIn(text: string): string | null {
  if (DATA_URI.test(text)) return "an embedded file (a data: address)";
  if (BINARY.test(text)) return "binary content";
  if (BASE64_RUN.test(text)) return "an encoded file (a long run of base64)";
  return null;
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

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, out);
  else if (value && typeof value === "object") for (const entry of Object.values(value)) strings(entry, out);
  return out;
}

/** Checks one card's own fields (title, summary, notes and the rest), each for embedded files and all together for size. */
export function checkIndexCard(card: { id: string }) {
  const where = `card ${card.id}`;
  for (const text of strings(card)) {
    const found = embeddedFileIn(text);
    if (found) throw new PlanbanValidationError(`Not saved: ${where} contains ${found}. ${INDEX_NOT_STORAGE}`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(card)).length;
  if (bytes > MAX_CARD_BYTES) {
    throw new PlanbanValidationError(`Not saved: ${where} is ${Math.ceil(bytes / 1024)} KB; the limit is ${Math.floor(MAX_CARD_BYTES / 1024)} KB. Keep long material where it lives and link to it. ${HOW_TO_REFER}`);
  }
}
