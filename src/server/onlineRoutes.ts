// The board page's Online Board controls (owner decision 15): where a board
// lives, Board settings with Take online and Take local, and sign-in. A local
// board's status is read from files on this machine only; nothing here
// contacts the online service for a local board unless the person asks to
// move it, or this machine has signed in and the board is an older copy.
import { randomUUID } from "node:crypto";
import type express from "express";
import { readManifest, resolvePlanningRoot } from "../core/storage";
import { boardPath, onlineRequest } from "../core/online/client";
import { readCredentials, serviceUrl } from "../core/online/credentials";
import { readStaleMarker } from "../core/online/copyCheck";
import { onlineLogin } from "../core/online/login";
import {
  attachOnline, keepSeparateBoard, othersOnBoard, PlanbanConfirmationNeeded, PlanbanTakeOnlineStopped, takeLocal, takeOnline, type MoveProgress,
} from "../core/online/transfers";

/** The working default address for Planban Online (owner decision 13). */
const DEFAULT_SERVICE = "https://app.planban.ai";

export interface MoveJob {
  id: string;
  repoId: string;
  kind: "take-online" | "take-local";
  status: "running" | "succeeded" | "failed" | "stopped";
  progress: MoveProgress | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface Deps {
  resolveBoardCwd: (repoId: string) => Promise<string>;
  /** Tells watching pages that boards or a board's state changed. */
  changed: (repoId: string) => void;
}

/** The service a board would go online to: the configured one, the only one this machine signed in to, or the default. */
async function defaultService() {
  if (process.env.PLANBAN_ONLINE_URL) return serviceUrl(process.env.PLANBAN_ONLINE_URL);
  const services = Object.keys((await readCredentials()).services);
  return services.length === 1 ? services[0]! : DEFAULT_SERVICE;
}

export function registerOnlineRoutes(app: express.Express, deps: Deps) {
  const jobs = new Map<string, MoveJob & { controller?: AbortController }>();
  const signIns = new Map<string, { link: string | null; done: boolean; error: string | null }>();

  const publicJob = (job: MoveJob & { controller?: AbortController }): MoveJob => {
    const { controller: _controller, ...rest } = job;
    return rest;
  };
  const running = (repoId: string) => [...jobs.values()].find((job) => job.repoId === repoId && job.status === "running");

  app.get("/api/boards/:repoId/online", async (req, res, next) => {
    try {
      const repoId = req.params.repoId;
      const cwd = await deps.resolveBoardCwd(repoId);
      const manifest = await readManifest(cwd);
      const signedIn = Object.keys((await readCredentials()).services);
      const job = [...jobs.values()].filter((entry) => entry.repoId === repoId).at(-1);
      const base = { signedIn, defaultService: await defaultService(), job: job ? publicJob(job) : null };
      if (manifest?.storage?.kind !== "online") {
        const stale = manifest?.enabled ? await readStaleMarker(resolvePlanningRoot(manifest)) : null;
        res.json({ ...base, location: running(repoId)?.kind === "take-online" ? "moving" : "local", stale });
        return;
      }
      const { url, boardId } = manifest.storage;
      // People on the board, for Board settings. A failure here (signed out,
      // offline) still shows where the board lives.
      const people = await Promise.all([
        onlineRequest<{ members: Array<{ userId: string; role: string }> }>(url, boardPath(boardId, "/members")),
        onlineRequest<{ userId: string }>(url, "/api/v1/me"),
      ]).then(([{ members }, me]) => members.map((member) => ({ ...member, you: member.userId === me.userId })), () => null);
      res.json({ ...base, location: "online", url, boardId, people });
    } catch (error) {
      next(error);
    }
  });

  /** People on an online board and who last changed each card; nothing for a local board. */
  app.get("/api/boards/:repoId/online/people", async (req, res, next) => {
    try {
      const manifest = await readManifest(await deps.resolveBoardCwd(req.params.repoId));
      if (manifest?.storage?.kind !== "online") {
        res.json({ shared: false, people: [], cards: {} });
        return;
      }
      res.json(await onlineRequest(manifest.storage.url, boardPath(manifest.storage.boardId, "/people")));
    } catch (error) {
      next(error);
    }
  });

  /** What your own agents may do on this online board. */
  app.post("/api/boards/:repoId/online/people/me/agents", async (req, res, next) => {
    try {
      const manifest = await readManifest(await deps.resolveBoardCwd(req.params.repoId));
      if (manifest?.storage?.kind !== "online") {
        res.status(409).json({ error: "This board is on this Mac; its agents are the ones on this Mac." });
        return;
      }
      res.json(await onlineRequest(manifest.storage.url, boardPath(manifest.storage.boardId, "/people/me/agents"), { level: req.body?.level }));
    } catch (error) {
      next(error);
    }
  });

  function startJob(repoId: string, kind: MoveJob["kind"], run: (job: MoveJob & { controller?: AbortController }) => Promise<unknown>) {
    const job: MoveJob & { controller?: AbortController } = {
      id: randomUUID(), repoId, kind, status: "running", progress: null, error: null, startedAt: new Date().toISOString(), finishedAt: null,
    };
    jobs.set(job.id, job);
    void run(job).then(() => {
      job.status = "succeeded";
    }, (error: unknown) => {
      job.status = error instanceof PlanbanTakeOnlineStopped ? "stopped" : "failed";
      job.error = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      job.finishedAt = new Date().toISOString();
      delete job.controller;
      deps.changed(repoId);
    });
    return job;
  }

  /** Errors that need the person's say-so come back with what they would agree to. */
  function refuse(res: express.Response, error: unknown) {
    if (error instanceof PlanbanConfirmationNeeded) {
      res.status(409).json({ error: error.message, confirmationNeeded: error.summary });
      return true;
    }
    return false;
  }

  app.post("/api/boards/:repoId/online/take-online", async (req, res, next) => {
    try {
      const repoId = req.params.repoId;
      if (running(repoId)) {
        res.status(409).json({ error: "This board is already moving." });
        return;
      }
      const cwd = await deps.resolveBoardCwd(repoId);
      const url = serviceUrl(typeof req.body?.url === "string" && req.body.url ? req.body.url : await defaultService());
      if (!(await readCredentials()).services[url]) {
        res.status(401).json({ error: "Sign in to Planban Online first.", signInNeeded: url });
        return;
      }
      const job = startJob(repoId, "take-online", (entry) => {
        entry.controller = new AbortController();
        return takeOnline(url, cwd, { signal: entry.controller.signal, onProgress: (progress) => { entry.progress = progress; } });
      });
      deps.changed(repoId);
      res.status(202).json(publicJob(job));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/online/take-local", async (req, res, next) => {
    try {
      const repoId = req.params.repoId;
      if (running(repoId)) {
        res.status(409).json({ error: "This board is already moving." });
        return;
      }
      const cwd = await deps.resolveBoardCwd(repoId);
      const manifest = await readManifest(cwd);
      if (manifest?.storage?.kind !== "online") {
        res.status(409).json({ error: "This board is already on this machine." });
        return;
      }
      // Say who loses access before anything happens; takeLocal checks again.
      const removeOthers = req.body?.removeOthers === true;
      const others = await othersOnBoard(manifest.storage.url, manifest.storage.boardId);
      // The confirmation covers exactly the people the page showed.
      const expected = Array.isArray(req.body?.expectedOthers) ? new Set(req.body.expectedOthers.map(String)) : null;
      const unchanged = expected !== null && expected.size === others.length && others.every((person) => expected.has(person.userId));
      if (others.length && (!removeOthers || !unchanged)) {
        res.status(409).json({ error: "Taking this board back removes everyone else's access.", confirmationNeeded: { removes: others } });
        return;
      }
      const job = startJob(repoId, "take-local", (entry) => takeLocal(cwd, { expectedOthers: others.map((person) => person.userId), onProgress: (progress) => { entry.progress = progress; } }));
      deps.changed(repoId);
      res.status(202).json(publicJob(job));
    } catch (error) {
      if (refuse(res, error)) return;
      next(error);
    }
  });

  /** An older copy (owner decision 15): use the online board in this project instead. */
  app.post("/api/boards/:repoId/online/use-online", async (req, res, next) => {
    try {
      const cwd = await deps.resolveBoardCwd(req.params.repoId);
      const manifest = await readManifest(cwd);
      const stale = manifest?.enabled && manifest.storage?.kind !== "online" ? await readStaleMarker(resolvePlanningRoot(manifest)) : null;
      if (!stale) {
        res.status(409).json({ error: "This board is not an older copy of an online board." });
        return;
      }
      const result = await attachOnline(stale.url, stale.boardId, cwd, { replaceStaleCopy: true });
      deps.changed(req.params.repoId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  /** An older copy: keep it as its own board; this project follows the online board. */
  app.post("/api/boards/:repoId/online/keep-separate", async (req, res, next) => {
    try {
      const cwd = await deps.resolveBoardCwd(req.params.repoId);
      const title = typeof req.body?.title === "string" ? req.body.title : undefined;
      const result = await keepSeparateBoard(cwd, title ? { title } : {});
      deps.changed(req.params.repoId);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/boards/:repoId/online/stop", async (req, res) => {
    const job = running(req.params.repoId);
    if (!job || job.kind !== "take-online" || !job.controller) {
      res.status(409).json({ error: "Nothing to stop: only a Take Online that has not finished can be stopped." });
      return;
    }
    job.controller.abort();
    res.status(202).json(publicJob(job));
  });

  app.get("/api/boards/:repoId/online/job/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job || job.repoId !== req.params.repoId) {
      res.status(404).json({ error: "Move not found." });
      return;
    }
    res.json(publicJob(job));
  });

  /**
   * Starts the browser sign-in. The page opens the returned link itself; the
   * sign-in finishes in the background when the browser comes back.
   */
  app.post("/api/online/sign-in", async (req, res, next) => {
    try {
      const url = serviceUrl(typeof req.body?.url === "string" && req.body.url ? req.body.url : await defaultService());
      const id = randomUUID();
      const entry = { link: null as string | null, done: false, error: null as string | null };
      signIns.set(id, entry);
      const linkReady = new Promise<void>((resolve) => {
        void onlineLogin(url, {
          openBrowser: async (link) => {
            entry.link = link;
            resolve();
          },
        }).then(() => {
          entry.done = true;
        }, (error: unknown) => {
          entry.error = error instanceof Error ? error.message : String(error);
          resolve();
        });
      });
      await linkReady;
      if (!entry.link) {
        res.status(502).json({ error: entry.error ?? "Sign-in could not start." });
        return;
      }
      res.status(202).json({ id, url, link: entry.link });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/online/sign-in/:id", (req, res) => {
    const entry = signIns.get(req.params.id);
    if (!entry) {
      res.status(404).json({ error: "Sign-in not found." });
      return;
    }
    res.json({ done: entry.done, error: entry.error });
  });
}
