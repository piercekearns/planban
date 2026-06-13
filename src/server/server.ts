import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import chokidar from "chokidar";
import type { ViteDevServer } from "vite";
import { defaultPlanbanRoot } from "../core/paths";
import { ensureDemoBoard } from "../core/demo";
import {
  idempotencyFingerprint,
  PlanbanIdempotencyConflictError,
  runIdempotentBoardMutation,
} from "../core/persistence";
import { importT3 } from "../core/importT3";
import {
  archiveBoard,
  deleteBoard,
  listAllBoards,
  listBoards,
  registerBoardFromCwd,
  registerBoardFromState,
  resolveBoardCwd,
  restoreBoard,
  touchBoard,
} from "../core/registry";
import {
  getStatus,
  initializeProject,
  loadState,
  moveCard,
  PlanbanConflictError,
  readDoc,
  readHistoryDoc,
  reorderCards,
  restoreBoardVersion,
  restoreCardVersion,
  restoreDocVersion,
  saveRoadmap,
  setCardStatus,
  writeDoc,
  createCard,
  deleteArchivedCard,
  historyPayload,
  loadHistoryState,
} from "../core/storage";
import { PLANBAN_STATUSES, type PlanbanHistoryActor, type PlanbanRoadmapItem, type PlanbanStatus } from "../core/types";
import {
  compareVersions,
  currentVersionInfo,
  PLANBAN_UPDATE_MANIFEST_URL,
  type PlanbanUpdateManifest,
} from "../core/version";
import { updatePreflight } from "../core/updatePreflight";
import { runPlanbanUpdate, type UpdateRunSnapshot } from "../core/updateRunner";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_ROOT = resolve(PACKAGE_ROOT, "src/web");
const DIST_WEB_ROOT = resolve(PACKAGE_ROOT, "dist/web");
const DIST_WEB_INDEX = resolve(DIST_WEB_ROOT, "index.html");
const UPDATE_CHECK_TIMEOUT_MS = 3500;
const updateJobs = new Map<string, UpdateRunSnapshot>();

export interface ServeOptions {
  cwd: string;
  port: number;
  useVite: boolean;
}

function isStatus(value: string): value is PlanbanStatus {
  return PLANBAN_STATUSES.includes(value as PlanbanStatus);
}

function parseActor(value: unknown): PlanbanHistoryActor {
  return value === "agent" || value === "import" || value === "system" ? value : "user";
}

function openExternalUrl(url: string) {
  return new Promise<void>((resolveOpen, reject) => {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "darwin"
      ? [url]
      : process.platform === "win32"
        ? ["/c", "start", "", url]
        : [url];
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.unref();
    resolveOpen();
  });
}

function codexSessionsRoot() {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
}

function codexThreadUrl(threadId: string) {
  return `codex://threads/${threadId}`;
}

function readCodexThreadMeta(item: PlanbanRoadmapItem) {
  const metadata = item.metadata;
  const value = metadata && typeof metadata === "object" ? metadata.codexThread : null;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function updateItemCodexThreadMeta(
  item: PlanbanRoadmapItem,
  codexThread: Record<string, unknown>,
): PlanbanRoadmapItem {
  return {
    ...item,
    metadata: {
      ...(item.metadata ?? {}),
      codexThread: {
        ...readCodexThreadMeta(item),
        ...codexThread,
      },
    },
    updatedAt: new Date().toISOString(),
  };
}

function isUpdateManifest(value: unknown): value is PlanbanUpdateManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const postUpdateRoute = candidate.postUpdateRoute;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.version === "string" &&
    typeof candidate.pluginVersion === "string" &&
    typeof candidate.mcpVersion === "string" &&
    typeof candidate.storageSchemaVersion === "number" &&
    typeof candidate.minimumStorageSchemaVersion === "number" &&
    typeof candidate.publishedAt === "string" &&
    typeof candidate.sourceUrl === "string" &&
    typeof candidate.releaseNotesUrl === "string" &&
    (candidate.targetRef === undefined || typeof candidate.targetRef === "string") &&
    (candidate.targetCommit === undefined || typeof candidate.targetCommit === "string") &&
    typeof candidate.summary === "string" &&
    typeof candidate.updatePrompt === "string" &&
    (postUpdateRoute === undefined || postUpdateRoute === "tutorial" || postUpdateRoute === "board" || postUpdateRoute === "board-with-changelog") &&
    (candidate.tutorialVersion === undefined || typeof candidate.tutorialVersion === "number") &&
    (candidate.showTutorialWhenUpdatingFromBefore === undefined || typeof candidate.showTutorialWhenUpdatingFromBefore === "string") &&
    (candidate.changelogTitle === undefined || typeof candidate.changelogTitle === "string") &&
    (candidate.changelogSummary === undefined || typeof candidate.changelogSummary === "string")
  );
}

