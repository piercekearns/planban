// Online Board controls on the board page (owner decision 15, from the
// approved mockups): a quiet "On this Mac" / "Online" pill beside the board
// name, and Board settings with Take online and Take local. Local boards only
// ever ask the local Planban server, which answers from files on this machine.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Cloud, Laptop, Loader2, Users, X } from "lucide-react";

export interface MoveProgress {
  step: "prepare" | "copy" | "switch" | "files" | "done";
  message: string;
  done?: number;
  total?: number;
}

export interface MoveJob {
  id: string;
  kind: "take-online" | "take-local";
  status: "running" | "succeeded" | "failed" | "stopped";
  progress: MoveProgress | null;
  error: string | null;
}

export interface OnlineStatus {
  location: "local" | "moving" | "online";
  signedIn: string[];
  defaultService: string;
  job: MoveJob | null;
  url?: string;
  boardId?: string;
  people?: Array<{ userId: string; role: string; you: boolean }> | null;
  stale?: { title: string; onlineSince: string; url: string; boardId: string } | null;
}

class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message);
  }
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Planban-Client": "web" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new RequestError(typeof json.error === "string" ? json.error : `Planban answered ${response.status}.`, response.status, json);
  return json as T;
}

/** The board's location and move status; refreshes when the board changes and while a move runs. */
export function useOnlineStatus(repoId: string | null, refreshKey: unknown) {
  const [status, setStatus] = useState<OnlineStatus | null>(null);
  const load = useCallback(async () => {
    if (!repoId) return;
    setStatus(await request<OnlineStatus>(`/api/boards/${encodeURIComponent(repoId)}/online`).catch(() => null));
  }, [repoId]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  useEffect(() => {
    if (status?.job?.status !== "running") return;
    const timer = window.setInterval(() => void load(), 700);
    return () => window.clearInterval(timer);
  }, [load, status?.job?.status]);
  return { status, reload: load };
}

export function LocationPill({ status }: { status: OnlineStatus | null }) {
  if (!status) return null;
  const older = status.location === "local" && status.stale;
  const [icon, text] = status.location === "moving"
    ? [<Loader2 key="i" size={12} className="spin" />, "Moving online…"]
    : status.location === "online"
      ? [<Cloud key="i" size={12} />, "Online"]
      : [<Laptop key="i" size={12} />, older ? "On this Mac · older copy" : "On this Mac"];
  return <span className={`board-location-pill ${status.location === "moving" ? "busy" : ""}`}>{icon}<span>{text}</span></span>;
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
}

function Modal({ eyebrow, title, onClose, children, footer }: { eyebrow: string; title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  useEscape(onClose);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section ref={ref} className="feedback-modal online-board-modal" role="dialog" aria-modal="true" aria-labelledby="online-board-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
        <header className="feedback-modal-header">
          <div><p className="eyebrow">{eyebrow}</p><h2 id="online-board-title">{title}</h2></div>
          <button aria-label="Close" className="toolbar-icon-button" onClick={onClose}><X size={14} /></button>
        </header>
        {children}
        {footer ? <footer className="feedback-actions">{footer}</footer> : <div style={{ height: 6 }} />}
      </section>
    </div>,
    document.body,
  );
}

type View = "settings" | "confirm-online" | "confirm-local" | "progress" | "failed" | "sign-in";

const peopleSentence = (names: string[]) => names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

export function BoardSettingsModal({ repoId, boardTitle, status, reload, onClose }: {
  repoId: string;
  boardTitle: string;
  status: OnlineStatus;
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const job = status.job;
  const [view, setView] = useState<View>(job?.status === "running" ? "progress" : "settings");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [losing, setLosing] = useState<Array<{ userId: string; role: string }>>([]);
  const base = `/api/boards/${encodeURIComponent(repoId)}/online`;
  const others = (status.people ?? []).filter((person) => !person.you);

  // People may have joined or left since the page last looked.
  useEffect(() => {
    void reload();
  }, [reload]);

  // Follow a move to its end.
  useEffect(() => {
    if (view !== "progress" || !job || job.status === "running") return;
    if (job.status === "failed") setView("failed");
    else if (job.status === "succeeded" || job.status === "stopped") setView("settings");
  }, [view, job]);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (failure) {
      if (failure instanceof RequestError && typeof failure.body.signInNeeded === "string") {
        setView("sign-in");
      } else if (failure instanceof RequestError && failure.body.confirmationNeeded) {
        setLosing(((failure.body.confirmationNeeded as { removes?: Array<{ userId: string; role: string }> }).removes) ?? []);
        setView("confirm-local");
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      setBusy(false);
      await reload();
    }
  }

  const takeOnline = () => act(async () => {
    await request(`${base}/take-online`, {});
    setView("progress");
  });
  const takeLocal = () => act(async () => {
    // Only the people named on screen may be removed; if that changed, the server asks again.
    const named = (losing.length ? losing : others).map((person) => person.userId);
    await request(`${base}/take-local`, { removeOthers: true, expectedOthers: named });
    setView("progress");
  });
  const stop = () => act(() => request(`${base}/stop`, {}));
  const signIn = () => act(async () => {
    const started = await request<{ id: string; link: string }>("/api/online/sign-in", {});
    window.open(started.link, "_blank", "noopener");
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const state = await request<{ done: boolean; error: string | null }>(`/api/online/sign-in/${started.id}`);
      if (state.error) throw new Error(state.error);
      if (state.done) break;
    }
    setView("confirm-online");
  });

  const errorLine = error ? <p className="online-board-error" role="alert">{error}</p> : null;

  if (view === "sign-in") {
    return (
      <Modal eyebrow="Board settings" title="Sign in to Planban" onClose={onClose}
        footer={<><button onClick={() => setView("settings")}>Cancel</button><button className="primary update-now-action" disabled={busy} onClick={() => void signIn()}>{busy ? <Loader2 size={14} className="spin" /> : null} Sign in</button></>}>
        <div className="online-board-body">
          <p>Taking a board online needs your Planban account. Sign in opens in a new browser tab, with an email code or GitHub.</p>
          {busy ? <p className="muted">Waiting for you to finish signing in…</p> : null}
          {errorLine}
        </div>
      </Modal>
    );
  }

  if (view === "confirm-online") {
    return (
      <Modal eyebrow="Board settings" title={`Take ${boardTitle} online?`} onClose={onClose}
        footer={<><button onClick={() => setView("settings")}>Cancel</button><button className="primary update-now-action" disabled={busy} onClick={() => void takeOnline()}><Cloud size={14} /> Take online</button></>}>
        <div className="online-board-body">
          <ul>
            <li>The whole board, including specs, plans and history, is copied to your Planban account.</li>
            <li>From then on the online board is the one you and your agents edit. This Mac keeps an automatic backup copy.</li>
            <li>Agents on this Mac keep working. Each one will ask you to sign in once.</li>
            <li>Nobody else can see the board until you invite them.</li>
          </ul>
          <p className="muted">You can take it back to this Mac at any time from Board settings.</p>
          {errorLine}
        </div>
      </Modal>
    );
  }

  if (view === "confirm-local") {
    const names = (losing.length ? losing : others).map((person) => person.userId);
    return (
      <Modal eyebrow="Board settings" title={`Take ${boardTitle} back to this Mac?`} onClose={onClose}
        footer={<><button onClick={() => setView("settings")}>Cancel</button><button className="primary update-now-action" disabled={busy} onClick={() => void takeLocal()}><Laptop size={14} /> Take local</button></>}>
        <div className="online-board-body">
          <ul>
            <li>The online board and its full history are copied to this Mac, which becomes the only copy you edit.</li>
            {names.length ? <li>{peopleSentence(names)} {names.length === 1 ? "loses" : "lose"} access, and their agents are cut off.</li> : null}
            <li>Your agents connected online are cut off. Agents on this Mac keep working.</li>
            <li>The online copy stops accepting changes, so nothing can drift.</li>
          </ul>
          <p className="muted">You can take it online again later{names.length ? " and re-invite people" : ""}.</p>
          {errorLine}
        </div>
      </Modal>
    );
  }

  if (view === "progress" && job) {
    const online = job.kind === "take-online";
    const progress = job.progress;
    const share = progress?.total ? Math.round(((progress.done ?? 0) / progress.total) * 100) : progress?.step === "switch" || progress?.step === "done" ? 100 : 8;
    return (
      <Modal eyebrow="Board settings" title={online ? `Taking ${boardTitle} online` : `Taking ${boardTitle} back to this Mac`} onClose={onClose}
        footer={online && job.status === "running" && progress?.step !== "switch" && progress?.step !== "files" ? <button disabled={busy} onClick={() => void stop()}>Stop and keep it on this Mac</button> : undefined}>
        <div className="online-board-body">
          <section className="update-job" style={{ marginTop: 0 }}>
            <p className="update-preflight-summary" style={{ margin: 0 }}>{progress?.message ?? "Starting…"}{progress?.total ? `, ${progress.done ?? 0} of ${progress.total}` : ""}</p>
            <div className="update-progress-track" aria-hidden="true"><div style={{ width: `${share}%`, background: "var(--accent)" }} /></div>
          </section>
          <p className="muted" style={{ marginTop: 12 }}>You can keep reading the board. Changes from you and your agents wait until this finishes, then carry on as normal.</p>
          {errorLine}
        </div>
      </Modal>
    );
  }

  if (view === "failed" && job) {
    const online = job.kind === "take-online";
    return (
      <Modal eyebrow="Board settings" title={online ? `${boardTitle} is still on this Mac` : `${boardTitle} is still online`} onClose={onClose}
        footer={<><button onClick={onClose}>Close</button><button className="primary update-now-action" disabled={busy} onClick={() => void (online ? takeOnline() : takeLocal())}>Try again</button></>}>
        <div className="online-board-body">
          <div className="online-board-calm">
            <b>Nothing has changed.</b>{" "}
            {online
              ? "The move was stopped before it finished. The board is still on this Mac, you and your agents can keep editing, and the partial online copy has been removed."
              : "The board could not be copied back to this Mac. It is still online, unchanged, and nobody's access has been touched."}
          </div>
          <details className="update-job-details" style={{ marginTop: 12 }}><summary>Show technical details</summary><p>{job.error}</p></details>
          {errorLine}
        </div>
      </Modal>
    );
  }

  const where = status.location === "online"
    ? <div className="online-board-row"><div className="grow"><b><Cloud size={14} /> Online</b><small>Stored in your Planban account, so you can open it from any device and invite people. This Mac keeps an automatic backup copy.</small></div><button className="online-board-button" disabled={busy} onClick={() => setView("confirm-local")}><Laptop size={13} /> Take local…</button></div>
    : status.location === "moving"
      ? <div className="online-board-row"><div className="grow"><b><Loader2 size={14} className="spin" /> Moving online…</b><small>{job?.progress?.message ?? "Starting…"}</small></div><button className="online-board-button" onClick={() => setView("progress")}>Show progress</button></div>
      : <div className="online-board-row"><div className="grow"><b><Laptop size={14} /> On this Mac</b><small>Stored only on this Mac. You and the agents on this Mac can use it; nobody else can see it.</small></div><button className="online-board-button" disabled={busy || Boolean(status.stale)} onClick={() => setView(status.signedIn.length ? "confirm-online" : "sign-in")}><Cloud size={13} /> Take online…</button></div>;
  const people = status.location === "online"
    ? <div className="online-board-row"><div className="grow"><b><Users size={14} /> {others.length ? `You and ${others.length} other ${others.length === 1 ? "person" : "people"}` : "Only you"}</b><small>{others.length ? peopleSentence(others.map((person) => `${person.userId} (${person.role})`)) : "Invite people to work on this board with you."}</small></div></div>
    : <div className="online-board-row"><div className="grow"><b><Users size={14} /> Only you</b><small>Take the board online to invite people.</small></div></div>;
  return (
    <Modal eyebrow={boardTitle} title="Board settings" onClose={onClose}>
      {job && job.status === "stopped" ? <p className="online-board-note"><Check size={13} /> Take Online stopped. The board is on this Mac, unchanged.</p> : null}
      <div className="online-board-section"><h3>Where this board lives</h3>{where}</div>
      <div className="online-board-section"><h3>People</h3>{people}</div>
      {errorLine ? <div className="online-board-section">{errorLine}</div> : null}
    </Modal>
  );
}
