export const statuses = ["in-progress", "up-next", "pending", "complete", "archived"] as const;
export type Status = (typeof statuses)[number];

export interface BoardOrderItem {
  id: string;
  status: Status;
  priority: number | null;
}

export function emptyStatusGroups<T extends BoardOrderItem>() {
  return {
    "in-progress": [] as T[],
    "up-next": [] as T[],
    pending: [] as T[],
    complete: [] as T[],
    archived: [] as T[],
  };
}

export function groupItems<T extends BoardOrderItem>(items: T[]) {
  const grouped = emptyStatusGroups<T>();
  for (const item of items) grouped[item.status].push(item);
  for (const status of statuses) {
    grouped[status].sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));
  }
  return grouped;
}

export function groupItemsInCurrentOrder<T extends BoardOrderItem>(items: T[]) {
  const grouped = emptyStatusGroups<T>();
  for (const item of items) grouped[item.status].push(item);
  return grouped;
}

export function statusForDropTarget<T extends BoardOrderItem>(items: T[], overId: string): Status | null {
  if (statuses.includes(overId as Status)) return overId as Status;
  return items.find((item) => item.id === overId)?.status ?? null;
}

export function moveIntoStatus<T extends BoardOrderItem>(
  currentItems: T[],
  id: string,
  status: Status,
  beforeId: string | null,
) {
  const active = currentItems.find((item) => item.id === id);
  if (!active) return currentItems;
  const remaining = currentItems.filter((item) => item.id !== id);
  const moved = { ...active, status };
  const insertAt = beforeId
    ? remaining.findIndex((item) => item.id === beforeId)
    : remaining.map((item) => item.status).lastIndexOf(status) + 1;
  const safeInsertAt = insertAt >= 0 ? insertAt : remaining.length;
  return [...remaining.slice(0, safeInsertAt), moved, ...remaining.slice(safeInsertAt)];
}

export function moveWithinStatus<T extends BoardOrderItem>(
  currentItems: T[],
  id: string,
  overId: string,
  status: Status,
) {
  const grouped = groupItemsInCurrentOrder(currentItems);
  const statusItems = grouped[status];
  const from = statusItems.findIndex((item) => item.id === id);
  const to = statusItems.findIndex((item) => item.id === overId);
  if (from < 0 || to < 0 || from === to) return currentItems;
  const movedStatusItems = [...statusItems];
  const [moved] = movedStatusItems.splice(from, 1);
  if (!moved) return currentItems;
  movedStatusItems.splice(to, 0, moved);
  return statuses.flatMap((entryStatus) => (entryStatus === status ? movedStatusItems : grouped[entryStatus]));
}

export function reorderItemsForDrop<T extends BoardOrderItem>(
  currentItems: T[],
  activeId: string,
  overId: string,
) {
  const active = currentItems.find((item) => item.id === activeId);
  const targetStatus = statusForDropTarget(currentItems, overId);
  if (!active || !targetStatus) return currentItems;

  const overItem = currentItems.find((item) => item.id === overId);
  if (overItem && overItem.status === active.status) {
    return moveWithinStatus(currentItems, activeId, overId, active.status);
  }
  return moveIntoStatus(currentItems, activeId, targetStatus, overItem?.id ?? null);
}

export function previewDragOver<T extends BoardOrderItem>(
  currentItems: T[],
  activeId: string,
  overId: string,
) {
  const active = currentItems.find((item) => item.id === activeId);
  const targetStatus = statusForDropTarget(currentItems, overId);
  if (!active || !targetStatus) return currentItems;

  const overItem = currentItems.find((item) => item.id === overId);
  if (overItem && overItem.id !== activeId && overItem.status === active.status) {
    return moveWithinStatus(currentItems, activeId, overId, active.status);
  }
  if (active.status === targetStatus) return currentItems;
  return moveIntoStatus(currentItems, activeId, targetStatus, overItem?.id ?? null);
}
