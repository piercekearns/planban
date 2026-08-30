import type { Status } from "./boardOrdering";

export interface GroupWorkspaceItem {
  id: string;
  status: Status;
  parentId?: string | null;
  boardRank?: number | null;
  groupRank?: number | null;
  isGroup?: boolean;
}

export interface GroupWorkspaceMove {
  status?: Status;
  parentId?: string | null;
  afterId?: string | null;
}

export type GroupPlacementPosition =
  | { kind: "first" }
  | { kind: "last" }
  | { kind: "after"; siblingId: string };

export interface PendingGroupPlacement {
  activeId: string;
  parentId: string;
}

export type GroupWorkspaceDropOutcome = { kind: "move"; activeId: string; move: GroupWorkspaceMove };

const closedStatuses = new Set<Status>(["complete", "archived"]);

export function canPlaceItemInside(items: GroupWorkspaceItem[], activeId: string, parentId: string) {
  const active = items.find((item) => item.id === activeId);
  const parent = items.find((item) => item.id === parentId);
  if (!active || !parent || activeId === parentId) return false;
  if (active.isGroup || parent.parentId != null) return false;
  if (!closedStatuses.has(parent.status)) return true;
  if (!closedStatuses.has(active.status)) return false;
  return true;
}

export function groupPlacementPositionValue(position: GroupPlacementPosition) {
  return position.kind === "after" ? `after:${position.siblingId}` : position.kind;
}

export function groupPlacementPositionFromValue(value: string): GroupPlacementPosition {
  if (value === "first" || value === "last") return { kind: value };
  if (value.startsWith("after:") && value.length > "after:".length) {
    return { kind: "after", siblingId: value.slice("after:".length) };
  }
  return { kind: "last" };
}

export function groupPlacementMove(parentId: string, status: Status, position: GroupPlacementPosition): GroupWorkspaceMove {
  return {
    parentId,
    status,
    ...(position.kind === "first"
      ? { afterId: null }
      : position.kind === "after"
        ? { afterId: position.siblingId }
        : {}),
  };
}

function rankedSiblings(items: GroupWorkspaceItem[], active: GroupWorkspaceItem, status: Status) {
  return items
    .filter((item) => item.id !== active.id && item.parentId === active.parentId && item.status === status)
    .sort((a, b) => {
      const aRank = a.parentId ? a.groupRank : a.boardRank;
      const bRank = b.parentId ? b.groupRank : b.boardRank;
      return (aRank ?? Number.MAX_SAFE_INTEGER) - (bRank ?? Number.MAX_SAFE_INTEGER);
    });
}

function afterIdBefore(items: GroupWorkspaceItem[], active: GroupWorkspaceItem, over: GroupWorkspaceItem) {
  const siblings = rankedSiblings(items, active, over.status);
  const overIndex = siblings.findIndex((item) => item.id === over.id);
  return overIndex <= 0 ? null : siblings[overIndex - 1]?.id ?? null;
}

function sameScope(item: GroupWorkspaceItem, parentId: string | null, status: Status) {
  return (item.parentId ?? null) === parentId && item.status === status;
}

function hierarchyRank(item: GroupWorkspaceItem) {
  return item.parentId ? item.groupRank : item.boardRank;
}

export function previewGroupWorkspaceMove<T extends GroupWorkspaceItem>(
  items: T[],
  activeId: string,
  move: GroupWorkspaceMove,
): T[] {
  const active = items.find((item) => item.id === activeId);
  if (!active) return items;

  const sourceParentId = active.parentId ?? null;
  const targetParentId = move.parentId === undefined ? sourceParentId : move.parentId;
  const targetStatus = move.status ?? active.status;
  const moved = { ...active, parentId: targetParentId, status: targetStatus } as T;
  const updates = new Map<string, T>();
  const sourceIsTarget = sourceParentId === targetParentId && active.status === targetStatus;

  const rankScope = (scope: T[]) => {
    scope.forEach((item, index) => {
      updates.set(item.id, {
        ...item,
        boardRank: item.parentId ? null : index + 1,
        groupRank: item.parentId ? index + 1 : null,
      });
    });
  };

  if (!sourceIsTarget) {
    rankScope(items
      .filter((item) => item.id !== activeId && sameScope(item, sourceParentId, active.status))
      .sort((a, b) => (hierarchyRank(a) ?? Number.MAX_SAFE_INTEGER) - (hierarchyRank(b) ?? Number.MAX_SAFE_INTEGER)));
  }

  const targetItems = items
    .filter((item) => item.id !== activeId && sameScope(item, targetParentId, targetStatus))
    .sort((a, b) => (hierarchyRank(a) ?? Number.MAX_SAFE_INTEGER) - (hierarchyRank(b) ?? Number.MAX_SAFE_INTEGER));
  const afterIndex = typeof move.afterId === "string"
    ? targetItems.findIndex((item) => item.id === move.afterId)
    : null;
  if (afterIndex === -1) return items;
  const insertAt = move.afterId === null
    ? 0
    : afterIndex !== null
      ? afterIndex + 1
      : targetItems.length;
  targetItems.splice(Math.max(0, insertAt), 0, moved);
  rankScope(targetItems);

  return items.map((item) => updates.get(item.id) ?? item);
}

export function groupWorkspaceMoveForDrop(items: GroupWorkspaceItem[], activeId: string, overId: string): GroupWorkspaceMove | null {
  const active = items.find((item) => item.id === activeId);
  if (!active) return null;

  const placementPrefix = overId.startsWith("group-before:")
    ? "group-before:"
    : overId.startsWith("group-after:")
      ? "group-after:"
      : null;
  if (placementPrefix) {
    const overItem = items.find((item) => item.id === overId.slice(placementPrefix.length));
    if (!overItem || overItem.id === activeId) return null;
    return {
      status: overItem.status,
      afterId: placementPrefix === "group-after:" ? overItem.id : afterIdBefore(items, active, overItem),
    };
  }

  if (overId.startsWith("group-status:")) {
    return { status: overId.slice("group-status:".length) as Status };
  }

  if (overId.startsWith("group-item:")) {
    const overItem = items.find((item) => item.id === overId.slice("group-item:".length));
    if (!overItem || overItem.id === activeId) return null;
    const movingForward = active.parentId === overItem.parentId
      && active.status === overItem.status
      && (active.groupRank ?? Number.MAX_SAFE_INTEGER) < (overItem.groupRank ?? Number.MAX_SAFE_INTEGER);
    return { status: overItem.status, afterId: movingForward ? overItem.id : afterIdBefore(items, active, overItem) };
  }

  return null;
}

export function groupWorkspaceDropOutcome(items: GroupWorkspaceItem[], activeId: string, overId: string): GroupWorkspaceDropOutcome | null {
  const move = groupWorkspaceMoveForDrop(items, activeId, overId);
  if (!move) return null;
  return move.parentId ? null : { kind: "move", activeId, move };
}

export function groupPlacementDecision(pending: PendingGroupPlacement, status: Status, position: GroupPlacementPosition | null) {
  return position ? { activeId: pending.activeId, move: groupPlacementMove(pending.parentId, status, position) } : null;
}
