// Strict Local Mode (owner decision 20): a card whose folder holds files is
// flagged, and Planban refuses every change to it until the files are moved
// out. Reads still work. The check itself is shared with Take Online
// (indexCheck.ts); this module adds the local refusal and its wording.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { PlanbanConflictError } from "./boardOperations";
import { checkIndexCard, checkIndexDocument, checkIndexValue, MAX_DETAILS_BYTES } from "./contentRules";
import { filesInCard, friendlyPath } from "./indexCheck";
import { resolveInsideRoot } from "./paths";
import { moveFilesOutCommand } from "./staleness";

const LISTED_FILES = 8;
/** Folder settings the operating system adds when a person opens a folder. */
const SYSTEM_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

export class PlanbanCardHoldsFilesError extends PlanbanConflictError {
  readonly cardId: string;
  readonly files: string[];

  constructor(input: { cardId: string; title: string; folder: string; files: string[] }) {
    super(cardHoldsFilesMessage(input));
    this.name = "PlanbanCardHoldsFilesError";
    this.cardId = input.cardId;
    this.files = input.files;
  }
}

export function cardFolder(planningRoot: string, cardId: string) {
  return join(planningRoot, "items", cardId);
}

/** Short list of a card's files for messages: the first few, then a count. */
export function listFiles(files: string[], limit = LISTED_FILES) {
  const shown = files.slice(0, limit).join(", ");
  return files.length > limit ? `${shown} and ${files.length - limit} more` : shown;
}

export function cardHoldsFilesMessage(input: { cardId: string; title: string; folder: string; files: string[] }) {
  const count = `${input.files.length} file${input.files.length === 1 ? "" : "s"}`;
  return [
    `Not saved: card ${input.cardId} ("${input.title}") holds ${count} in its folder, ${friendlyPath(input.folder)}: ${listFiles(input.files)}.`,
    "Planban is an index, not file storage: a card holds only its text, and refers to files where they live. Planban refuses changes to this card until its files are moved out; reading it still works.",
    `To tidy it, run \`${moveFilesOutCommand(input.cardId)}\` (or the planban_move_files_out tool), with --dry-run first to preview. It moves the files to that folder without overwriting or deleting anything, and adds a Files section to the card's Spec that refers to them where they now live.`,
  ].join("\n");
}

/**
 * What a card's folder holds besides its Spec and Plan, for flags and refusals. A folder Planban
 * cannot read is listed too: it cannot be shown to be clean.
 */
export async function cardFolderEntries(planningRoot: string, cardId: string): Promise<string[]> {
  const { files, unreadable } = await filesInCard(planningRoot, cardId);
  return [...files, ...unreadable.map((path) => path === "." ? "(this card's folder, which could not be read)" : `${path}/ (could not be read)`)];
}

/** Refuses when any of the given cards holds files in its folder. */
export async function assertCardsHoldNoFiles(planningRoot: string, cards: Array<{ id: string; title: string }>) {
  for (const card of cards) {
    const files = await cardFolderEntries(planningRoot, card.id);
    if (files.length) {
      throw new PlanbanCardHoldsFilesError({ cardId: card.id, title: card.title, folder: cardFolder(planningRoot, card.id), files });
    }
  }
}

/** Files held by each card that holds any, for flags on the board and in tool results. */
export async function cardsHoldingFiles(planningRoot: string, cardIds: string[]): Promise<Record<string, string[]>> {
  const entries = await Promise.all(cardIds.map(async (id) => [id, await cardFolderEntries(planningRoot, id)] as const));
  return Object.fromEntries(entries.filter(([, files]) => files.length > 0));
}

/**
 * Refuses to copy a board that is not a clean index: a card folder (or a leftover folder of a
 * deleted card) holding files, or text that embeds a file. Copying it would make another board
 * holding the same files.
 */
export async function assertBoardIsIndex(planningRoot: string, roadmap: {
  project: unknown;
  roadmapItems: Array<{ id: string; title: string; specDoc?: string | null; planDoc?: string | null }>;
}) {
  const entries = await readdir(join(planningRoot, "items"), { withFileTypes: true }).catch(() => []);
  // Card folders, including ones that are links (filesInCard reports those), and anything else lying beside them.
  const folders = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name);
  const strays = entries.filter((entry) => !entry.isDirectory() && !entry.isSymbolicLink() && !SYSTEM_FILES.has(entry.name)).map((entry) => entry.name);
  const holding = Object.entries(await cardsHoldingFiles(planningRoot, folders));
  if (strays.length) holding.push(["(beside the card folders)", strays]);
  if (holding.length) {
    const listed = holding.slice(0, 5).map(([id, files]) => `${id} (${listFiles(files, 3)})`).join("; ");
    const more = holding.length > 5 ? `; and ${holding.length - 5} more` : "";
    throw new PlanbanConflictError(
      `Not copied: ${holding.length === 1 ? "a card folder holds" : `${holding.length} card folders hold`} files: ${listed}${more}. Planban is an index, not file storage, so a copy would hold the same files. Tidy each card with \`${moveFilesOutCommand("<card>")}\`, then copy the board again.`,
    );
  }
  checkIndexValue(roadmap.project, "the board details", MAX_DETAILS_BYTES);
  for (const card of roadmap.roadmapItems) {
    checkIndexCard(card);
    for (const [kind, path] of [["spec", card.specDoc], ["plan", card.planDoc]] as const) {
      if (!path) continue;
      const markdown = await (async () => readFile(resolveInsideRoot(planningRoot, path), "utf8"))().catch(() => null);
      if (markdown !== null) checkIndexDocument(markdown, card.id, kind);
    }
  }
}
