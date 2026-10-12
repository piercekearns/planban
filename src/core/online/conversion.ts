// Taking a board online sends only its text (owner decision 18: Planban is an
// index, not storage). Before anything moves, this step works out what the
// online copy says instead of each file: the files in each card's folder, and
// the pictures in its Spec and Plan, become references to where they live on
// this machine. The local board is never changed; its own copy keeps every
// file and picture.
//
// How strictly Local Mode follows the same standard, and exactly how existing
// files should be converted, are still open with the owner. So the rule for
// turning one file into text is a policy passed in (`ConversionPolicy`); the
// rest of Take Online does not depend on which policy is used.
import { execFileSync } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { embeddedFileIn, MAX_CARD_BYTES, MAX_DOCUMENT_BYTES, withoutEmbeddedFiles } from "../contentRules";
import type { BoardBundle } from "./transfers";

/** One local file the online copy will refer to instead of holding. */
export interface LocalFile {
  cardId: string;
  /** Path inside the card's folder, with forward slashes. */
  path: string;
  absolute: string;
  size: number;
  /** A folder of many files (a cache or dependency folder) listed once. */
  folder?: boolean;
}

/** A picture in a Spec or Plan, and what the online copy says instead. */
export interface PictureChange {
  cardId: string;
  kind: "spec" | "plan";
  alt: string;
  /** Where the picture is: a path, or "embedded" for one stored inside the document. */
  target: string;
  replacement: string;
}

/** Turns local files and pictures into text for the online copy. */
export interface ConversionPolicy {
  /** The text that stands for a local file. */
  fileReference(file: LocalFile): string;
  /** The text that stands for a picture in a document, given where its file is (null when embedded in the document). */
  pictureReference(alt: string, file: string | null): string;
}

/** This machine's name as people know it, such as "Pierce's Mac mini". */
export function machineName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
      if (name) return name;
    } catch {
      // fall back to the host name
    }
  }
  return hostname().replace(/\.local$/, "");
}

/** A path with the home folder shortened to ~, so it reads the same on every machine of one person. */
function friendlyPath(absolute: string) {
  const home = homedir();
  return absolute === home || absolute.startsWith(home + sep) ? `~${absolute.slice(home.length).split(sep).join("/")}` : absolute;
}

/** The current decision: each file becomes a local path labelled with this machine. */
export function referencePolicy(machine = machineName()): ConversionPolicy {
  return {
    fileReference: (file) => `${machine}: ${friendlyPath(file.absolute)}${file.folder ? " (folder)" : ""}`,
    pictureReference: (alt, file) => file
      ? `[Picture${alt ? `: ${alt}` : ""}, on ${machine}: ${friendlyPath(file)}]`
      : `[Picture${alt ? `: ${alt}` : ""}, embedded in the copy of this board on ${machine}; not taken online]`,
  };
}

/** Folders whose contents are listed as one reference rather than file by file. */
const FOLDERS_AS_ONE = new Set(["node_modules", ".git", "__pycache__", ".cache", "cache", "tmp", ".venv"]);

