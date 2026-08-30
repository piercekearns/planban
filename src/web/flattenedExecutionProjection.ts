import { statuses, type Status } from "./boardOrdering";
import { compareHierarchyOrderPaths, hierarchyOrderPathById } from "../core/hierarchyOrder";

export interface FlattenedExecutionItem {
  id: string;
  status: Status;
  parentId?: string | null;
  boardRank?: number | null;
  groupRank?: number | null;
}

export function flattenedExecutionMoveForDrop<T extends FlattenedExecutionItem>(
  items: readonly T[],
  activeId: string,
  overId: string,
): { status: Status } | null {
  const active = items.find((item) => item.id === activeId);
  const status = statuses.includes(overId as Status)
    ? overId as Status
    : items.find((item) => item.id === overId)?.status;
  if (!active || !status || status === active.status) return null;
  return { status };
}

export function flattenedExecutionProjection<T extends FlattenedExecutionItem>(items: readonly T[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ancestryById = new Map<string, T[]>();
  const orderPathById = hierarchyOrderPathById(items);

  for (const item of items) {
    const ancestry: T[] = [];
    const seen = new Set([item.id]);
    let parentId = item.parentId;
    while (parentId && !seen.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent) break;
      seen.add(parent.id);
      ancestry.unshift(parent);
      parentId = parent.parentId;
    }
    ancestryById.set(item.id, ancestry);
  }

  const grouped = {
    "in-progress": [] as T[],
    "up-next": [] as T[],
    pending: [] as T[],
    complete: [] as T[],
    archived: [] as T[],
  };
  for (const item of items) grouped[item.status].push(item);
  for (const status of statuses) {
    grouped[status].sort((a, b) => compareHierarchyOrderPaths(orderPathById.get(a.id) ?? [], orderPathById.get(b.id) ?? []) || a.id.localeCompare(b.id));
  }
  const counts = Object.fromEntries(statuses.map((status) => [status, grouped[status].length])) as Record<Status, number>;
  return {
    items: statuses.flatMap((status) => grouped[status]),
    grouped,
    counts,
    wip: counts["in-progress"],
    ancestryById,
  };
}
