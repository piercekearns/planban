// Automatic local backup of Online Boards (owner decision 2). Every machine
// that uses an Online Board keeps a copy of its roadmap and documents under
// ~/.planban/online/backups/, refreshed after changes it sees (at most once a
// minute), with a daily copy kept for 30 days. The backup is never edited in
// place; `planban online restore-backup` turns it into a new local board.
//
// Refreshes are incremental: the history entries since the last backup say
// which documents changed, so only those are downloaded.
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PlanbanDocPayload, PlanbanHistoryPayload, PlanbanRoadmap } from "../types";
import { defaultPlanbanRoot } from "../paths";
import { atomicWriteFile, withBoardWriteLock } from "../persistence";
import { boardPath, onlineRequest } from "./client";
import { serviceUrl } from "./credentials";

const REFRESH_INTERVAL_MS = 60_000;
const DAILY_COPIES = 30;
const DOCS_PAGE = 100;

export interface BackupMeta {
  version: 1;
  url: string;
  boardId: string;
  revision: number;
  /** Newest history version whose document changes are in the backup. */
  historyVersion: number;
  savedAt: string;
}

export function backupRoot(url: string, boardId: string) {
  const service = createHash("sha256").update(serviceUrl(url)).digest("hex").slice(0, 16);
  return join(defaultPlanbanRoot(), "online", "backups", service, encodeURIComponent(boardId));
}

function docFile(root: string, cardId: string, kind: "spec" | "plan") {
  return join(root, "latest", "docs", `${encodeURIComponent(cardId)}.${kind}.md`);
}

async function readMeta(root: string): Promise<BackupMeta | null> {
  try {
    return JSON.parse(await readFile(join(root, "latest", "backup.json"), "utf8")) as BackupMeta;
  } catch {
    return null;
  }
}

const lastAttempt = new Map<string, number>();

/**
 * Brings the backup up to date. Called after this machine reads or changes
 * the board; does nothing if it ran within the last minute. Never throws:
 * a failed backup must not fail the user's edit.
 */
export async function refreshBackup(url: string, boardId: string, options: { force?: boolean } = {}): Promise<BackupMeta | null> {
  const root = backupRoot(url, boardId);
  if (!options.force && Date.now() - (lastAttempt.get(root) ?? 0) < REFRESH_INTERVAL_MS) return null;
  lastAttempt.set(root, Date.now());
  try {
    return await withBoardWriteLock(root, async () => {
      const previous = await readMeta(root);
      if (!options.force && previous && Date.now() - Date.parse(previous.savedAt) < REFRESH_INTERVAL_MS) return previous;
      const board = await onlineRequest<{ roadmap?: PlanbanRoadmap; unchanged?: boolean; revision?: number }>(
        url, boardPath(boardId, previous ? `?since=${previous.revision}` : ""));
      if (board.unchanged && previous) {
        const meta = { ...previous, savedAt: new Date().toISOString() };
        await atomicWriteFile(join(root, "latest", "backup.json"), JSON.stringify(meta, null, 2) + "\n");
        await keepDailyCopy(root);
        return meta;
      }
      const roadmap = board.roadmap!;
      const history = await onlineRequest<PlanbanHistoryPayload>(url, boardPath(boardId, `/history?after=${previous?.historyVersion ?? 0}`));
      const live = new Set(roadmap.roadmapItems.map((item) => item.id));
      // If versions since the last backup were pruned, or the board was taken
      // online again, the change list is incomplete: download every document.
      const oldest = Math.min(...history.entries.map((entry) => entry.version));
      const complete = previous && (history.entries.length === 0 || oldest === previous.historyVersion + 1)
        && !history.entries.some((entry) => entry.operation === "board.take-online");
      if (!complete) {
        await rm(join(root, "latest"), { recursive: true, force: true });
        for (let offset: number | null = 0; offset !== null;) {
          const page: { docs: Array<{ cardId: string; kind: "spec" | "plan"; markdown: string }>; nextOffset: number | null } =
            await onlineRequest(url, boardPath(boardId, `/export/docs?offset=${offset}&limit=${DOCS_PAGE}`));
          for (const doc of page.docs) await atomicWriteFile(docFile(root, doc.cardId, doc.kind), doc.markdown);
          offset = page.nextOffset;
        }
      } else {
        const changed = new Map<string, { cardId: string; kind: "spec" | "plan" }>();
        for (const entry of history.entries) {
          for (const doc of entry.affectedDocs) changed.set(`${doc.cardId}/${doc.kind}`, doc);
          for (const cardId of entry.affectedCards) {
            if (!live.has(cardId)) for (const kind of ["spec", "plan"] as const) await rm(docFile(root, cardId, kind), { force: true });
          }
        }
        for (const { cardId, kind } of changed.values()) {
          if (!live.has(cardId)) continue;
          const doc = await onlineRequest<PlanbanDocPayload>(url, boardPath(boardId, `/docs/${encodeURIComponent(cardId)}/${kind}`));
          if (doc.exists) await atomicWriteFile(docFile(root, cardId, kind), doc.markdown);
          else await rm(docFile(root, cardId, kind), { force: true });
        }
      }
      await atomicWriteFile(join(root, "latest", "roadmap.json"), JSON.stringify(roadmap, null, 2) + "\n");
      const meta: BackupMeta = {
        version: 1, url: serviceUrl(url), boardId, revision: roadmap.revision,
        historyVersion: Math.max(complete ? previous!.historyVersion : 0, ...history.entries.map((entry) => entry.version)),
        savedAt: new Date().toISOString(),
      };
      await atomicWriteFile(join(root, "latest", "backup.json"), JSON.stringify(meta, null, 2) + "\n");
      await keepDailyCopy(root);
      return meta;
    });
  } catch {
    return null;
  }
}

async function keepDailyCopy(root: string) {
  const today = new Date().toISOString().slice(0, 10);
  const daily = join(root, "daily");
  await mkdir(daily, { recursive: true });
  const days = (await readdir(daily)).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
  if (!days.includes(today)) {
    await cp(join(root, "latest"), join(daily, today), { recursive: true });
    days.push(today);
  }
  for (const day of days.slice(0, Math.max(0, days.length - DAILY_COPIES))) await rm(join(daily, day), { recursive: true, force: true });
}

/** Reads a backup (its latest copy, or one day's) as a board bundle without history. */
export async function readBackup(folder: string) {
  const roadmap = JSON.parse(await readFile(join(folder, "roadmap.json"), "utf8")) as PlanbanRoadmap;
  const docs: Array<{ cardId: string; kind: "spec" | "plan"; markdown: string }> = [];
  const names = await readdir(join(folder, "docs")).catch(() => [] as string[]);
  for (const name of names) {
    const match = /^(.*)\.(spec|plan)\.md$/.exec(name);
    if (!match) continue;
    docs.push({ cardId: decodeURIComponent(match[1]!), kind: match[2] as "spec" | "plan", markdown: await readFile(join(folder, "docs", name), "utf8") });
  }
  return { roadmap, docs };
}
