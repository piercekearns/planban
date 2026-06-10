import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { defaultPlanningRoot, manifestPath, roadmapPath } from "./paths";
import { registerBoardFromState } from "./registry";
import { initializeProject, pathExists, saveRoadmap } from "./storage";
import type { PlanbanRoadmap, PlanbanRoadmapItem, PlanbanStatus } from "./types";

const t3ManifestSchema = z.object({
  version: z.number(),
  repoId: z.string().min(1),
  enabled: z.boolean().optional(),
});

const t3ItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.string().min(1),
    priority: z.number().nullable().optional(),
    summary: z.string().nullable().optional(),
    nextAction: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    icon: z.string().nullable().optional(),
    blockedBy: z.string().nullable().optional(),
    specDoc: z.string().nullable().optional(),
    planDoc: z.string().nullable().optional(),
    completedAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .passthrough();

const t3RoadmapSchema = z
  .object({
    version: z.number(),
    updatedAt: z.string(),
    project: z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      description: z.string().optional().nullable(),
      tags: z.array(z.string()).optional(),
    }),
    roadmapItems: z.array(t3ItemSchema),
  })
  .passthrough();

const statusMap: Record<string, PlanbanStatus> = {
  "in-progress": "in-progress",
  "up-next": "up-next",
  pending: "pending",
  complete: "complete",
  archived: "archived",
  shipped: "complete",
};

export interface ImportT3Report {
  sourceRepo: string;
  sourceRepoId: string;
  sourceRoadmapPath: string;
  destinationRepo: string;
  destinationPlanningRoot: string;
  destinationRoadmapPath: string;
  dryRun: boolean;
  cards: number;
  specs: number;
  plans: number;
  archived: number;
  warnings: string[];
}

function readJsonFile(path: string) {
  return readFile(path, "utf8").then((raw) => JSON.parse(raw) as unknown);
}

type T3RoadmapItem = z.infer<typeof t3ItemSchema>;

function mapItem(input: T3RoadmapItem, warnings: string[]): PlanbanRoadmapItem {
  const status = statusMap[input.status];
  if (!status) {
    warnings.push(`Card ${input.id} had unknown status "${input.status}"; imported as pending.`);
  }

  return {
    id: input.id,
    title: input.title,
    status: status ?? "pending",
    priority: input.priority ?? null,
    summary: input.summary ?? null,
    nextAction: input.nextAction ?? null,
    tags: input.tags ?? [],
    icon: input.icon ?? null,
    blockedBy: input.blockedBy ?? null,
    specDoc: input.specDoc ?? null,
    planDoc: input.planDoc ?? null,
    completedAt: input.completedAt ?? null,
    updatedAt: input.updatedAt ?? null,
    metadata: Object.fromEntries(
      Object.entries(input).filter(
        ([key]) =>
          ![
            "id",
            "title",
            "status",
            "priority",
            "summary",
            "nextAction",
            "tags",
            "icon",
            "blockedBy",
            "specDoc",
            "planDoc",
            "completedAt",
            "updatedAt",
          ].includes(key),
      ),
    ),
  };
}

async function materializeDoc(input: {
  sourcePlanningRoot: string;
  sourceRepo: string;
  destinationRoot: string;
  item: PlanbanRoadmapItem;
  sourceRelative: string | null;
  kind: "spec" | "plan";
  dryRun: boolean;
  warnings: string[];
}): Promise<string | null> {
  if (!input.sourceRelative) return null;

  const destinationRelative = `items/${input.item.id}/${input.kind}.md`;
  const destination = resolve(input.destinationRoot, destinationRelative);
  const candidates = isAbsolute(input.sourceRelative)
    ? [input.sourceRelative]
    : [resolve(input.sourcePlanningRoot, input.sourceRelative), resolve(input.sourceRepo, input.sourceRelative)];
  let source: string | null = null;
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      source = candidate;
      break;
    }
  }

  if (!source) {
    input.warnings.push(
      `Card ${input.item.id} referenced missing ${input.kind} doc "${input.sourceRelative}"; no Planban ${input.kind} doc was created.`,
    );
    return null;
  }

  if (!input.dryRun) {
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  return destinationRelative;
}

export async function importT3(input: {
  from: string;
  dryRun: boolean;
  updateAgents?: boolean;
}): Promise<ImportT3Report> {
  const sourceRepo = resolve(input.from);
  const t3ManifestPath = join(sourceRepo, ".t3plan", "project.json");
  if (!(await pathExists(t3ManifestPath))) {
    throw new Error(`T3 manifest not found at ${t3ManifestPath}`);
  }

  const manifest = t3ManifestSchema.parse(await readJsonFile(t3ManifestPath));
  const sourcePlanningRoot = join(process.env.T3PLAN_ROOT ?? join(process.env.HOME ?? "", ".t3plan"), "repos", manifest.repoId);
  const sourceRoadmapPath = join(sourcePlanningRoot, "roadmap.json");
  const t3Roadmap = t3RoadmapSchema.parse(await readJsonFile(sourceRoadmapPath));
  const destinationRoot = defaultPlanningRoot(manifest.repoId);
  const warnings: string[] = [];
  const items: PlanbanRoadmapItem[] = [];
  let specs = 0;
  let plans = 0;

  for (const sourceItem of t3Roadmap.roadmapItems) {
    const item = mapItem(sourceItem, warnings);
    const specDoc = await materializeDoc({
      sourcePlanningRoot,
      sourceRepo,
      destinationRoot,
      item,
      sourceRelative: item.specDoc,
      kind: "spec",
      dryRun: input.dryRun,
      warnings,
    });
    const planDoc = await materializeDoc({
      sourcePlanningRoot,
      sourceRepo,
      destinationRoot,
      item,
      sourceRelative: item.planDoc,
      kind: "plan",
      dryRun: input.dryRun,
      warnings,
    });
    if (specDoc) specs += 1;
    if (planDoc) plans += 1;
    items.push({ ...item, specDoc, planDoc });
  }

  if (!input.dryRun) {
    const state = await initializeProject({
      cwd: sourceRepo,
      repoId: manifest.repoId,
      title: t3Roadmap.project.title,
      ...(input.updateAgents !== undefined ? { updateAgents: input.updateAgents } : {}),
    });
    const roadmap: PlanbanRoadmap = {
      version: 1,
      revision: 1,
      updatedAt: t3Roadmap.updatedAt,
      project: {
        id: t3Roadmap.project.id,
        title: t3Roadmap.project.title,
        status: t3Roadmap.project.status,
        description: t3Roadmap.project.description ?? "",
        tags: t3Roadmap.project.tags ?? [],
      },
      columns: state.roadmap.columns,
      roadmapItems: items,
    };
    const savedRoadmap = await saveRoadmap(state, roadmap);
    await registerBoardFromState({ ...state, roadmap: savedRoadmap });
  }

  return {
    sourceRepo,
    sourceRepoId: manifest.repoId,
    sourceRoadmapPath,
    destinationRepo: sourceRepo,
    destinationPlanningRoot: destinationRoot,
    destinationRoadmapPath: roadmapPath(destinationRoot),
    dryRun: input.dryRun,
    cards: items.length,
    specs,
    plans,
    archived: items.filter((item) => item.status === "archived").length,
    warnings,
  };
}
