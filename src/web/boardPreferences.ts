import type { Status } from "./boardOrdering";

export interface BoardViewPreferences {
  collapsed?: Partial<Record<Status, boolean>>;
  hiddenCards?: Partial<Record<Status, boolean>>;
  showArchived?: boolean;
}

export interface NormalizedBoardViewPreferences {
  collapsed: Partial<Record<Status, boolean>>;
  hiddenCards: Partial<Record<Status, boolean>>;
  showArchived: boolean;
}

const defaultHiddenCards: Partial<Record<Status, boolean>> = {
  complete: true,
};

export function normalizeBoardViewPreferences(preferences: BoardViewPreferences = {}): NormalizedBoardViewPreferences {
  return {
    collapsed: preferences.collapsed ?? {},
    hiddenCards: {
      ...defaultHiddenCards,
      ...(preferences.hiddenCards ?? {}),
    },
    showArchived: preferences.showArchived === true,
  };
}

export function boardViewPreferencesKey(repoId: string) {
  return `planban:board-view:${repoId}:v1`;
}