async function fetchLatestUpdateManifest(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);
  try {
    const requestUrl = new URL(url);
    requestUrl.searchParams.set("_", Date.now().toString());
    const response = await fetch(requestUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "planban-update-check",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Update metadata returned HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    if (!isUpdateManifest(payload)) throw new Error("Update metadata did not match the Planban manifest schema");
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function updateStatus() {
  const current = currentVersionInfo();
  const metadataUrl = process.env.PLANBAN_UPDATE_MANIFEST_URL || PLANBAN_UPDATE_MANIFEST_URL;
  const checkedAt = new Date().toISOString();
  try {
    const latest = await fetchLatestUpdateManifest(metadataUrl);
    const updateAvailable = compareVersions(latest.version, current.version) > 0;
    const compatible = latest.minimumStorageSchemaVersion <= current.storageSchemaVersion;
    return {
      checkedAt,
      metadataUrl,
      current,
      latest,
      updateAvailable,
      compatible,
      checkError: null,
    };
  } catch (error) {
    return {
      checkedAt,
      metadataUrl,
      current,
      latest: null,
      updateAvailable: false,
      compatible: true,
      checkError: error instanceof Error ? error.message : "Update check failed",
    };
  }
}

async function recentCodexSessionFiles(root = codexSessionsRoot()) {
  const files: Array<{ path: string; mtimeMs: number }> = [];
  const cutoffMs = Date.now() - 1000 * 60 * 60 * 24 * 14;

  async function visit(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs < cutoffMs) return;
      files.push({ path, mtimeMs: info.mtimeMs });
    }));
  }

  await visit(root);
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 500);
}

function threadIdFromSessionPath(path: string) {
  return path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1] ?? null;
}

async function findCodexThreadByLaunchToken(token: string) {
  if (!token.trim()) return null;
  const files = await recentCodexSessionFiles();
  for (const file of files) {
    const threadId = threadIdFromSessionPath(file.path);
    if (!threadId) continue;
    const content = await readFile(file.path, "utf8").catch(() => "");
    if (content.includes(token)) {
      return {
        threadId,
        threadUrl: codexThreadUrl(threadId),
        sessionPath: file.path,
      };
    }
  }
  return null;
}

