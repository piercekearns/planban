import { statuses, type Status } from "./boardOrdering";

export interface HierarchyProjectionItem {
  id: string;
  title: string;
  status: Status;
  priority?: number | null;
  parentId?: string | null;
  boardRank?: number | null;
  groupRank?: number | null;
  isGroup?: boolean;
  blockedBy?: string | null;
  completedAt?: string | null;
}

export interface GroupRollup<T extends HierarchyProjectionItem> {
  total: number;
  complete: number;
  blocked: number;
  statusMix: Partial<Record<Status, number>>;
  previews: T[];
}

export interface GroupProgressSegment {
  status: Exclude<Status, "archived">;
  count: number;
  fraction: number;
}

const groupProgressOrder: GroupProgressSegment["status"][] = [
  "complete",
  "in-progress",
  "up-next",
  "pending",
];

export function groupProgressSegments(
  rollup: Pick<GroupRollup<HierarchyProjectionItem>, "total" | "statusMix">,
): GroupProgressSegment[] {
  const visibleTotal = rollup.total - (rollup.statusMix.archived ?? 0);
  if (visibleTotal <= 0) return [];
  return groupProgressOrder.flatMap((status) => {
    const count = rollup.statusMix[status] ?? 0;
    return count > 0 ? [{ status, count, fraction: count / visibleTotal }] : [];
  });
}

export function mainBoardProjection<T extends HierarchyProjectionItem>(items: readonly T[]): T[] {
  return items
    .filter((item) => item.parentId == null)
    .sort((a, b) => (a.boardRank ?? Number.MAX_SAFE_INTEGER) - (b.boardRank ?? Number.MAX_SAFE_INTEGER));
}

export function itemsInGroup<T extends HierarchyProjectionItem>(items: readonly T[], groupId: string): T[] {
  return items
    .filter((item) => item.parentId === groupId)
    .sort((a, b) => statuses.indexOf(a.status) - statuses.indexOf(b.status)
      || (a.groupRank ?? Number.MAX_SAFE_INTEGER) - (b.groupRank ?? Number.MAX_SAFE_INTEGER));
}

export function workItemRank(item: HierarchyProjectionItem): number | null {
  return item.boardRank ?? item.groupRank ?? item.priority ?? null;
}

export function groupRollup<T extends HierarchyProjectionItem>(items: readonly T[], groupId: string): GroupRollup<T> {
  const ownedItems = itemsInGroup(items, groupId);
  const statusMix: Partial<Record<Status, number>> = {};
  for (const item of ownedItems) statusMix[item.status] = (statusMix[item.status] ?? 0) + 1;
  const activePreviews = ownedItems.filter((item) => item.status !== "complete" && item.status !== "archived");
  const recentCompletions = ownedItems
    .filter((item) => item.status === "complete")
    .sort((a, b) => {
      const aCompletedAt = Date.parse(a.completedAt ?? "");
      const bCompletedAt = Date.parse(b.completedAt ?? "");
      if (Number.isFinite(aCompletedAt) && Number.isFinite(bCompletedAt) && aCompletedAt !== bCompletedAt) return bCompletedAt - aCompletedAt;
      if (Number.isFinite(aCompletedAt) !== Number.isFinite(bCompletedAt)) return Number.isFinite(aCompletedAt) ? -1 : 1;
      return (a.groupRank ?? Number.MAX_SAFE_INTEGER) - (b.groupRank ?? Number.MAX_SAFE_INTEGER);
    });
  const previews = [...activePreviews, ...recentCompletions].slice(0, 3);
  return {
    total: ownedItems.length,
    complete: ownedItems.filter((item) => item.status === "complete").length,
    blocked: ownedItems.filter((item) => Boolean(item.blockedBy)).length,
    statusMix,
    previews,
  };
}
