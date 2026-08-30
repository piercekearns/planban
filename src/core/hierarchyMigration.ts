import type { PlanbanRoadmap, PlanbanStatus } from "./types";
import { compareHierarchyOrderPaths, hierarchyOrderPathById } from "./hierarchyOrder";

const STATUS_ORDER: PlanbanStatus[] = ["in-progress", "up-next", "pending", "complete", "archived"];

export function flattenRoadmapForVersion1(roadmap: PlanbanRoadmap) {
  const priorityByStatus = new Map<PlanbanStatus, number>();
  const orderPathById = hierarchyOrderPathById(roadmap.roadmapItems);
  const ordered = [...roadmap.roadmapItems].sort((a, b) => compareHierarchyOrderPaths(orderPathById.get(a.id) ?? [], orderPathById.get(b.id) ?? []) || a.id.localeCompare(b.id));
  return {
    version: 1 as const,
    revision: roadmap.revision,
    updatedAt: roadmap.updatedAt,
    project: roadmap.project,
    columns: roadmap.columns,
    roadmapItems: STATUS_ORDER.flatMap((status) => ordered.filter((item) => item.status === status)).map((item) => {
      const priority = (priorityByStatus.get(item.status) ?? 0) + 1;
      priorityByStatus.set(item.status, priority);
      const { isGroup: _isGroup, parentId: _parentId, boardRank: _boardRank, groupRank: _groupRank, ...legacy } = item;
      return { ...legacy, priority };
    }),
  };
}

export function hierarchyRecoveryManifest(roadmap: PlanbanRoadmap, historyVersion: number) {
  return {
    version: 1 as const,
    sourceRoadmapVersion: roadmap.version,
    sourceWriterVersion: roadmap.writerVersion,
    sourceRevision: roadmap.revision,
    historyVersion,
    items: roadmap.roadmapItems.map((item) => ({
      id: item.id,
      parentId: item.parentId,
      isGroup: item.isGroup,
      boardRank: item.boardRank,
      groupRank: item.groupRank,
    })),
  };
}