export async function startServer(options: ServeOptions) {
  const cwd = resolve(options.cwd);
  const app = express();
  const server = createHttpServer(app);
  let vite: ViteDevServer | null = null;
  let watcher: ReturnType<typeof chokidar.watch> | null = null;
  const clients = new Set<express.Response>();
  const currentBoard = await registerBoardFromCwd(cwd).catch(() => null);

  app.use(express.json({ limit: "4mb" }));

  function sendEvent(event: string, data: unknown) {
    for (const client of clients) {
      client.write(`event: ${event}\n`);
      client.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  }

  async function closeServer() {
    for (const client of clients) {
      client.end();
    }
    clients.clear();
    await watcher?.close();
    await vite?.close();
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()));
    });
  }

  function scheduleRestartHandoff() {
    if (process.env.PLANBAN_DISABLE_AUTO_RESTART === "1") return;
    const scriptPath = resolve(PACKAGE_ROOT, "scripts/restart-planban-after-update.mjs");
    const restartLogFile = resolve(PACKAGE_ROOT, ".planban-restart.log");
    mkdirSync(dirname(restartLogFile), { recursive: true });
    const restartLogFd = openSync(restartLogFile, "a");
    const args = [
      scriptPath,
      "--parent-pid",
      String(process.pid),
      "--runtime-root",
      PACKAGE_ROOT,
      "--cwd",
      cwd,
      "--port",
      String(options.port),
    ];
    if (!options.useVite || existsSync(DIST_WEB_INDEX)) args.push("--no-vite");

    const child = spawn(process.execPath, args, {
      cwd: PACKAGE_ROOT,
      detached: true,
      stdio: ["ignore", restartLogFd, restartLogFd],
      env: {
        ...process.env,
        PLANBAN_RESTART_LOG_FILE: restartLogFile,
      },
    });
    child.unref();
    closeSync(restartLogFd);

    setTimeout(() => {
      const closeGracefully = closeServer();
      const forceExit = new Promise<void>((resolveForce) => {
        setTimeout(resolveForce, 2500);
      });
      void Promise.race([closeGracefully, forceExit]).finally(() => {
        process.exit(0);
      });
    }, 250);
  }

  function idempotencyKey(req: express.Request) {
    const header = req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
    if (header?.trim()) return header.trim();
    return typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey.trim() : undefined;
  }

  async function runApiMutation<T>(
    req: express.Request,
    cwdForMutation: string,
    run: () => Promise<T>,
  ): Promise<{ replayed: boolean; value: T }> {
    const status = await getStatus(cwdForMutation);
    if (!status.initialized || !status.planningRoot) {
      return { replayed: false, value: await run() };
    }
    return runIdempotentBoardMutation({
      planningRoot: status.planningRoot,
      idempotencyKey: idempotencyKey(req),
      scope: `${req.method} ${req.route?.path ?? req.path}`,
      fingerprint: idempotencyFingerprint({
        params: req.params,
        body: req.body ?? null,
      }),
      run,
    });
  }

  app.get("/api/events", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("\n");
    clients.add(res);
    res.on("close", () => clients.delete(res));
  });

  app.get("/api/status", async (_req, res, next) => {
    try {
      const status = await getStatus(cwd);
      res.json({ ...status, currentRepoId: currentBoard?.repoId ?? ("repoId" in status ? status.repoId : null) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/update-status", async (_req, res, next) => {
    try {
      res.json(await updateStatus());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/update-preflight", async (_req, res, next) => {
    try {
      res.json(await updatePreflight({ runtimeRoot: PACKAGE_ROOT }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/update-run", async (req, res, next) => {
    try {
      const status = await updateStatus();
      if (!status.latest || !status.updateAvailable) {
        res.status(409).json({ error: "No Planban update is currently available." });
        return;
      }
      if (!status.compatible) {
        res.status(409).json({ error: "This update needs an agent-guided storage migration." });
        return;
      }

      const currentBoardUrl = typeof req.body?.currentBoardUrl === "string" ? req.body.currentBoardUrl : null;
      const id = randomUUID();
      const startedAt = new Date().toISOString();
      const pending: UpdateRunSnapshot = {
        id,
        status: "pending",
        startedAt,
        completedAt: null,
        installShape: "unknown",
        targetVersion: status.latest.version,
        targetRef: status.latest.targetRef ?? null,
        targetCommit: status.latest.targetCommit ?? null,
        currentBoardUrl,
        restartRequired: true,
        message: "Preparing Planban update...",
        error: null,
        steps: [],
      };
      updateJobs.set(id, pending);

      void runPlanbanUpdate({
        id,
        runtimeRoot: PACKAGE_ROOT,
        latest: status.latest,
        currentBoardUrl,
        onSnapshot(snapshot) {
          updateJobs.set(id, snapshot);
          sendEvent("update-job", snapshot);
        },
      }).then((snapshot) => {
        updateJobs.set(id, snapshot);
        sendEvent("update-job", snapshot);
        if (snapshot.status === "succeeded" && snapshot.restartRequired) {
          scheduleRestartHandoff();
        }
      }).catch((error: unknown) => {
        const failed: UpdateRunSnapshot = {
          ...pending,
          status: "failed",
          completedAt: new Date().toISOString(),
          message: "Planban update failed.",
          error: error instanceof Error ? error.message : "Planban update failed.",
        };
        updateJobs.set(id, failed);
        sendEvent("update-job", failed);
      });

      res.status(202).json(pending);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/update-run/:id", (req, res) => {
    const job = updateJobs.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Update job not found." });
      return;
    }
    res.json(job);
  });

  app.get("/api/boards", async (req, res, next) => {
    try {
      const includeArchived = req.query.includeArchived === "true";
      res.json({
        currentRepoId: currentBoard?.repoId ?? null,
        boards: includeArchived ? await listAllBoards() : await listBoards(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/archive", async (req, res, next) => {
    try {
      const board = await archiveBoard(req.params.repoId);
      sendEvent("boards", { repoId: req.params.repoId, action: "archive" });
      res.json({ board });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/restore", async (req, res, next) => {
    try {
      const board = await restoreBoard(req.params.repoId);
      sendEvent("boards", { repoId: req.params.repoId, action: "restore" });
      res.json({ board });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/boards/:repoId", async (req, res, next) => {
    try {
      const confirmRepoId = typeof req.body?.confirmRepoId === "string" ? req.body.confirmRepoId.trim() : "";
      if (confirmRepoId !== req.params.repoId) {
        res.status(422).json({ error: "confirmRepoId must match the board repo id" });
        return;
      }
      const result = await deleteBoard(req.params.repoId);
      sendEvent("boards", { repoId: req.params.repoId, action: "delete" });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/demo", async (_req, res, next) => {
    try {
      const state = await ensureDemoBoard();
      await registerBoardFromState(state, { kind: "demo" });
      sendEvent("state", { repoId: state.manifest.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/open-codex-thread", async (req, res, next) => {
    try {
      const url = typeof req.body?.url === "string" ? req.body.url : "";
      const parsed = new URL(url);
      if (parsed.protocol !== "codex:") {
        res.status(422).json({ error: "Only codex:// URLs can be opened from this endpoint" });
        return;
      }
      await openExternalUrl(parsed.toString());
      res.json({ opened: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/cards/:id/codex-thread/draft", async (req, res, next) => {
    try {
      const url = typeof req.body?.url === "string" ? req.body.url : "";
      const launchToken = typeof req.body?.launchToken === "string" ? req.body.launchToken.trim() : "";
      if (!launchToken) {
        res.status(422).json({ error: "launchToken is required" });
        return;
      }
      const parsed = new URL(url);
      if (parsed.protocol !== "codex:" || parsed.hostname !== "threads" || parsed.pathname !== "/new") {
        res.status(422).json({ error: "Only codex://threads/new URLs can be opened from this endpoint" });
        return;
      }

      const cwdForBoard = await boardCwd(req.params.repoId);
      const { replayed, value: nextState } = await runApiMutation(req, cwdForBoard, async () => {
        const state = await loadState(cwdForBoard);
        let found = false;
        const roadmapItems = state.roadmap.roadmapItems.map((item) => {
          if (item.id !== req.params.id) return item;
          found = true;
          return updateItemCodexThreadMeta(item, {
            status: "pending",
            launchToken,
            draftOpenedAt: new Date().toISOString(),
            threadId: null,
            threadUrl: null,
          });
        });
        if (!found) {
          throw Object.assign(new Error("Card not found"), { statusCode: 404 });
        }

        const roadmap = await saveRoadmap(state, {
          ...state.roadmap,
          roadmapItems,
        }, {
          actor: "user",
          operation: "codex_thread.draft",
          summary: "Opened Codex thread draft",
          affectedCards: [req.params.id],
        });
        return { ...state, roadmap };
      });
      if (!replayed) await openExternalUrl(parsed.toString());
      sendEvent("state", { repoId: req.params.repoId, revision: nextState.roadmap.revision });
      res.json({ opened: true, state: nextState });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/cards/:id/codex-thread/sync", async (req, res, next) => {
    try {
      const cwdForBoard = await boardCwd(req.params.repoId);
      const { value: result } = await runApiMutation(req, cwdForBoard, async () => {
        const state = await loadState(cwdForBoard);
        const item = state.roadmap.roadmapItems.find((entry) => entry.id === req.params.id);
        if (!item) throw Object.assign(new Error("Card not found"), { statusCode: 404 });
        const meta = readCodexThreadMeta(item);
        const existingThreadId = typeof meta.threadId === "string" ? meta.threadId.trim() : "";
        if (existingThreadId) {
          return { linked: true, threadId: existingThreadId, threadUrl: codexThreadUrl(existingThreadId), state };
        }
        const token = typeof meta.launchToken === "string" ? meta.launchToken.trim() : "";
        if (!token) {
          return { linked: false, state };
        }

        const match = await findCodexThreadByLaunchToken(token);
        if (!match) {
          return { linked: false, pending: true, state };
        }

        const roadmapItems = state.roadmap.roadmapItems.map((entry) =>
          entry.id === req.params.id
            ? updateItemCodexThreadMeta(entry, {
                status: "linked",
                threadId: match.threadId,
                threadUrl: match.threadUrl,
                sessionPath: match.sessionPath,
                linkedAt: new Date().toISOString(),
              })
            : entry,
        );
        const roadmap = await saveRoadmap(state, {
          ...state.roadmap,
          roadmapItems,
        }, {
          actor: "system",
          operation: "codex_thread.link",
          summary: "Linked Codex thread to roadmap card",
          affectedCards: [req.params.id],
        });
        const nextState = { ...state, roadmap };
        return { linked: true, threadId: match.threadId, threadUrl: match.threadUrl, state: nextState };
      });
      if (result.linked && "state" in result) {
        sendEvent("state", { repoId: req.params.repoId, revision: result.state.roadmap.revision });
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/init", async (req, res, next) => {
    try {
      const state = await initializeProject({
        cwd,
        title: typeof req.body?.title === "string" ? req.body.title : undefined,
      });
      await registerBoardFromState(state);
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  async function boardCwd(repoId: string) {
    const board = await resolveBoardCwd(repoId);
    await touchBoard(repoId);
    return board;
  }

  app.get("/api/boards/:repoId/state", async (req, res, next) => {
    try {
      res.json(await loadState(await boardCwd(req.params.repoId)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/boards/:repoId/cards", async (req, res, next) => {
    try {
      const state = await loadState(await boardCwd(req.params.repoId));
      res.json(state.roadmap.roadmapItems);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/cards", async (req, res, next) => {
    try {
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      if (!title) {
        res.status(422).json({ error: "title is required" });
        return;
      }
      const status = typeof req.body?.status === "string" && isStatus(req.body.status)
        ? req.body.status
        : undefined;
      const cwdForBoard = await boardCwd(req.params.repoId);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => createCard({
        cwd: cwdForBoard,
        title,
        status,
        summary: typeof req.body?.summary === "string" ? req.body.summary : undefined,
        nextAction: typeof req.body?.nextAction === "string" ? req.body.nextAction : undefined,
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/boards/:repoId/cards/:id", async (req, res, next) => {
    try {
      const state = await loadState(await boardCwd(req.params.repoId));
      const card = state.roadmap.roadmapItems.find((item) => item.id === req.params.id);
      if (!card) {
        res.status(404).json({ error: "Card not found" });
        return;
      }
      res.json(card);
    } catch (error) {
      next(error);
    }
  });

  function parseReorderItems(rawItems: unknown) {
    const items = Array.isArray(rawItems) ? rawItems : [];
    const parsed = items.map((item: unknown) => {
      if (!item || typeof item !== "object") return null;
      const entry = item as { id?: unknown; status?: unknown };
      if (typeof entry.id !== "string" || typeof entry.status !== "string" || !isStatus(entry.status)) {
        return null;
      }
      return { id: entry.id, status: entry.status };
    });
    return parsed;
  }

  app.post("/api/boards/:repoId/cards/reorder", async (req, res, next) => {
    try {
      const parsed = parseReorderItems(req.body?.items);
      if (parsed.some((item: unknown) => item === null)) {
        res.status(422).json({ error: "Reorder payload must include items with valid id and status" });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => reorderCards({
        cwd: cwdForBoard,
        items: parsed as Array<{ id: string; status: PlanbanStatus }>,
        baseRevision: typeof req.body?.baseRevision === "number" ? req.body.baseRevision : undefined,
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/cards/:id/move", async (req, res, next) => {
    try {
      const status = String(req.body?.status ?? "");
      if (!isStatus(status)) {
        res.status(422).json({ error: `Invalid status: ${status}` });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => moveCard({
        cwd: cwdForBoard,
        cardId: req.params.id,
        status,
        afterId: typeof req.body?.afterId === "string" ? req.body.afterId : undefined,
        baseRevision: typeof req.body?.baseRevision === "number" ? req.body.baseRevision : undefined,
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  for (const [route, status] of [
    ["complete", "complete"],
    ["archive", "archived"],
    ["restore", "pending"],
  ] as const) {
    app.post(`/api/boards/:repoId/cards/:id/${route}`, async (req, res, next) => {
      try {
        const cwdForBoard = await boardCwd(req.params.repoId);
        const { value: state } = await runApiMutation(req, cwdForBoard, () =>
          setCardStatus(cwdForBoard, req.params.id, status),
        );
        sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
        res.json(state);
      } catch (error) {
        next(error);
      }
    });
  }

  app.delete("/api/boards/:repoId/cards/:id", async (req, res, next) => {
    try {
      const cwdForBoard = await boardCwd(req.params.repoId);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => deleteArchivedCard({
        cwd: cwdForBoard,
        cardId: req.params.id,
        baseRevision: typeof req.body?.baseRevision === "number" ? req.body.baseRevision : undefined,
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/boards/:repoId/cards/:id/docs/:kind", async (req, res, next) => {
    try {
      const kind = req.params.kind;
      if (kind !== "spec" && kind !== "plan") {
        res.status(404).json({ error: "Unknown doc kind" });
        return;
      }
      res.json(await readDoc({ cwd: await boardCwd(req.params.repoId), cardId: req.params.id, kind }));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/boards/:repoId/cards/:id/docs/:kind", async (req, res, next) => {
    try {
      const kind = req.params.kind;
      if (kind !== "spec" && kind !== "plan") {
        res.status(404).json({ error: "Unknown doc kind" });
        return;
      }
      const markdown = typeof req.body?.markdown === "string" ? req.body.markdown : "";
      const expectedMtimeMs =
        typeof req.body?.expectedMtimeMs === "number" || req.body?.expectedMtimeMs === null
          ? req.body.expectedMtimeMs
          : undefined;
      const cwdForBoard = await boardCwd(req.params.repoId);
      const { value: payload } = await runApiMutation(req, cwdForBoard, () => writeDoc({
        cwd: cwdForBoard,
        cardId: req.params.id,
        kind,
        markdown,
        expectedMtimeMs,
      }));
      sendEvent("state", { repoId: req.params.repoId, doc: payload.path });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/boards/:repoId/history", async (req, res, next) => {
    try {
      res.json(await historyPayload(await boardCwd(req.params.repoId)));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/boards/:repoId/history/:version", async (req, res, next) => {
    try {
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) {
        res.status(422).json({ error: "Invalid history version" });
        return;
      }
      res.json(await loadHistoryState({ cwd: await boardCwd(req.params.repoId), version }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/history/:version/restore-board", async (req, res, next) => {
    try {
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) {
        res.status(422).json({ error: "Invalid history version" });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => restoreBoardVersion({
        cwd: cwdForBoard,
        version,
        actor: parseActor(req.body?.actor),
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/history/:version/cards/:id/restore", async (req, res, next) => {
    try {
      const version = Number(req.params.version);
      if (!Number.isInteger(version) || version < 1) {
        res.status(422).json({ error: "Invalid history version" });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId);
      const { value: state } = await runApiMutation(req, cwdForBoard, () => restoreCardVersion({
        cwd: cwdForBoard,
        version,
        cardId: req.params.id,
        actor: parseActor(req.body?.actor),
      }));
      sendEvent("state", { repoId: req.params.repoId, revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/boards/:repoId/history/:version/cards/:id/docs/:kind", async (req, res, next) => {
    try {
      const version = Number(req.params.version);
      const kind = req.params.kind;
      if (!Number.isInteger(version) || version < 1 || (kind !== "spec" && kind !== "plan")) {
        res.status(422).json({ error: "Invalid history document request" });
        return;
      }
      res.json(await readHistoryDoc({ cwd: await boardCwd(req.params.repoId), version, cardId: req.params.id, kind }));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/history/:version/cards/:id/docs/:kind/restore", async (req, res, next) => {
    try {
      const version = Number(req.params.version);
      const kind = req.params.kind;
      if (!Number.isInteger(version) || version < 1 || (kind !== "spec" && kind !== "plan")) {
        res.status(422).json({ error: "Invalid history document restore request" });
        return;
      }
      const cwdForBoard = await boardCwd(req.params.repoId);
      const { value: payload } = await runApiMutation(req, cwdForBoard, () => restoreDocVersion({
        cwd: cwdForBoard,
        version,
        cardId: req.params.id,
        kind,
        actor: parseActor(req.body?.actor),
      }));
      sendEvent("state", { repoId: req.params.repoId, doc: payload.path });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/state", async (_req, res, next) => {
    try {
      res.json(await loadState(cwd));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards", async (_req, res, next) => {
    try {
      const state = await loadState(cwd);
      res.json(state.roadmap.roadmapItems);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards", async (req, res, next) => {
    try {
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      if (!title) {
        res.status(422).json({ error: "title is required" });
        return;
      }
      const status = typeof req.body?.status === "string" && isStatus(req.body.status)
        ? req.body.status
        : undefined;
      const { value: state } = await runApiMutation(req, cwd, () => createCard({
        cwd,
        title,
        status,
        summary: typeof req.body?.summary === "string" ? req.body.summary : undefined,
        nextAction: typeof req.body?.nextAction === "string" ? req.body.nextAction : undefined,
      }));
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:id", async (req, res, next) => {
    try {
      const state = await loadState(cwd);
      const card = state.roadmap.roadmapItems.find((item) => item.id === req.params.id);
      if (!card) {
        res.status(404).json({ error: "Card not found" });
        return;
      }
      res.json(card);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/reorder", async (req, res, next) => {
    try {
      const parsed = parseReorderItems(req.body?.items);
      if (parsed.some((item: unknown) => item === null)) {
        res.status(422).json({ error: "Reorder payload must include items with valid id and status" });
        return;
      }
      const { value: state } = await runApiMutation(req, cwd, () => reorderCards({
        cwd,
        items: parsed as Array<{ id: string; status: PlanbanStatus }>,
        baseRevision: typeof req.body?.baseRevision === "number" ? req.body.baseRevision : undefined,
      }));
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/cards/:id/move", async (req, res, next) => {
    try {
      const status = String(req.body?.status ?? "");
      if (!isStatus(status)) {
        res.status(422).json({ error: `Invalid status: ${status}` });
        return;
      }
      const { value: state } = await runApiMutation(req, cwd, () => moveCard({
        cwd,
        cardId: req.params.id,
        status,
        afterId: typeof req.body?.afterId === "string" ? req.body.afterId : undefined,
        baseRevision: typeof req.body?.baseRevision === "number" ? req.body.baseRevision : undefined,
      }));
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  for (const [route, status] of [
    ["complete", "complete"],
    ["archive", "archived"],
    ["restore", "pending"],
  ] as const) {
    app.post(`/api/cards/:id/${route}`, async (req, res, next) => {
      try {
        const { value: state } = await runApiMutation(req, cwd, () => setCardStatus(cwd, req.params.id, status));
        sendEvent("state", { revision: state.roadmap.revision });
        res.json(state);
      } catch (error) {
        next(error);
      }
    });
  }

  app.delete("/api/cards/:id", async (req, res, next) => {
    try {
      const { value: state } = await runApiMutation(req, cwd, () => deleteArchivedCard({
        cwd,
        cardId: req.params.id,
        baseRevision: typeof req.body?.baseRevision === "number" ? req.body.baseRevision : undefined,
      }));
      sendEvent("state", { revision: state.roadmap.revision });
      res.json(state);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/cards/:id/docs/:kind", async (req, res, next) => {
    try {
      const kind = req.params.kind;
      if (kind !== "spec" && kind !== "plan") {
        res.status(404).json({ error: "Unknown doc kind" });
        return;
      }
      res.json(await readDoc({ cwd, cardId: req.params.id, kind }));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/cards/:id/docs/:kind", async (req, res, next) => {
    try {
      const kind = req.params.kind;
      if (kind !== "spec" && kind !== "plan") {
        res.status(404).json({ error: "Unknown doc kind" });
        return;
      }
      const markdown = typeof req.body?.markdown === "string" ? req.body.markdown : "";
      const expectedMtimeMs =
        typeof req.body?.expectedMtimeMs === "number" || req.body?.expectedMtimeMs === null
          ? req.body.expectedMtimeMs
          : undefined;
      const { value: payload } = await runApiMutation(req, cwd, () =>
        writeDoc({ cwd, cardId: req.params.id, kind, markdown, expectedMtimeMs }),
      );
      sendEvent("state", { doc: payload.path });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/import-t3", async (req, res, next) => {
    try {
      const { value: report } = await runApiMutation(req, cwd, () => importT3({ from: cwd, dryRun: req.body?.dryRun !== false }));
      if (!report.dryRun) await registerBoardFromCwd(cwd);
      res.json(report);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    const statusCode = error && typeof error === "object" && "statusCode" in error
      ? Number((error as { statusCode?: unknown }).statusCode)
      : null;
    const responseStatus = Number.isInteger(statusCode)
      ? statusCode as number
      : error instanceof PlanbanConflictError || error instanceof PlanbanIdempotencyConflictError
        ? 409
        : 500;
    res.status(responseStatus).json({ error: message });
  });

  if (options.useVite) {
    const viteModule = await import("vite");
    vite = await viteModule.createServer({
      server: { middlewareMode: true },
      appType: "spa",
      root: WEB_ROOT,
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(DIST_WEB_ROOT));
    app.get(/.*/, (_req, res) => {
      res.sendFile(resolve(DIST_WEB_ROOT, "index.html"));
    });
  }

  try {
    watcher = chokidar.watch(defaultPlanbanRoot(), { ignoreInitial: true });
    watcher.on("all", (_event: string, path: string) => sendEvent("state", { path }));
  } catch {
    // Uninitialized projects can still be served so the UI can show onboarding.
  }

  await new Promise<void>((resolveListen) => {
    server.listen(options.port, "127.0.0.1", resolveListen);
  });

  return {
    url: `http://localhost:${options.port}`,
    close: closeServer,
  };
}
