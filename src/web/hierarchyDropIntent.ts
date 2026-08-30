export type HierarchyDropOperation = "before" | "inside" | "after";

export interface HierarchyDropIntent {
  targetId: string;
  operation: HierarchyDropOperation;
}

export type HierarchyDropCommitDecision =
  | ({ kind: "hierarchy" } & HierarchyDropIntent)
  | { kind: "move"; overId: string }
  | { kind: "noop" };

export interface HierarchyDropRect {
  top: number;
  bottom: number;
  height: number;
  left?: number;
  right?: number;
  width?: number;
}

export interface HierarchyColumnTargetRect {
  id: string;
  top: number;
  bottom: number;
}

export interface HierarchyDropIntentOptions {
  canMoveInside?: boolean;
  previous?: HierarchyDropOperation | null;
  deadbandPx?: number;
}

export interface HierarchyContainmentCue {
  label: string;
  detail: string;
}

/** Describe the structural action that an eligible whole-card drop will perform. */
export function hierarchyContainmentCue(targetIsGroup: boolean): HierarchyContainmentCue {
  return targetIsGroup
    ? { label: "Add to Group", detail: "Release to choose placement" }
    : { label: "Create Group", detail: "Release to group both Items" };
}

/** Keep a containment target stable while nearby cards animate around the pointer. */
export function hierarchyContainmentLatch(
  pointer: { x: number; y: number },
  rect: HierarchyDropRect,
  exitMarginPx = 12,
) {
  const left = rect.left ?? Number.NEGATIVE_INFINITY;
  const right = rect.right ?? Number.POSITIVE_INFINITY;
  const margin = Math.max(0, exitMarginPx);
  return pointer.x >= left - margin
    && pointer.x <= right + margin
    && pointer.y >= rect.top - margin
    && pointer.y <= rect.bottom + margin;
}

interface HierarchyRankedItem {
  id: string;
  status: string;
  parentId?: string | null;
  boardRank?: number | null;
  groupRank?: number | null;
}

/**
 * Resolve one stable card target into reorder-before, contain, or reorder-after.
 * Eligible hierarchy targets reserve their middle half for containment; ordinary
 * reorder targets split at their midpoint. A small deadband prevents flicker at
 * the two operation boundaries without making the gesture feel sticky.
 */
export function hierarchyDropOperation(
  pointerY: number,
  rect: HierarchyDropRect,
  options: HierarchyDropIntentOptions = {},
): HierarchyDropOperation {
  const canMoveInside = options.canMoveInside !== false;
  const height = rect.height > 0 ? rect.height : Math.max(0, rect.bottom - rect.top);
  const beforeBoundary = rect.top + height * (canMoveInside ? 0.25 : 0.5);
  const afterBoundary = rect.top + height * (canMoveInside ? 0.75 : 0.5);
  const deadband = Math.max(0, options.deadbandPx ?? 3);

  if (options.previous === "before" && pointerY <= beforeBoundary + deadband) return "before";
  if (options.previous === "after" && pointerY >= afterBoundary - deadband) return "after";
  if (options.previous === "inside" && canMoveInside
    && pointerY >= beforeBoundary - deadband && pointerY <= afterBoundary + deadband) return "inside";

  if (pointerY < beforeBoundary) return "before";
  if (pointerY > afterBoundary) return "after";
  return canMoveInside ? "inside" : (pointerY < afterBoundary ? "before" : "after");
}

/** Resolve the sortable destination index that matches the explicit card region. */
export function hierarchyReorderPreviewIndex(
  activeIndex: number,
  targetIndex: number,
  operation: Exclude<HierarchyDropOperation, "inside">,
) {
  if (operation === "before") return targetIndex - (activeIndex < targetIndex ? 1 : 0);
  return targetIndex + (activeIndex > targetIndex ? 1 : 0);
}

/** Before/after placement gets a provisional destination card as well as the lifted overlay. */
export function hierarchyReorderPlaceholderVisible(operation: HierarchyDropOperation | null) {
  return operation === "before" || operation === "after";
}

/** Visual treatment for the source card while its lifted copy follows the pointer. */
export function hierarchyDraggedSourceOpacity(
  reorderPreview: boolean,
  hideSourceDuringDrag: boolean,
  ordinaryOpacity = 0.45,
) {
  return hideSourceDuringDrag ? 0 : reorderPreview ? 1 : ordinaryOpacity;
}

