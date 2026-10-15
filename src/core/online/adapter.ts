import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { agentContextPath, defaultPlanbanRoot, manifestPath } from "../paths";
import { normalizeRoadmap, PlanbanNotFoundError, PlanbanValidationError } from "../boardOperations";
import { explainMissingBoard } from "./accounts";
import type { PlanbanProjectManifest, PlanbanResolvedState, PlanbanRoadmap } from "../types";
import { refreshBackup } from "./backup";
import { boardPath, onlineRequest } from "./client";
import { serviceUrl } from "./credentials";

export type OnlineStorage = Extract<NonNullable<PlanbanProjectManifest["storage"]>, { kind: "online" }>;

export function onlineCacheRoot(storage: OnlineStorage) {
  const service = createHash("sha256").update(serviceUrl(storage.url)).digest("hex").slice(0, 16);
  return join(defaultPlanbanRoot(), "online", "cache", service, `id-${encodeURIComponent(storage.boardId)}`);
}

export function onlineState(cwd: string, manifest: PlanbanProjectManifest, roadmap: PlanbanRoadmap): PlanbanResolvedState {
  if (manifest.storage?.kind !== "online") throw new Error("Expected an Online Board.");
  const planningRoot = onlineCacheRoot(manifest.storage);
  return { cwd, manifestPath: manifestPath(cwd), agentContextPath: agentContextPath(cwd), planningRoot,
    roadmapPath: join(planningRoot, "snapshot.json"), manifest, roadmap: normalizeRoadmap(roadmap) };
}

export async function loadOnlineState(cwd: string, manifest: PlanbanProjectManifest) {
  if (manifest.storage?.kind !== "online") throw new Error("Expected an Online Board.");
  const storage = manifest.storage;
  const { roadmap } = await onlineRequest<{ roadmap: PlanbanRoadmap }>(storage.url, boardPath(storage.boardId)).catch(async (error: unknown) => {
    // "Not found" may only mean another account is signed in here: this computer's own records can tell.
    if (error instanceof PlanbanNotFoundError) return explainMissingBoard(storage.url, storage.boardId, error);
    throw error;
  });
  void refreshBackup(manifest.storage.url, manifest.storage.boardId);
  return onlineState(cwd, manifest, roadmap);
}

export async function onlineOperation<T>(cwd: string, manifest: PlanbanProjectManifest, op: string, input: { cwd: string; idempotencyKey?: string | undefined }) {
  if (manifest.storage?.kind !== "online") throw new Error("Expected an Online Board.");
  const { cwd: _cwd, idempotencyKey, ...rest } = input as { cwd: string; idempotencyKey?: string | undefined; actor?: unknown };
  // As on a local board, an edit that doesn't say who made it is the person's
  // own (the board page); agent tools always say "agent", so the service
  // applies the person's agent setting and the completion rule to them.
  const body = { ...rest, actor: rest.actor ?? "user" };
  // One key per logical edit: a retry after a lost response cannot apply it twice.
  const response = await onlineRequest<{ roadmap: PlanbanRoadmap; result: T; replayed?: boolean; originalRevision?: number }>(manifest.storage.url, boardPath(manifest.storage.boardId, `/ops/${op}`), body,
    { idempotencyKey: idempotencyKey ?? randomUUID() });
  // Every machine that changes an Online Board keeps a local backup of it.
  void refreshBackup(manifest.storage.url, manifest.storage.boardId);
  const state = onlineState(cwd, manifest, response.roadmap);
  if (response.replayed) state.onlineReplay = { replayed: true, ...(response.originalRevision === undefined ? {} : { originalRevision: response.originalRevision }) };
  return { state, result: response.result };
}

export function refuseOnline(operation: string): never {
  throw new PlanbanValidationError(`${operation} is not yet available for Online Boards.`);
}
