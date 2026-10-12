// Strict Local Mode (owner decision 20): a card whose folder holds files is
// flagged, and Planban refuses every change to it until the files are moved
// out. Reads still work. The check itself is shared with Take Online
// (indexCheck.ts); this module adds the local refusal and its wording.
import { join } from "node:path";
import { PlanbanConflictError } from "./boardOperations";
import { filesInCard, friendlyPath } from "./indexCheck";
import { moveFilesOutCommand } from "./staleness";

const LISTED_FILES = 8;

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

/** Refuses when any of the given cards holds files in its folder. */
export async function assertCardsHoldNoFiles(planningRoot: string, cards: Array<{ id: string; title: string }>) {
  for (const card of cards) {
    const files = await filesInCard(planningRoot, card.id);
    if (files.length) {
      throw new PlanbanCardHoldsFilesError({ cardId: card.id, title: card.title, folder: cardFolder(planningRoot, card.id), files });
    }
  }
}

/** Files held by each card that holds any, for flags on the board and in tool results. */
export async function cardsHoldingFiles(planningRoot: string, cardIds: string[]): Promise<Record<string, string[]>> {
  const entries = await Promise.all(cardIds.map(async (id) => [id, await filesInCard(planningRoot, id)] as const));
  return Object.fromEntries(entries.filter(([, files]) => files.length > 0));
}