/** Keep the source slot stable while an Item is previewed inside another Work Item. */
export function hierarchyContainmentSourceFootprint(sourceHeight: number | null, containmentActive: boolean) {
  if (!containmentActive || !sourceHeight || sourceHeight <= 0) return undefined;
  return sourceHeight;
}

/** Whether a before/after intent would actually change scope or sibling rank. */
export function hierarchyPlacementChanges<T extends HierarchyRankedItem>(
  items: T[],
  activeId: string,
  targetId: string,
  operation: Exclude<HierarchyDropOperation, "inside">,
) {
  const active = items.find((item) => item.id === activeId);
  const target = items.find((item) => item.id === targetId);
  if (!active || !target || active.id === target.id) return false;
  if ((active.parentId ?? null) !== (target.parentId ?? null) || active.status !== target.status) return true;

  const parentId = target.parentId ?? null;
  const rank = (item: T) => parentId === null ? item.boardRank : item.groupRank;
  const current = items
    .filter((item) => (item.parentId ?? null) === parentId && item.status === target.status)
    .sort((a, b) => (rank(a) ?? Number.MAX_SAFE_INTEGER) - (rank(b) ?? Number.MAX_SAFE_INTEGER));
  const currentIndex = current.findIndex((item) => item.id === activeId);
  const withoutActive = current.filter((item) => item.id !== activeId);
  const targetIndex = withoutActive.findIndex((item) => item.id === targetId);
  if (currentIndex < 0 || targetIndex < 0) return false;
  const destinationIndex = targetIndex + (operation === "after" ? 1 : 0);
  return currentIndex !== destinationIndex;
}

/**
 * Make release behaviour match the currently rendered hierarchy preview.
 * A same-scope release without an explicit before/inside/after intent is a
 * no-op; only a different status remains an implicit column move.
 */
export function hierarchyDropCommitDecision(
  activeId: string,
  activeStatus: string,
  overId: string | null,
  overStatus: string | null,
  intent: HierarchyDropIntent | null,
): HierarchyDropCommitDecision {
  // The containment preview is derived from the pointer and remains latched while
  // it is visibly active. Trust that visible state even when the shrunken overlay
  // makes dnd-kit resolve the final collision back to the dragged source.
  if (intent?.operation === "inside") return { kind: "hierarchy", ...intent };
  if (intent && overId === intent.targetId) return { kind: "hierarchy", ...intent };
  if (!overId || overId === activeId || !overStatus || overStatus === activeStatus) return { kind: "noop" };
  return { kind: "move", overId };
}

/** Resolve empty column space to the last sibling so an after-last preview remains spatial. */
export function hierarchyColumnTailTarget<T extends HierarchyRankedItem>(items: T[], activeId: string, status: string) {
  const active = items.find((item) => item.id === activeId);
  if (!active) return null;
  const parentId = active.parentId ?? null;
  return items
    .filter((item) => item.id !== activeId && (item.parentId ?? null) === parentId && item.status === status)
    .sort((a, b) => {
      const aRank = parentId === null ? a.boardRank : a.groupRank;
      const bRank = parentId === null ? b.boardRank : b.groupRank;
      return (aRank ?? Number.MAX_SAFE_INTEGER) - (bRank ?? Number.MAX_SAFE_INTEGER);
    })
    .at(-1)?.id ?? null;
}

/** Build a column-level status move independently of whether its cards are visible. */
export function hierarchyColumnDropPreview<T extends HierarchyRankedItem>(
  items: T[],
  activeId: string,
  targetStatus: T["status"],
) {
  const active = items.find((item) => item.id === activeId);
  if (!active || active.status === targetStatus) return null;
  const targetId = hierarchyColumnTailTarget(items, activeId, targetStatus);
  return {
    status: targetStatus,
    targetId,
    operation: targetId ? "after" as const : "empty" as const,
  };
}

/** Resolve otherwise-empty column space to the nearest visible card boundary. */
export function hierarchyColumnSpatialTarget(pointerY: number, rects: HierarchyColumnTargetRect[]) {
  return [...rects]
    .sort((a, b) => a.top - b.top)
    .map((rect) => ({
      id: rect.id,
      distance: pointerY < rect.top ? rect.top - pointerY : pointerY > rect.bottom ? pointerY - rect.bottom : 0,
    }))
    .sort((a, b) => a.distance - b.distance)[0]?.id ?? null;
}
