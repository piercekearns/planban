import { statuses, type Status } from "./boardOrdering";

export interface GroupWorkspaceProjectionItem {
  id: string;
  status: Status;
  parentId?: string | null;
  groupRank?: number | null;
}

export function groupWorkspaceProjection<T extends GroupWorkspaceProjectionItem>(items: readonly T[], groupId: string) {
  const directChildren = items
    .filter((item) => item.parentId === groupId)
    .sort((a, b) => statuses.indexOf(a.status) - statuses.indexOf(b.status)
      || (a.groupRank ?? Number.MAX_SAFE_INTEGER) - (b.groupRank ?? Number.MAX_SAFE_INTEGER));
  const grouped = {
    "in-progress": [] as T[],
    "up-next": [] as T[],
    pending: [] as T[],
    complete: [] as T[],
    archived: [] as T[],
  };
  for (const item of directChildren) grouped[item.status].push(item);
  const counts = Object.fromEntries(statuses.map((status) => [status, grouped[status].length])) as Record<Status, number>;
  return {
    items: directChildren,
    grouped,
    counts,
    wip: counts["in-progress"],
  };
}
