// Owner decision 18 in the service: every write into an Online Board, from
// edits and from Take Online alike, passes these checks, so no route can
// store a file. The rules themselves are shared with the local side.
import { checkIndexCard, checkIndexDocument } from "../../../../src/core/contentRules";
import type { PlanbanRoadmap } from "../../../../src/core/types";
import { fail } from "./errors";

function asServiceError(run: () => void) {
  try {
    run();
  } catch (error) {
    fail("validation", error instanceof Error ? error.message : String(error));
  }
}

/** Cards that are new or changed compared with `before` (all of them when there is no `before`). */
export function checkCards(after: PlanbanRoadmap, before?: PlanbanRoadmap | null) {
  const previous = new Map((before?.roadmapItems ?? []).map((item) => [item.id, JSON.stringify(item)]));
  asServiceError(() => {
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
