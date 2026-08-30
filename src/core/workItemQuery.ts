import { PLANBAN_STATUSES, type PlanbanStatus } from "./types";

export const PLANBAN_PROJECTIONS = ["main", "group", "flattened"] as const;
export const PLANBAN_HIERARCHY_SCOPES = ["projection", "root", "owned", "leaf", "selected-group"] as const;
export const PLANBAN_GROUP_ROLES = ["any", "group", "item-only"] as const;
export const PLANBAN_BLOCKED_FILTERS = ["any", "blocked", "unblocked"] as const;

export type PlanbanProjection = (typeof PLANBAN_PROJECTIONS)[number];
export type PlanbanHierarchyScope = (typeof PLANBAN_HIERARCHY_SCOPES)[number];
export type PlanbanGroupRole = (typeof PLANBAN_GROUP_ROLES)[number];
export type PlanbanBlockedFilter = (typeof PLANBAN_BLOCKED_FILTERS)[number];

export interface WorkItemQuery {
  search?: string | undefined;
  projection?: PlanbanProjection | undefined;
  groupId?: string | null | undefined;
  hierarchyScope?: PlanbanHierarchyScope | undefined;
  groupRole?: PlanbanGroupRole | undefined;
  statuses?: PlanbanStatus[] | undefined;
  blocked?: PlanbanBlockedFilter | undefined;
  tags?: string[] | undefined;
}

export class PlanbanQueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanbanQueryValidationError";
  }
}

