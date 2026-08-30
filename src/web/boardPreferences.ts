import type { Status } from "./boardOrdering";
import { normalizeWorkItemQuery, workItemQueryFromSearchParams, type PlanbanBlockedFilter, type PlanbanHierarchyScope, type PlanbanGroupRole } from "../core/workItemQuery";

export interface BoardViewPreferences {
  collapsed?: Partial<Record<Status, boolean>>;
  hiddenCards?: Partial<Record<Status, boolean>>;
  showArchived?: boolean;
  expandedGroupIds?: string[];
  groupId?: string | null;
  /** @deprecated Read-only compatibility for preferences saved before Group terminology. */
  expandedProgrammeIds?: string[];
  /** @deprecated Read-only compatibility for preferences saved before Group terminology. */
  programmeId?: string | null;
  projection?: "main" | "flattened";
  hierarchyScope?: PlanbanHierarchyScope;
  groupRole?: PlanbanGroupRole;
  filterStatuses?: Status[];
  blockedFilter?: PlanbanBlockedFilter;
  filterTags?: string[];
}

export interface NormalizedBoardViewPreferences {
  collapsed: Partial<Record<Status, boolean>>;
  hiddenCards: Partial<Record<Status, boolean>>;
  showArchived: boolean;
  expandedGroupIds: string[];
  groupId: string | null;
  projection: "main" | "flattened";
  hierarchyScope: PlanbanHierarchyScope;
  groupRole: PlanbanGroupRole;
  filterStatuses: Status[];
  blockedFilter: PlanbanBlockedFilter;
  filterTags: string[];
}

const defaultHiddenCards: Partial<Record<Status, boolean>> = {
  complete: true,
};

export function normalizeBoardViewPreferences(preferences: BoardViewPreferences = {}): NormalizedBoardViewPreferences {
  const expandedGroupIds = preferences.expandedGroupIds ?? preferences.expandedProgrammeIds;
  const groupId = preferences.groupId ?? preferences.programmeId;
  return {
    collapsed: preferences.collapsed ?? {},
    hiddenCards: {
      ...defaultHiddenCards,
      ...(preferences.hiddenCards ?? {}),
    },
    showArchived: preferences.showArchived === true,
    expandedGroupIds: Array.isArray(expandedGroupIds) ? expandedGroupIds.filter((id) => typeof id === "string") : [],
    groupId: typeof groupId === "string" && groupId.trim() ? groupId : null,
    projection: preferences.projection === "flattened" ? "flattened" : "main",
    hierarchyScope: ["root", "owned", "leaf", "selected-group"].includes(preferences.hierarchyScope ?? "") ? preferences.hierarchyScope! : "projection",
    groupRole: ["group", "item-only"].includes(preferences.groupRole ?? "") ? preferences.groupRole! : "any",
    filterStatuses: Array.isArray(preferences.filterStatuses) ? preferences.filterStatuses.filter((status): status is Status => ["in-progress", "up-next", "pending", "complete", "archived"].includes(status)) : [],
    blockedFilter: preferences.blockedFilter === "blocked" || preferences.blockedFilter === "unblocked" ? preferences.blockedFilter : "any",
    filterTags: Array.isArray(preferences.filterTags) ? [...new Set((preferences.filterTags as unknown[]).filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean))] : [],
  };
}

export function resolveBoardQueryState(preferences: BoardViewPreferences, params: URLSearchParams) {
  const normalizedPreferences = normalizeBoardViewPreferences(preferences);
  const hasUrlQuery = ["q", "projection", "groupId", "programmeId", "scope", "groupRole", "programmeRole", "status", "blocked", "tag"].some((name) => params.has(name));
  if (hasUrlQuery) {
    try {
      const query = normalizeWorkItemQuery(workItemQueryFromSearchParams(params));
      return {
        search: params.get("q") ?? "",
        hierarchyScope: query.hierarchyScope,
        groupRole: query.groupRole,
        statuses: query.statuses,
        blocked: query.blocked,
        tags: query.tags,
        error: null,
      };
    } catch (error) {
      const query = normalizeWorkItemQuery();
      return {
        search: "",
        hierarchyScope: query.hierarchyScope,
        groupRole: query.groupRole,
        statuses: query.statuses,
        blocked: query.blocked,
        tags: query.tags,
        error: error instanceof Error ? error.message : "Invalid Work Item query.",
      };
    }
  }
  return {
    search: "",
    hierarchyScope: normalizedPreferences.hierarchyScope,
    groupRole: normalizedPreferences.groupRole,
    statuses: normalizedPreferences.filterStatuses,
    blocked: normalizedPreferences.blockedFilter,
    tags: normalizedPreferences.filterTags,
    error: null,
  };
}

export function boardViewPreferencesKey(repoId: string) {
  return `planban:board-view:${repoId}:v1`;
}
