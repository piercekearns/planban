// Planban is an index, not storage (owner decisions 18 and 20): a board holds
// only cards, Specs, Plans and history, and refers to files where they live.
// This check finds what is in the way on a board on this machine: files in
// card folders, and pictures in Specs and Plans that are stored inside the
// document or point at files on this machine. Take Online refuses a board
// that is not clean; strict Local Mode refuses changes to a card holding files.
import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { embeddedFileIn, MAX_CARD_BYTES, MAX_DOCUMENT_BYTES } from "./contentRules";

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
    "- Or run `planban move-files-out <card> --to <folder>` (add --dry-run to preview): it moves the folder's files to that folder without overwriting anything, and adds a Files section to the card's Spec that refers to them.",
  ].join("\n");
}

/** Planban's own short-lived files while it saves a Spec or Plan (see atomicWriteFile). */
const PLANBAN_SAVE_FILE = /^\.(spec|plan)\.md\.\d+\.\d+\.[0-9a-f-]{36}\.tmp$/;
/** Folder settings the operating system adds when a person opens the folder; never a person's file. */
const SYSTEM_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** Every file in a card's folder other than its Spec and Plan, with paths inside the folder. An empty folder is listed as `name/`. */
export async function filesInCard(planningRoot: string, cardId: string): Promise<string[]> {
  // Only plain card ids name folders; anything else could point outside the board.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(cardId) || cardId.includes("..")) return [];
  const folder = join(planningRoot, "items", cardId);
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(dir, entry.name);
      const path = relative(folder, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        // An empty folder is still something besides the card's text.
        if ((await readdir(absolute).catch(() => null))?.length === 0) found.push(`${path}/`);
        else await walk(absolute);
        continue;
      }
      if (dir === folder && (entry.name === "spec.md" || entry.name === "plan.md" || PLANBAN_SAVE_FILE.test(entry.name))) continue;
      if (SYSTEM_FILES.has(entry.name)) continue;
      // Anything else (files, links, devices) is not Planban's own text.
      found.push(path);
    }
  };
  await walk(folder);
  return found;
}

const MARKDOWN_IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMAGE = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']*)["'][^>]*>/gi;
const HTML_ALT = /\balt\s*=\s*["']([^"']*)["']/i;

/** Pictures in a document that are stored in it or point at a file on this machine. Pictures on the web are fine. */
export function picturesInTheWay(markdown: string, cardFolder: string): Array<{ alt: string; where: string }> {
  const found: Array<{ alt: string; where: string }> = [];
  const consider = (alt: string, target: string) => {
    if (/^data:/i.test(target)) found.push({ alt, where: "stored in the document" });
    else if (/^(https?:)?\/\//i.test(target)) return;
    else if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^file:/i.test(target)) return;
    else {
      const path = decodeURIComponent(target.replace(/^file:\/\//i, ""));
      found.push({ alt, where: friendlyPath(isAbsolute(path) ? path : resolve(cardFolder, path)) });
    }
  };
  for (const match of markdown.matchAll(MARKDOWN_IMAGE)) consider(match[1]!, match[2]!);
  for (const match of markdown.matchAll(HTML_IMAGE)) consider(HTML_ALT.exec(match[0])?.[1] ?? "", match[1]!);
  return found;
}

export interface IndexReport {
  /** True when nothing is in the way. */
  clean: boolean;
  machine: string;
  cards: Array<{ cardId: string; title: string; files: string[]; pictures: Array<{ kind: "spec" | "plan"; alt: string; where: string }>; problems: string[] }>;
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
    if (inFolder.length) {
      entry(card.id, card.title).files.push(...inFolder);
      files += inFolder.length;
    }
    const text = Object.values(card).filter((value): value is string => typeof value === "string").join("\n");
    if (embeddedFileIn(text)) entry(card.id, card.title).problems.push("Its fields contain an embedded file.");
    if (new TextEncoder().encode(JSON.stringify(card)).length > MAX_CARD_BYTES) entry(card.id, card.title).problems.push("Its fields are larger than 128 KB.");
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
    const withoutPictures = doc.markdown.replace(MARKDOWN_IMAGE, "").replace(HTML_IMAGE, "");
    const embedded = embeddedFileIn(withoutPictures);
    if (embedded) entry(doc.cardId, title).problems.push(`Its ${label} contains ${embedded}.`);
    if (new TextEncoder().encode(doc.markdown).length > MAX_DOCUMENT_BYTES) entry(doc.cardId, title).problems.push(`Its ${label} is larger than 1 MB.`);
  }
  const cards = [...byCard.values()];
  return { clean: cards.length === 0, machine, cards, files, pictures, howToTidy: howToTidy(machine) };
}