/** Every file in each card's folder other than its Spec and Plan. */
export async function cardFiles(planningRoot: string, cardIds: Iterable<string>): Promise<LocalFile[]> {
  const files: LocalFile[] = [];
  for (const cardId of cardIds) {
    // Only plain card ids name folders; anything else could point outside the board.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(cardId) || cardId.includes("..")) continue;
    const folder = join(planningRoot, "items", cardId);
    const walk = async (dir: string): Promise<void> => {
      for (const entry of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = join(dir, entry.name);
        const path = relative(folder, absolute).split(sep).join("/");
        if (entry.isDirectory()) {
          if (FOLDERS_AS_ONE.has(entry.name)) files.push({ cardId, path, absolute, size: 0, folder: true });
          else await walk(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        if (dir === folder && (entry.name === "spec.md" || entry.name === "plan.md")) continue;
        files.push({ cardId, path, absolute, size: (await stat(absolute)).size });
      }
    };
    await walk(folder);
  }
  return files;
}

const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
const HTML_ALT = /\balt\s*=\s*["']([^"']*)["']/i;
const isWebAddress = (target: string) => /^(https?:)?\/\//i.test(target);

/**
 * Rewrites one document for the online copy: pictures on the web stay as they
 * are; pictures that are files on this machine, or stored inside the
 * document, become references.
 */
export function convertDocument(markdown: string, cardFolder: string, policy: ConversionPolicy, note: (alt: string, target: string, replacement: string) => void) {
  const local = (target: string) => {
    if (target.startsWith("data:")) return { file: null as string | null, embedded: true };
    if (isWebAddress(target) || /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^file:/i.test(target)) return null;
    const path = decodeURIComponent(target.replace(/^file:\/\//i, ""));
    return { file: isAbsolute(path) ? path : resolve(cardFolder, path), embedded: false };
  };
  const replace = (whole: string, alt: string, target: string) => {
    const found = local(target);
    if (!found) return whole;
    const replacement = policy.pictureReference(alt, found.file);
    note(alt, found.embedded ? "embedded" : friendlyPath(found.file!), replacement);
    return replacement;
  };
  return markdown
    .replace(MARKDOWN_IMAGE, (whole, alt: string, target: string) => replace(whole, alt, target))
    .replace(HTML_IMAGE, (whole, target: string) => replace(whole, HTML_ALT.exec(whole)?.[1] ?? "", target));
}

export interface ConversionReport {
  machine: string;
  cards: Array<{ cardId: string; title: string; files: string[]; pictures: Array<{ kind: "spec" | "plan"; alt: string; target: string }> }>;
  files: number;
  pictures: number;
  /** Text that still cannot go online after conversion (too large, or embedded content outside a picture). */
  problems: string[];
}

function filesSection(files: LocalFile[], policy: ConversionPolicy, machine: string) {
  return [
    `## Files on ${machine}`,
    "",
    "This card's folder held these files when the board went online. They stay on that machine; Planban keeps text only.",
    "",
    ...files.map((file) => `- ${policy.fileReference(file)}`),
    "",
  ].join("\n");
}

/**
 * The online copy of a board: the bundle with each card's files listed as
 * references in its Spec, and local pictures in Specs and Plans (current and
 * historical) replaced by references. Returns what changed, for the person
 * to confirm before anything moves.
 */
export async function convertForOnline(bundle: BoardBundle, planningRoot: string, policy: ConversionPolicy = referencePolicy(), machine = machineName()): Promise<{ bundle: BoardBundle; report: ConversionReport }> {
  const titles = new Map(bundle.roadmap.roadmapItems.map((item) => [item.id, item.title]));
  const byCard = new Map<string, ConversionReport["cards"][number]>();
  const entry = (cardId: string) => {
    let found = byCard.get(cardId);
    if (!found) byCard.set(cardId, found = { cardId, title: titles.get(cardId) ?? cardId, files: [], pictures: [] });
    return found;
  };
  const folderOf = (cardId: string) => join(planningRoot, "items", cardId);
  const files = await cardFiles(planningRoot, bundle.roadmap.roadmapItems.map((item) => item.id));
  const filesByCard = new Map<string, LocalFile[]>();
  for (const file of files) {
    filesByCard.set(file.cardId, [...filesByCard.get(file.cardId) ?? [], file]);
    entry(file.cardId).files.push(file.path + (file.folder ? "/" : ""));
  }
  let pictures = 0;
  const docs = bundle.docs.map((doc) => ({
    ...doc,
    markdown: convertDocument(doc.markdown, folderOf(doc.cardId), policy, (alt, target) => {
      pictures += 1;
      entry(doc.cardId).pictures.push({ kind: doc.kind, alt, target });
    }),
  }));
  // Each card's files are listed in its Spec online; a card without a Spec gets one for them.
  for (const [cardId, cardList] of filesByCard) {
    const section = filesSection(cardList, policy, machine);
    const spec = docs.find((doc) => doc.cardId === cardId && doc.kind === "spec");
    if (spec) spec.markdown = `${spec.markdown.replace(/\s*$/, "")}\n\n${section}`;
    else docs.push({ cardId, kind: "spec", markdown: `# ${titles.get(cardId) ?? cardId}\n\n${section}` });
  }
  // History keeps its meaning, with pictures as references too. History
  // cannot be edited, so anything else embedded in an old version is replaced
  // by a note in the online copy; the copy on this machine keeps it all.
  const scrub = (text: string) => withoutEmbeddedFiles(text, `[embedded file, kept in the copy on ${machine}]`);
  const historyDocs = (bundle.historyDocs ?? []).map((doc) => ({ ...doc, markdown: scrub(convertDocument(doc.markdown, folderOf(doc.cardId), policy, () => undefined)) }));
  const scrubCard = <T,>(item: T): T => JSON.parse(JSON.stringify(item), (_key, value) => typeof value === "string" ? scrub(value) : value);
  const history: BoardBundle["history"] = bundle.history.map((version) => ({ ...version, roadmap: scrubCard(version.roadmap) }));
  const problems: string[] = [];
  for (const doc of docs) {
    const found = embeddedFileIn(doc.markdown);
    if (found) problems.push(`The ${doc.kind === "plan" ? "Plan" : "Spec"} of "${titles.get(doc.cardId) ?? doc.cardId}" contains ${found} outside a picture. Move it to a file and link to it.`);
    if (new TextEncoder().encode(doc.markdown).length > MAX_DOCUMENT_BYTES) problems.push(`The ${doc.kind === "plan" ? "Plan" : "Spec"} of "${titles.get(doc.cardId) ?? doc.cardId}" is larger than 1 MB. Move long material to a file and link to it.`);
  }
  for (const item of bundle.roadmap.roadmapItems) {
    const text = JSON.stringify(item);
    if (embeddedFileIn(Object.values(item).filter((value): value is string => typeof value === "string").join("\n"))) problems.push(`Card "${item.title}" contains embedded file content in its fields.`);
    if (new TextEncoder().encode(text).length > MAX_CARD_BYTES) problems.push(`Card "${item.title}" is larger than 128 KB.`);
  }
  return {
    bundle: { ...bundle, docs, historyDocs, history },
    report: { machine, cards: [...byCard.values()], files: files.length, pictures, problems },
  };
}
