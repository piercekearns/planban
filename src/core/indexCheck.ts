// Planban is an index, not storage (owner decisions 18 and 20): a board holds
// only cards, Specs, Plans and history, and refers to files where they live.
// This check finds what is in the way on a board on this machine: files in
// card folders, and pictures in Specs and Plans that are stored inside the
// document or point at files on this machine. Take Online refuses a board
// that is not clean; strict Local Mode will use the same check.
import { execFileSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { checkIndexCard, checkIndexValue, embeddedFileIn, MAX_DETAILS_BYTES, MAX_DOCUMENT_BYTES } from "./contentRules";

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

/** A path with the home folder shortened to ~. */
export function friendlyPath(absolute: string) {
  const home = homedir();
  return absolute === home || absolute.startsWith(home + sep) ? `~${absolute.slice(home.length).split(sep).join("/")}` : absolute;
}

/** How to tidy a board, in plain words; shown wherever the check refuses. */
export function howToTidy(machine = machineName()) {
  return [
    "Planban holds text only and refers to files where they live. To tidy a card:",
    "- Move each file in its folder to where it belongs (the project's repository, a shared drive or a website), and link to it from the card's Spec or Plan: a GitHub link, a web address, or a path labelled with its machine, such as "
      + `"${machine}: ~/Projects/app/renders/front.png".`,
    "- Replace each picture that is stored in a Spec or Plan, or points at a file on this machine, with such a link or labelled path.",
  ].join("\n");
}

/**
 * Every file in a card's folder other than its Spec and Plan, with paths
 * inside the folder (links are listed, not followed), and any folder inside
 * it that could not be read.
 */
export async function filesInCard(planningRoot: string, cardId: string): Promise<{ files: string[]; unreadable: string[] }> {
  const files: string[] = [];
  const unreadable: string[] = [];
  // Only plain card ids name folders; anything else could point outside the board.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(cardId) || cardId.includes("..")) return { files, unreadable };
  const folder = join(planningRoot, "items", cardId);
  // The card's folder itself may be a link to somewhere else: that is not the board's own text either.
  const own = await lstat(folder).catch(() => null);
  if (own?.isSymbolicLink()) return { files: ["(this card's folder is a link to another folder)"], unreadable };
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // A card without a folder is fine; one that cannot be read is reported, never assumed empty.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") unreadable.push(relative(folder, dir).split(sep).join("/") || ".");
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(dir, entry.name);
      const path = relative(folder, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (dir === folder && entry.isFile() && (entry.name === "spec.md" || entry.name === "plan.md")) continue;
      // Anything else (files, links, devices) is not Planban's own text.
      files.push(path);
    }
  };
  await walk(folder);
  return { files, unreadable };
}

const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
/** `![alt][ref]`, `![alt][]` and `![alt]`, with `[ref]: target` defined elsewhere. */
const MARKDOWN_IMAGE_REF = /!\[([^\]\n]*)\](?:\[([^\]\n]*)\]|(?![(\[]))/g;
const MARKDOWN_DEFINITION = /^[ \t]{0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]+)>|(\S+))(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/gm;
const HTML_IMAGE = /<(?:img|source)\b[^>]*>/gi;
const HTML_ATTRIBUTE = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");

const safeDecode = (text: string) => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text; // a literal file name such as "100%.png"
  }
};

/** Pictures in a document that are stored in it or point at a file on this machine. Pictures on the web are fine. */
export function picturesInTheWay(markdown: string, cardFolder: string): Array<{ alt: string; where: string }> {
  const found: Array<{ alt: string; where: string }> = [];
  const consider = (alt: string, target: string) => {
    if (!target) return;
    if (/^data:/i.test(target)) found.push({ alt, where: "stored in the document" });
    else if (/^(https?:)?\/\//i.test(target)) return;
    else if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^file:/i.test(target)) return;
    else {
      const path = safeDecode(target.replace(/^file:\/\//i, ""));
      found.push({ alt, where: friendlyPath(isAbsolute(path) ? path : resolve(cardFolder, path)) });
    }
  };
  for (const match of markdown.matchAll(MARKDOWN_IMAGE)) consider(match[1]!, match[2]!);
  const definitions = new Map([...markdown.matchAll(MARKDOWN_DEFINITION)].map((match) => [match[1]!.trim().toLowerCase(), (match[2] ?? match[3])!]));
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_REF)) {
    const target = definitions.get((match[2] || match[1])!.trim().toLowerCase());
    if (target) consider(match[1]!, target);
  }
  for (const tag of markdown.matchAll(HTML_IMAGE)) {
    const value = (name: string) => {
      const match = HTML_ATTRIBUTE(name).exec(tag[0]);
      return match ? (match[1] ?? match[2] ?? match[3] ?? "") : "";
    };
    const alt = value("alt");
    consider(alt, value("src"));
    // Every candidate in a srcset ("small.png 1x, large.png 2x").
    for (const candidate of value("srcset").split(",")) consider(alt, candidate.trim().split(/\s+/)[0] ?? "");
  }
  return found;
}

