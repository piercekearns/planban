export const PLANBAN_STATUSES = [
  "in-progress",
  "up-next",
  "pending",
  "complete",
  "archived",
] as const;

export type PlanbanStatus = (typeof PLANBAN_STATUSES)[number];

export interface PlanbanProjectManifest {
  version: 1;
  repoId: string;
  enabled: boolean;
  storage?: {
    kind: "local";
    root?: string | undefined;
  } | undefined;
}

export interface PlanbanProject {
  id: string;
  title: string;
  status: string;
  description: string;
  tags: string[];
}

export interface PlanbanColumn {
  id: PlanbanStatus;
  label: string;
}

export interface PlanbanRoadmapItem {
  id: string;
  title: string;
  status: PlanbanStatus;
  priority: number | null;
  summary: string | null;
  nextAction: string | null;
  tags: string[];
  icon: string | null;
  blockedBy: string | null;
  specDoc: string | null;
  planDoc: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  metadata?: Record<string, unknown>;
}

export interface PlanbanRoadmap {
  version: 1;
  revision: number;
  updatedAt: string;
  project: PlanbanProject;
  columns: PlanbanColumn[];
  roadmapItems: PlanbanRoadmapItem[];
}

export interface PlanbanResolvedState {
  cwd: string;
  manifestPath: string;
  agentContextPath: string;
  planningRoot: string;
  roadmapPath: string;
  manifest: PlanbanProjectManifest;
  roadmap: PlanbanRoadmap;
}

export interface PlanbanDocPayload {
  cardId: string;
  kind: "spec" | "plan";
  path: string | null;
  exists: boolean;
  markdown: string;
  mtimeMs: number | null;
}

export type PlanbanHistoryActor = "user" | "agent" | "import" | "system";

export interface PlanbanHistoryDocRef {
  cardId: string;
  kind: "spec" | "plan";
  path: string | null;
}

export interface PlanbanHistoryEntry {
  version: number;
  roadmapRevision: number;
  createdAt: string;
  actor: PlanbanHistoryActor;
  operation: string;
  summary: string;
  affectedCards: string[];
  affectedDocs: PlanbanHistoryDocRef[];
}

export interface PlanbanHistoryIndex {
  version: 1;
  latestVersion: number;
  retention: {
    boardVersions: number;
    cardVersions: number;
    documentVersions: number;
    maxAgeDays: number;
  };
  entries: PlanbanHistoryEntry[];
}

export interface PlanbanHistoryPayload {
  currentVersion: number;
  retention: PlanbanHistoryIndex["retention"];
  entries: PlanbanHistoryEntry[];
}

export interface PlanbanBoardRecord {
  repoId: string;
  title: string;
  cwd: string;
  planningRoot: string;
  roadmapPath: string;
  manifestPath: string;
  lastOpenedAt: string;
  updatedAt: string;
}

export interface PlanbanBoardRegistry {
  version: 1;
  boards: PlanbanBoardRecord[];
}
