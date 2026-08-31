export interface LiveVersionSnapshot {
  stateVersion: number;
  boardsVersion: number;
}

export interface LiveRefreshDecision {
  refreshBoards: boolean;
  refreshSelectedBoard: boolean;
}

export function liveRefreshDecision(
  previous: LiveVersionSnapshot | null,
  current: LiveVersionSnapshot,
): LiveRefreshDecision {
  if (!previous) {
    return { refreshBoards: true, refreshSelectedBoard: true };
  }
  return {
    refreshBoards: current.boardsVersion !== previous.boardsVersion,
    refreshSelectedBoard: current.stateVersion !== previous.stateVersion,
  };
}
