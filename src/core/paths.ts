import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const PROTOCOL_DIR = ".planban";
export const MANIFEST_FILE = "project.json";
export const AGENT_CONTEXT_FILE = "agent-context.md";
export const ROADMAP_FILE = "roadmap.json";
export const EVENTS_FILE = "events.ndjson";
export const INDEX_FILE = "index.json";
export const HISTORY_DIR = "history";
export const HISTORY_INDEX_FILE = "index.json";

export function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

export function defaultPlanbanRoot(): string {
  return process.env.PLANBAN_HOME ? resolve(expandHome(process.env.PLANBAN_HOME)) : join(homedir(), ".planban");
}

export function registryPath(): string {
  return join(defaultPlanbanRoot(), INDEX_FILE);
}

export function boardBackupsRoot(): string {
  return join(defaultPlanbanRoot(), "backups", "boards");
}

export function slugify(input: string): string {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

export function defaultRepoId(cwd: string): string {
  return slugify(basename(resolve(cwd)));
}

export function protocolDir(cwd: string): string {
  return join(resolve(cwd), PROTOCOL_DIR);
}

export function manifestPath(cwd: string): string {
  return join(protocolDir(cwd), MANIFEST_FILE);
}

export function agentContextPath(cwd: string): string {
  return join(protocolDir(cwd), AGENT_CONTEXT_FILE);
}

export function defaultPlanningRoot(repoId: string): string {
  return join(defaultPlanbanRoot(), "repos", repoId);
}

export function roadmapPath(planningRoot: string): string {
  return join(planningRoot, ROADMAP_FILE);
}

export function eventsPath(planningRoot: string): string {
  return join(planningRoot, EVENTS_FILE);
}

export function itemRoot(planningRoot: string, itemId: string): string {
  return join(planningRoot, "items", slugify(itemId));
}

export function historyRoot(planningRoot: string): string {
  return join(planningRoot, HISTORY_DIR);
}

export function historyIndexPath(planningRoot: string): string {
  return join(historyRoot(planningRoot), HISTORY_INDEX_FILE);
}

export function historyVersionRoot(planningRoot: string, version: number): string {
  return join(historyRoot(planningRoot), `v${String(version).padStart(4, "0")}`);
}

export function historyRoadmapPath(planningRoot: string, version: number): string {
  return join(historyVersionRoot(planningRoot, version), ROADMAP_FILE);
}

export function historyDocPath(planningRoot: string, version: number, cardId: string, kind: "spec" | "plan"): string {
  return join(historyVersionRoot(planningRoot, version), "docs", slugify(cardId), `${kind}.md`);
}
