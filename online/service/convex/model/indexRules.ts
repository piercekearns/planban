// Owner decision 18 in the service: every write into an Online Board, from
// edits and from Take Online alike, passes these checks, so no route can
// store a file. The rules themselves are shared with the local side.
import { checkIndexCard, checkIndexDocument, checkIndexValue, MAX_DETAILS_BYTES } from "../../../../src/core/contentRules";
import type { PlanbanRoadmap } from "../../../../src/core/types";
import { fail } from "./errors";

function asServiceError(run: () => void) {
  try {
    run();
  } catch (error) {
    fail("validation", error instanceof Error ? error.message : String(error));
  }
}

/**
 * The board's own fields that are new or changed compared with `before` (all
 * of them when there is no `before`): its details and each card.
 */
export function checkCards(after: PlanbanRoadmap, before?: PlanbanRoadmap | null) {
  for (const item of after.roadmapItems) {
    if (!CARD_ID.test(item.id)) fail("validation", "Online card ids must be plain card ids (letters, numbers, dots, dashes or underscores, starting with a letter or number).");
  }
  const previous = new Map((before?.roadmapItems ?? []).map((item) => [item.id, JSON.stringify(item)]));
  asServiceError(() => {
    // Everything about the board other than its cards: details, columns and any other field.
    const { roadmapItems: _after, ...details } = after;
    const { roadmapItems: _before, ...previousDetails } = before ?? { roadmapItems: [] };
    if (!before || JSON.stringify(previousDetails) !== JSON.stringify(details)) checkIndexValue(details, "the board's details", MAX_DETAILS_BYTES);
    for (const item of after.roadmapItems) {
      if (previous.get(item.id) !== JSON.stringify(item)) checkIndexCard(item);
    }
  });
}

export function checkDocuments(docs: Array<{ cardId: string; kind: string; markdown: string }>) {
  asServiceError(() => {
    for (const doc of docs) checkIndexDocument(doc.markdown, doc.cardId, doc.kind);
  });
}

const CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The history settings Planban has. */
const RETENTION_KEYS = new Set(["boardVersions", "cardVersions", "documentVersions", "hourlyDays", "maxAgeDays"]);

/** What else Take Online brings: retired card ids, history settings and history entries. */
export function checkImportedExtras(input: { retiredIds?: unknown; retention?: unknown; history?: Array<{ entry?: unknown }> }) {
  if (input.retiredIds !== undefined && (!Array.isArray(input.retiredIds) || input.retiredIds.some((id) => typeof id !== "string" || !CARD_ID.test(id)))) {
    fail("validation", "Retired card ids must be plain card ids.");
  }
  if (input.retention !== undefined && input.retention !== null) {
    const valid = typeof input.retention === "object" && !Array.isArray(input.retention)
      && Object.entries(input.retention as Record<string, unknown>).every(([key, value]) => RETENTION_KEYS.has(key) && typeof value === "number" && Number.isFinite(value));
    if (!valid) fail("validation", "History settings must be numbers only.");
  }
  asServiceError(() => {
    if (input.retiredIds !== undefined) checkIndexValue(input.retiredIds, "retired card ids", MAX_DETAILS_BYTES);
    if (input.retention !== undefined) checkIndexValue(input.retention, "history settings", MAX_DETAILS_BYTES);
    for (const version of input.history ?? []) checkIndexValue(version?.entry, "a history entry", MAX_DETAILS_BYTES);
  });
}