function parameterValues(params: URLSearchParams, name: string) {
  return params.getAll(name).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

export function workItemQueryFromSearchParams(params: URLSearchParams): WorkItemQuery {
  const rawProjection = params.get("projection") ?? undefined;
  const rawHierarchyScope = params.get("scope") ?? undefined;
  const rawGroupRole = params.get("groupRole") ?? params.get("programmeRole") ?? undefined;
  const projection = rawProjection === "programme" ? "group" : rawProjection;
  const hierarchyScope = rawHierarchyScope === "selected-programme" ? "selected-group" : rawHierarchyScope;
  const groupRole = rawGroupRole === "programme" ? "group" : rawGroupRole === "deliverable-only" ? "item-only" : rawGroupRole;
  const blocked = params.get("blocked") ?? undefined;
  return validateWorkItemQuery({
    search: params.get("q") ?? undefined,
    projection: projection as PlanbanProjection | undefined,
    groupId: params.get("groupId") ?? params.get("programmeId") ?? undefined,
    hierarchyScope: hierarchyScope as PlanbanHierarchyScope | undefined,
    groupRole: groupRole as PlanbanGroupRole | undefined,
    statuses: parameterValues(params, "status") as PlanbanStatus[],
    blocked: blocked as PlanbanBlockedFilter | undefined,
    tags: parameterValues(params, "tag"),
  });
}

export interface NormalizedWorkItemQuery {
  search: string;
  projection: PlanbanProjection;
  groupId: string | null;
  hierarchyScope: PlanbanHierarchyScope;
  groupRole: PlanbanGroupRole;
  statuses: PlanbanStatus[];
  blocked: PlanbanBlockedFilter;
  tags: string[];
}

export interface QueryableWorkItem {
  id: string;
  title: string;
  status: PlanbanStatus;
  summary?: string | null | undefined;
  nextAction?: string | null | undefined;
  tags: string[];
  blockedBy?: string | null | undefined;
  isGroup?: boolean | undefined;
  parentId?: string | null | undefined;
  boardRank?: number | null | undefined;
  groupRank?: number | null | undefined;
}

export interface WorkItemQueryEntry<T extends QueryableWorkItem> {
  item: T;
  ancestry: T[];
  kind: "match" | "context";
}

function uniqueKnown<T extends string>(values: readonly string[] | undefined, known: readonly T[]): T[] {
  return [...new Set((values ?? []).filter((value): value is T => known.includes(value as T)))];
}

export function normalizeWorkItemQuery(query: WorkItemQuery = {}): NormalizedWorkItemQuery {
  return {
    search: query.search?.trim().toLocaleLowerCase() ?? "",
    projection: PLANBAN_PROJECTIONS.includes(query.projection as PlanbanProjection) ? query.projection! : "main",
    groupId: query.groupId?.trim() || null,
    hierarchyScope: PLANBAN_HIERARCHY_SCOPES.includes(query.hierarchyScope as PlanbanHierarchyScope) ? query.hierarchyScope! : "projection",
    groupRole: PLANBAN_GROUP_ROLES.includes(query.groupRole as PlanbanGroupRole) ? query.groupRole! : "any",
    statuses: uniqueKnown(query.statuses, PLANBAN_STATUSES),
    blocked: PLANBAN_BLOCKED_FILTERS.includes(query.blocked as PlanbanBlockedFilter) ? query.blocked! : "any",
    tags: [...new Set((query.tags ?? []).map((tag) => tag.trim().toLocaleLowerCase()).filter(Boolean))].sort(),
  };
}

function assertKnown(value: string | undefined, known: readonly string[], name: string) {
  if (value !== undefined && !known.includes(value)) {
    throw new PlanbanQueryValidationError(`Invalid ${name}: ${value}. Expected one of: ${known.join(", ")}.`);
  }
}

export function validateWorkItemQuery(query: WorkItemQuery = {}): NormalizedWorkItemQuery {
  assertKnown(query.projection, PLANBAN_PROJECTIONS, "projection");
  assertKnown(query.hierarchyScope, PLANBAN_HIERARCHY_SCOPES, "hierarchy scope");
  assertKnown(query.groupRole, PLANBAN_GROUP_ROLES, "Group role");
  assertKnown(query.blocked, PLANBAN_BLOCKED_FILTERS, "blocked filter");
  for (const status of query.statuses ?? []) assertKnown(status, PLANBAN_STATUSES, "status");
  return normalizeWorkItemQuery(query);
}

function hasCriteria(query: NormalizedWorkItemQuery) {
  return Boolean(
    query.search ||
    query.hierarchyScope !== "projection" ||
    query.groupRole !== "any" ||
    query.statuses.length ||
    query.blocked !== "any" ||
    query.tags.length,
  );
}

function compareNumberPaths(a: readonly number[], b: readonly number[]) {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return 0;
}

export function queryWorkItems<T extends QueryableWorkItem>(source: readonly T[], input: WorkItemQuery = {}) {
  const query = validateWorkItemQuery(input);
  const byId = new Map(source.map((item) => [item.id, item]));
  const childrenByParent = new Map<string | null, T[]>();
  for (const item of source) {
    const parentId = item.parentId ?? null;
    const siblings = childrenByParent.get(parentId) ?? [];
    siblings.push(item);
    childrenByParent.set(parentId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => {
      const status = PLANBAN_STATUSES.indexOf(a.status) - PLANBAN_STATUSES.indexOf(b.status);
      const rank = (a.parentId ? a.groupRank : a.boardRank) ?? Number.MAX_SAFE_INTEGER;
      const otherRank = (b.parentId ? b.groupRank : b.boardRank) ?? Number.MAX_SAFE_INTEGER;
      return status || rank - otherRank || a.id.localeCompare(b.id);
    });
  }

  const ancestryById = new Map<string, T[]>();
  const itemsOfGroup = new Set<string>();
  for (const item of source) {
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
    if (query.groupId && item.parentId === query.groupId) itemsOfGroup.add(item.id);
  }

  const criteriaActive = hasCriteria(query);
  let candidates = source.filter((item) => {
    if (query.projection === "group") return Boolean(query.groupId && itemsOfGroup.has(item.id));
    if (!criteriaActive && query.projection === "main") return item.parentId === null;
    return true;
  });
  if (!criteriaActive && query.projection === "group") {
    candidates = candidates.filter((item) => item.parentId === query.groupId);
  }

  const searchMatches = (item: T) => {
    if (!query.search) return true;
    return [item.id, item.title, item.summary, item.nextAction, ...item.tags]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLocaleLowerCase().includes(query.search));
  };
  const matchesScope = (item: T) => {
    if (query.hierarchyScope === "root") return item.parentId === null;
    if (query.hierarchyScope === "owned") return item.parentId !== null;
    if (query.hierarchyScope === "leaf") return (childrenByParent.get(item.id)?.length ?? 0) === 0;
    if (query.hierarchyScope === "selected-group") return Boolean(query.groupId && itemsOfGroup.has(item.id));
    return true;
  };
  const matches = candidates.filter((item) => {
    if (!searchMatches(item) || !matchesScope(item)) return false;
    if (query.groupRole === "group" && !item.isGroup) return false;
    if (query.groupRole === "item-only" && item.isGroup) return false;
    if (query.statuses.length && !query.statuses.includes(item.status)) return false;
    if (query.blocked === "blocked" && !item.blockedBy) return false;
    if (query.blocked === "unblocked" && item.blockedBy) return false;
    const itemTags = new Set(item.tags.map((tag) => tag.toLocaleLowerCase()));
    return query.tags.every((tag) => itemTags.has(tag));
  });

  const statusPath = (item: T) => {
    const lineage = [...(ancestryById.get(item.id) ?? []), item];
    return lineage.flatMap((entry) => [
      PLANBAN_STATUSES.indexOf(entry.status),
      (entry.parentId ? entry.groupRank : entry.boardRank) ?? Number.MAX_SAFE_INTEGER,
    ]);
  };
  matches.sort((a, b) => PLANBAN_STATUSES.indexOf(a.status) - PLANBAN_STATUSES.indexOf(b.status) || compareNumberPaths(statusPath(a), statusPath(b)) || a.id.localeCompare(b.id));

  const matchIds = new Set(matches.map((item) => item.id));
  const contextIds = new Set<string>();
  for (const match of matches) {
    for (const ancestor of ancestryById.get(match.id) ?? []) {
      if (query.projection === "group" && ancestor.id === query.groupId) continue;
      if (!matchIds.has(ancestor.id)) contextIds.add(ancestor.id);
    }
  }

  const includedIds = new Set([...matchIds, ...contextIds]);
  const visibleItems: T[] = [];
  const visit = (parentId: string | null) => {
    for (const item of childrenByParent.get(parentId) ?? []) {
      if (includedIds.has(item.id)) visibleItems.push(item);
      visit(item.id);
    }
  };
  if (query.projection === "group" && query.groupId) visit(query.groupId);
  else visit(null);

  const entry = (item: T): WorkItemQueryEntry<T> => ({
    item,
    ancestry: ancestryById.get(item.id) ?? [],
    kind: matchIds.has(item.id) ? "match" : "context",
  });
  const counts = Object.fromEntries(PLANBAN_STATUSES.map((status) => [status, matches.filter((item) => item.status === status).length])) as Record<PlanbanStatus, number>;
  return {
    query,
    matches: matches.map(entry),
    context: visibleItems.filter((item) => contextIds.has(item.id)).map(entry),
    visible: visibleItems.map(entry),
    counts,
    wip: counts["in-progress"],
  };
}
