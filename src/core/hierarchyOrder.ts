import { PLANBAN_STATUSES, type PlanbanStatus } from "./types";

export interface HierarchyOrderedItem {
  id: string;
  status: PlanbanStatus;
  parentId?: string | null;
  boardRank?: number | null;
  groupRank?: number | null;
}

export function compareHierarchyOrderPaths(a: readonly number[], b: readonly number[]) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

export function hierarchyOrderPathById<T extends HierarchyOrderedItem>(items: readonly T[]) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const paths = new Map<string, number[]>();
  for (const item of items) {
    const lineage: T[] = [item];
    const seen = new Set([item.id]);
    let parentId = item.parentId;
    while (parentId && !seen.has(parentId)) {
      const parent = byId.get(parentId);
      if (!parent) break;
      seen.add(parent.id);
      lineage.unshift(parent);
      parentId = parent.parentId;
    }
    paths.set(item.id, lineage.flatMap((entry, index) => [
      PLANBAN_STATUSES.indexOf(entry.status),
      index === 0
        ? entry.boardRank ?? entry.groupRank ?? Number.MAX_SAFE_INTEGER
        : entry.groupRank ?? Number.MAX_SAFE_INTEGER,
    ]));
  }
  return paths;
}
