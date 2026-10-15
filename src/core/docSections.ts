// Editing a Spec or Plan one section at a time (Spec point 20): a section is
// a heading and everything under it, up to the next heading of the same or a
// higher level. Each section has its own version (a hash of its text), so two
// agents editing different sections never clash; whole-document saves keep
// their own check. Pure functions, shared by the service and local boards.
import { PlanbanValidationError } from "./boardOperations";

export interface DocSection {
  /** The heading's text, without the #s. */
  heading: string;
  level: number;
  /** Which section with this heading (0 for the first), when headings repeat. */
  occurrence: number;
  /** A short hash of the section's text, heading line included. */
  version: string;
  start: number;
  end: number;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u;

/** A 64-bit hash of the text, as 16 hex digits (plain JavaScript: it also runs in the service). */
export function sectionVersion(text: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/** The sections of a document, in order; headings inside fenced code are not headings. */
export function docSections(markdown: string): DocSection[] {
  const lines = markdown.split("\n");
  const offsets: number[] = [];
  let at = 0;
  for (const line of lines) {
    offsets.push(at);
    at += line.length + 1;
  }
  const headings: Array<{ line: number; level: number; heading: string }> = [];
  let fence: string | null = null;
  lines.forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      return;
    }
    if (fence) return;
    const match = HEADING.exec(line);
    if (match) headings.push({ line: index, level: match[1]!.length, heading: match[2]! });
  });
  const seen = new Map<string, number>();
  return headings.map((entry, index) => {
    const next = headings.slice(index + 1).find((other) => other.level <= entry.level);
    const start = offsets[entry.line]!;
    const end = next ? offsets[next.line]! : markdown.length;
    const occurrence = seen.get(entry.heading) ?? 0;
    seen.set(entry.heading, occurrence + 1);
    return { heading: entry.heading, level: entry.level, occurrence, version: sectionVersion(markdown.slice(start, end)), start, end };
  });
}

/** Public view: what read_doc returns. */
export function sectionList(markdown: string) {
  return docSections(markdown).map(({ heading, level, occurrence, version }) => ({ heading, level, ...(occurrence ? { occurrence } : {}), version }));
}

export type SectionEdit =
  | { ok: true; markdown: string; section: { heading: string; version: string } }
  | { ok: false; reason: "changed" | "missing" | "exists"; current: { heading: string; version: string | null; text: string } };

/**
 * Replaces one section (expectedVersion from read_doc), or with
 * expectedVersion null inserts a new one after `after` (a heading) or at the
 * end. The new text starts with its own heading line. Refuses, with the
 * section as it is now, if it changed since it was read.
 */
export function editSection(markdown: string, input: { heading: string; occurrence?: number; expectedVersion: string | null; text: string; after?: string | null }): SectionEdit {
  const text = input.text.endsWith("\n") ? input.text : `${input.text}\n`;
  const first = text.split("\n", 1)[0]!;
  if (!HEADING.test(first)) throw new PlanbanValidationError("A section starts with its heading line, such as \"## Current state\".");
  const sections = docSections(markdown);
  const matching = sections.filter((section) => section.heading === input.heading);
  const target = matching[input.occurrence ?? 0];
  if (input.expectedVersion === null) {
    if (target) return { ok: false, reason: "exists", current: { heading: target.heading, version: target.version, text: markdown.slice(target.start, target.end) } };
    const anchor = input.after ? sections.find((section) => section.heading === input.after) : undefined;
    if (input.after && !anchor) throw new PlanbanValidationError(`No section called "${input.after}" to insert after.`);
    const at = anchor ? anchor.end : markdown.length;
    const before = markdown.slice(0, at);
    const joined = `${before}${before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : ""}${text}${markdown.slice(at) ? "\n" : ""}${markdown.slice(at)}`;
    return { ok: true, markdown: joined, section: { heading: input.heading, version: sectionVersion(text) } };
  }
  if (!target) return { ok: false, reason: "missing", current: { heading: input.heading, version: null, text: "" } };
  if (matching.length > 1 && input.occurrence === undefined) {
    throw new PlanbanValidationError(`There are ${matching.length} sections called "${input.heading}". Say which with occurrence (0 for the first).`);
  }
  const current = markdown.slice(target.start, target.end);
  if (target.version !== input.expectedVersion) return { ok: false, reason: "changed", current: { heading: target.heading, version: target.version, text: current } };
  // Keep the blank line that separated it from the next section.
  const trailing = /\n\s*$/u.exec(current)?.[0] ?? "";
  const replacement = trailing.length > 1 && !text.endsWith("\n\n") ? `${text}\n` : text;
  return { ok: true, markdown: `${markdown.slice(0, target.start)}${replacement}${markdown.slice(target.end)}`, section: { heading: input.heading, version: sectionVersion(replacement) } };
}