export interface IndexReport {
  /** True when nothing is in the way. */
  clean: boolean;
  machine: string;
  cards: Array<{ cardId: string; title: string; files: string[]; pictures: Array<{ kind: "spec" | "plan"; alt: string; where: string }>; problems: string[] }>;
  /** Problems with the board's own details rather than a card. */
  boardProblems: string[];
  files: number;
  pictures: number;
  howToTidy: string;
}

/**
 * Checks a board's cards and current documents against the index rule. Does
 * not change anything. History is not checked here: it records what was.
 */
export async function checkBoardIsIndex(input: {
  planningRoot: string;
  cards: Array<{ id: string; title: string } & Record<string, unknown>>;
  docs: Array<{ cardId: string; kind: "spec" | "plan"; markdown: string }>;
  /** The board's own fields other than its cards (title, description, columns). */
  details?: unknown;
}): Promise<IndexReport> {
  const machine = machineName();
  const byCard = new Map<string, IndexReport["cards"][number]>();
  const entry = (cardId: string, title: string) => {
    let found = byCard.get(cardId);
    if (!found) byCard.set(cardId, found = { cardId, title, files: [], pictures: [], problems: [] });
    return found;
  };
  let files = 0;
  let pictures = 0;
  const titles = new Map(input.cards.map((card) => [card.id, card.title]));
  for (const card of input.cards) {
    const inFolder = await filesInCard(input.planningRoot, card.id);
    if (inFolder.files.length) {
      entry(card.id, card.title).files.push(...inFolder.files);
      files += inFolder.files.length;
    }
    for (const folder of inFolder.unreadable) entry(card.id, card.title).problems.push(`Planban could not read the folder ${folder === "." ? "of this card" : folder} to check it.`);
    // The same check every write uses: all fields, metadata and keys, added up.
    try {
      checkIndexCard(card);
    } catch (error) {
      entry(card.id, card.title).problems.push((error as Error).message.replace(/^Not saved: card \S+ /, "Its fields ").replace(/\. Online Boards hold.*$/s, "."));
    }
  }
  for (const doc of input.docs) {
    const title = titles.get(doc.cardId) ?? doc.cardId;
    const label = doc.kind === "plan" ? "Plan" : "Spec";
    const found = picturesInTheWay(doc.markdown, join(input.planningRoot, "items", doc.cardId));
    if (found.length) {
      entry(doc.cardId, title).pictures.push(...found.map((picture) => ({ kind: doc.kind, ...picture })));
      pictures += found.length;
    }
    // Embedded content that is not a picture (pictures are already listed).
    const withoutPictures = doc.markdown.replace(MARKDOWN_IMAGE, "").replace(HTML_IMAGE, "").replace(MARKDOWN_DEFINITION, "");
    const embedded = embeddedFileIn(withoutPictures);
    if (embedded) entry(doc.cardId, title).problems.push(`Its ${label} contains ${embedded}.`);
    if (new TextEncoder().encode(doc.markdown).length > MAX_DOCUMENT_BYTES) entry(doc.cardId, title).problems.push(`Its ${label} is larger than 1 MB.`);
  }
  const boardProblems: string[] = [];
  if (input.details !== undefined) {
    try {
      checkIndexValue(input.details, "the board's details", MAX_DETAILS_BYTES);
    } catch (error) {
      boardProblems.push((error as Error).message.replace(/^Not saved: /, "").replace(/\. Online Boards hold.*$/s, "."));
    }
  }
  const cards = [...byCard.values()];
  return { clean: cards.length === 0 && boardProblems.length === 0, machine, cards, boardProblems, files, pictures, howToTidy: howToTidy(machine) };
}
