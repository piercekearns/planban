// Online Board controls on the board page (owner decision 15, from the
// approved mockups): a quiet "On this Mac" / "Online" pill beside the board
// name, and Board settings with Take online and Take local. Local boards only
// ever ask the local Planban server, which answers from files on this machine.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Check, Cloud, Copy, Info, KeyRound, Laptop, Link, Loader2, Mail, Users, X } from "lucide-react";

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
  /** For a failed move: where the board stands, said plainly, and what trying again would do. */
  outcome: { unchanged: boolean; location: "local" | "online"; message: string; retry: string | null } | null;
  noteCommit: string | null;
}

export interface OnlineStatus {
  location: "local" | "moving" | "online";
  signedIn: string[];
  defaultService: string;
  job: MoveJob | null;
  url?: string;
  boardId?: string;
  people?: Array<{ userId: string; role: string; you: boolean }> | null;
  stale?: { title: string; onlineSince: string; url: string; boardId: string; signInNeeded?: boolean } | null;
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

/**
 * Signs this computer in to Planban in a new browser tab, as Take online does,
 * and resolves once the sign-in has finished. The tab is opened before any
 * await, while the click still counts, so the browser does not block it; if it
 * is blocked anyway, onBlocked receives the link to show instead.
 */
export async function browserSignIn(url: string | undefined, onBlocked: (link: string) => void): Promise<void> {
  const tab = window.open("", "_blank");
  if (tab) tab.opener = null;
  const started = await request<{ id: string; link: string }>("/api/online/sign-in", url ? { url } : {}).catch((error) => {
    tab?.close();
    throw error;
  });
  if (tab) tab.location.href = started.link;
  else onBlocked(started.link);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const state = await request<{ done: boolean; error: string | null }>(`/api/online/sign-in/${started.id}`);
    if (state.error) throw new Error(state.error);
    if (state.done) return;
  }
}

/** Why an Online Board can't open: this computer was never signed in, or its sign-in ended. */
export interface SignedOut {
  url: string;
  reason: "missing" | "expired";
  /** The sign-in command as this computer runs it. */
  command?: string;
}

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

/** Shown instead of an Online Board when this computer isn't signed in to its service. */
export function SignedOutScreen({ signedOut, onSignedIn }: { signedOut: SignedOut; onSignedIn: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blockedLink, setBlockedLink] = useState<string | null>(null);
  const shown = useRef(true);
  useEffect(() => () => { shown.current = false; }, []);
  async function signIn() {
    setBusy(true);
    setError(null);
    setBlockedLink(null);
    try {
      await browserSignIn(signedOut.url, setBlockedLink);
      // Left for another board meanwhile: this screen no longer decides anything.
      if (!shown.current) return;
      onSignedIn();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="error-screen">
      <div className="load-error-card signed-out-card">
        <h1>{signedOut.reason === "expired" ? "Your Planban sign-in on this computer has ended." : "You're signed out of Planban on this computer."}</h1>
        <p>This board is online at {hostOf(signedOut.url)}. Sign in to open it here. Sign-in opens in a new browser tab, with an email code or GitHub.</p>
        <button className="primary" disabled={busy} onClick={() => void signIn()}>{busy ? <Loader2 size={14} className="spin" /> : null} Sign in</button>
        {busy ? <p className="muted">Waiting for you to finish signing in…</p> : null}
        {blockedLink ? <p>Your browser blocked the sign-in tab. <a href={blockedLink} target="_blank" rel="noopener noreferrer">Open the sign-in page</a>; this finishes once you have signed in.</p> : null}
        {error ? <p className="online-board-error" role="alert">{error}</p> : null}
        <p className="muted signed-out-hint">For agents and terminals: <code>{signedOut.command ?? `planban online login ${signedOut.url}`}</code></p>
      </div>
    </main>
  );
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

export function BoardSettingsModal({ repoId, boardTitle, status, reload, onManagePeople, onClose }: {
  repoId: string;
  boardTitle: string;
  status: OnlineStatus;
  reload: () => Promise<void>;
  onManagePeople: () => void;
  onClose: () => void;
}) {
  const job = status.job;
  const [view, setView] = useState<View>(job?.status === "running" ? "progress" : "settings");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [losing, setLosing] = useState<Array<{ userId: string; role: string }>>([]);
  const [signInLink, setSignInLink] = useState<string | null>(null);
  // When an action stopped because this computer's sign-in had ended: its service, and the action to finish afterwards.
  const [resume, setResume] = useState<{ url: string; run: () => Promise<unknown> } | null>(null);
  // Bumped by Cancel, closing and unmounting, so a sign-in finishing later never acts on its own.
  const signInTicket = useRef(0);
  useEffect(() => () => { signInTicket.current++; }, []);
  const base = `/api/boards/${encodeURIComponent(repoId)}/online`;
  const others = (status.people ?? []).filter((person) => !person.you);
  const [conversion, setConversion] = useState<{ clean: boolean; machine: string; files: number; pictures: number; howToTidy: string; boardProblems: string[]; cards: Array<{ cardId: string; title: string; files: string[]; pictures: Array<{ kind: string; alt: string; where: string }>; problems: string[] }> } | null>(null);
  useEffect(() => {
    if (view !== "confirm-online") return;
    setConversion(null);
    void request<typeof conversion>(`${base}/conversion`).then(setConversion, (failure) => setError(failure instanceof Error ? failure.message : String(failure)));
  }, [view, base]);

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
        setResume({ url: failure.body.signInNeeded, run });
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
    const ticket = signInTicket.current;
    await browserSignIn(resume?.url, setSignInLink);
    if (ticket !== signInTicket.current) return;
    const next = resume;
    setResume(null);
    if (!next) return setView("confirm-online");
    // Finish what was interrupted, such as Take local, now that this computer is signed in again.
    setView("settings");
    await next.run();
  });

  const errorLine = error ? <p className="online-board-error" role="alert">{error}</p> : null;

  if (view === "sign-in") {
    return (
      <Modal eyebrow="Board settings" title="Sign in to Planban" onClose={onClose}
        footer={<><button onClick={() => { signInTicket.current++; setResume(null); setView("settings"); }}>Cancel</button><button className="primary update-now-action" disabled={busy} onClick={() => void signIn()}>{busy ? <Loader2 size={14} className="spin" /> : null} Sign in</button></>}>
        <div className="online-board-body">
          <p>{resume ? "This computer's Planban sign-in has ended. Sign in again to carry on." : "Taking a board online needs your Planban account."} Sign in opens in a new browser tab, with an email code or GitHub.</p>
          {signInLink ? <p>Your browser blocked the sign-in tab. <a href={signInLink} target="_blank" rel="noopener noreferrer">Open the sign-in page</a>.</p> : null}
          {busy ? <p className="muted">Waiting for you to finish signing in…</p> : null}
          {errorLine}
        </div>
      </Modal>
    );
  }

  if (view === "confirm-online") {
    const preview = conversion;
    return (
      <Modal eyebrow="Board settings" title={`Take ${boardTitle} online?`} onClose={onClose}
        footer={<><button onClick={() => setView("settings")}>Cancel</button><button className="primary update-now-action" disabled={busy || !conversion || !conversion.clean} onClick={() => void takeOnline()}><Cloud size={14} /> Take online</button></>}>
        <div className="online-board-body">
          <ul>
            <li>The whole board, including specs, plans and history, is copied to your Planban account.</li>
            <li>From then on the online board is the one you and your agents edit. This Mac keeps an automatic backup copy.</li>
            <li>Agents on this Mac keep working. Each one will ask you to sign in once.</li>
            <li>Nobody else can see the board until you invite them.</li>
          </ul>
          {!preview ? <p className="muted">Checking the board…</p> : !preview.clean ? (
            <div className="online-board-calm">
              <b>Tidy this board first.</b> Planban holds text only and refers to files where they live, so {preview.files ? `${preview.files} file${preview.files === 1 ? "" : "s"}` : "some content"}{preview.files && preview.pictures ? " and " : ""}{preview.pictures ? `${preview.pictures} picture${preview.pictures === 1 ? "" : "s"}` : ""} must move out of the board before it can go online. Nothing has moved.
              <ul className="conversion-list">{preview.boardProblems.map((problem) => <li key={problem}><b>The board itself</b>: {problem}</li>)}{preview.cards.map((card) => (
                <li key={card.cardId}><b>{card.title}</b>: {[...card.files, ...card.pictures.map((picture) => `picture in the ${picture.kind === "plan" ? "Plan" : "Spec"}${picture.alt ? ` (${picture.alt})` : ""}`), ...card.problems].join("; ")}</li>
              ))}</ul>
              <p className="muted" style={{ whiteSpace: "pre-line", margin: "8px 0 0", fontSize: 12 }}>{preview.howToTidy.split("\n").slice(1).join("\n")}</p>
            </div>
          ) : null}
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
    const outcome = job.outcome;
    const place = outcome?.location === "online" ? "online" : "on this Mac";
    const title = outcome?.unchanged ? `${boardTitle} is still ${place}` : online ? `Taking ${boardTitle} online did not finish` : `Taking ${boardTitle} back to this Mac did not finish`;
    return (
      <Modal eyebrow="Board settings" title={title} onClose={onClose}
        footer={<><button onClick={onClose}>Close</button>{outcome?.retry ? <button className="primary update-now-action" disabled={busy} onClick={() => void (online ? takeOnline() : takeLocal())}>{outcome.retry === "Take online" || outcome.retry === "Take local" ? "Try again" : outcome.retry}</button> : null}</>}>
        <div className="online-board-body">
          <div className="online-board-calm">
            {outcome?.unchanged ? <><b>Nothing has changed.</b>{" "}{outcome.message.replace(/^Nothing has changed\.\s*/, "")}</> : outcome?.message ?? "Planban could not tell where this board stands. Open Board settings again in a moment."}
          </div>
          <p className="muted" style={{ marginTop: 12 }}>{job.error}</p>
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
    ? <div className="online-board-row"><div className="grow"><b><Users size={14} /> {others.length ? `You and ${others.length} other ${others.length === 1 ? "person" : "people"}` : "Only you"}</b><small>Invite people, choose their roles and what their agents may do.</small></div><button className="online-board-button" onClick={onManagePeople}>Manage people</button></div>
    : <div className="online-board-row"><div className="grow"><b><Users size={14} /> Only you</b><small>Take the board online to invite people.</small></div></div>;
  return (
    <Modal eyebrow={boardTitle} title="Board settings" onClose={onClose}>
      {job && job.status === "stopped" ? <p className="online-board-note"><Check size={13} /> Take Online stopped. The board is on this Mac, unchanged.</p> : null}
      {job && job.status === "succeeded" && job.noteCommit ? (
        <div className="online-board-section">
          <h3>Let your other machines know</h3>
          <p className="muted" style={{ margin: "0 0 8px", fontSize: 12, lineHeight: "18px" }}>
            {job.kind === "take-online"
              ? "Planban left a short note in this project's .planban folder saying the board is online. Commit it, and any machine with the project will treat its old copy as read-only and suggest signing in, even before it goes online."
              : "The project's note saying the board was online has been removed. Commit the removal so your other machines know."}
          </p>
          <input className="online-board-input" readOnly value={job.noteCommit.replace(/^.*?: (?=git )/, "")} onFocus={(event) => event.target.select()} aria-label="Command to commit the note" />
        </div>
      ) : null}
      <div className="online-board-section"><h3>Where this board lives</h3>{where}</div>
      <div className="online-board-section"><h3>People</h3>{people}</div>
      {errorLine ? <div className="online-board-section">{errorLine}</div> : null}
    </Modal>
  );
}

/**
 * Shown on an older local copy of a board that has since gone online
 * (owner decision 15). Reading still works; every change is refused until the
 * person chooses. Nothing is chosen for them.
 */
export function OlderCopyBanner({ repoId, boardTitle, status, reload }: {
  repoId: string;
  boardTitle: string;
  status: OnlineStatus | null;
  reload: () => Promise<void>;
}) {
  const [choice, setChoice] = useState<"use-online" | "keep-separate" | null>(null);
  const current = status?.location === "local" ? status.stale ?? null : null;
  // Keeps the choice open (and its result showing) after the board switches over.
  const [shown, setShown] = useState(current);
  useEffect(() => {
    if (current) setShown(current);
  }, [current]);
  const stale = current ?? (choice ? shown : null);
  if (!stale) return null;
  const since = new Date(stale.onlineSince).toLocaleDateString(undefined, { day: "numeric", month: "long" });
  return (
    <>
      {current ? <div className="older-copy-banner" role="status">
        <Info size={16} />
        <div className="grow">
          <b>This board is now online, so this copy is read-only</b>
          <p>{stale.title} was taken online on {since}. This copy on this Mac is from before then. Nothing has been lost: the online board has everything up to that day plus all changes since. This copy stays exactly as it was until you choose.{stale.signInNeeded ? " This Mac is not signed in to Planban yet; using the online board starts with signing in." : ""}</p>
        </div>
        <div className="acts">
          <button className="online-board-button" onClick={() => setChoice("keep-separate")}>Keep as a separate board…</button>
          <button className="online-board-button primary-accent" onClick={() => setChoice("use-online")}><Cloud size={13} /> Use the online board</button>
        </div>
      </div> : null}
      {choice ? <OlderCopyChoice repoId={repoId} boardTitle={boardTitle} since={since} choice={choice} reload={reload} onClose={() => setChoice(null)} /> : null}
    </>
  );
}

function OlderCopyChoice({ repoId, boardTitle, since, choice, reload, onClose }: {
  repoId: string;
  boardTitle: string;
  since: string;
  choice: "use-online" | "keep-separate";
  reload: () => Promise<void>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(`${boardTitle} (copy from ${since})`);
  const [signInLink, setSignInLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setError(null);
    try {
      if (choice === "use-online") {
        const use = () => request(`/api/boards/${encodeURIComponent(repoId)}/online/use-online`, {});
        await use().catch(async (failure) => {
          // Not signed in yet (the project's note told this Mac the board is online): sign in, then switch.
          if (!(failure instanceof RequestError) || typeof failure.body.signInNeeded !== "string") throw failure;
          await browserSignIn(failure.body.signInNeeded, setSignInLink);
          await use();
        });
        onClose();
      } else {
        const result = await request<{ separateBoard: { title: string } }>(`/api/boards/${encodeURIComponent(repoId)}/online/keep-separate`, { title });
        setDone(`"${result.separateBoard.title}" is now its own board on this Mac, in your list of boards. This project uses the online ${boardTitle}.`);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      await reload();
    }
  }
  if (done) {
    return (
      <Modal eyebrow={`Older copy of ${boardTitle}`} title="Kept as a separate board" onClose={onClose} footer={<button className="primary update-now-action" onClick={onClose}>Done</button>}>
        <div className="online-board-body"><p>{done}</p></div>
      </Modal>
    );
  }
  if (choice === "use-online") {
    return (
      <Modal eyebrow={`Older copy of ${boardTitle}`} title="Use the online board on this Mac?" onClose={onClose}
        footer={<><button onClick={onClose}>Cancel</button><button className="primary update-now-action" disabled={busy} onClick={() => void go()}><Cloud size={14} /> Use the online board</button></>}>
        <div className="online-board-body">
          <ul>
            <li>This Mac opens and edits the online {boardTitle} from now on.</li>
            <li>This older copy is kept as a backup, so nothing on this Mac is thrown away.</li>
            <li>Agents in this project folder switch to the online board the next time they use Planban.</li>
          </ul>
          {signInLink ? <p>Your browser blocked the sign-in tab. <a href={signInLink} target="_blank" rel="noopener noreferrer">Open the sign-in page</a>; this finishes once you have signed in.</p> : null}
          {error ? <p className="online-board-error" role="alert">{error}</p> : null}
        </div>
      </Modal>
    );
  }
  return (
    <Modal eyebrow={`Older copy of ${boardTitle}`} title="Keep this copy as a separate board?" onClose={onClose}
      footer={<><button onClick={onClose}>Cancel</button><button className="primary update-now-action" disabled={busy || !title.trim()} onClick={() => void go()}>Keep as separate board</button></>}>
      <div className="online-board-body">
        <p>This copy becomes its own board on this Mac, with its own name. It is not linked to the online {boardTitle}, and changes in one never reach the other.</p>
        <label className="muted" htmlFor="older-copy-name" style={{ display: "block", fontSize: 12, margin: "4px 0 6px" }}>Name</label>
        <input id="older-copy-name" className="online-board-input" value={title} onChange={(event) => setTitle(event.target.value)} />
        <p className="muted" style={{ marginTop: 12 }}>Agents in this project folder will use the online {boardTitle}. To point them at this copy instead, ask your agent.</p>
        {error ? <p className="online-board-error" role="alert">{error}</p> : null}
      </div>
    </Modal>
  );
}

export interface BoardPerson {
  userId: string;
  name: string;
  imageUrl: string | null;
  role: "owner" | "editor" | "viewer";
  agentLevel: "read" | "plan" | "complete";
  you: boolean;
}

export interface CardChange {
  userId: string;
  agent: boolean;
  clientName: string | null;
  at: string;
  summary: string;
}

export interface BoardPeople {
  shared: boolean;
  people: BoardPerson[];
  cards: Record<string, CardChange>;
}

/** People and card changes for an online board; refreshed when the board changes. */
export function useBoardPeople(repoId: string | null, online: boolean, refreshKey: unknown) {
  const [people, setPeople] = useState<BoardPeople | null>(null);
  const load = useCallback(async () => {
    if (!repoId || !online) {
      setPeople(null);
      return;
    }
    setPeople(await request<BoardPeople>(`/api/boards/${encodeURIComponent(repoId)}/online/people`).catch(() => null));
  }, [repoId, online]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  return { people, reload: load };
}

/** Faces appear only on shared boards (owner decision 15); boards with one person look as they always have. */
export const BoardPeopleContext = createContext<BoardPeople | null>(null);

const FACE_COLOURS = [["#efe6d8", "#6b5232"], ["#dde9f5", "#2c5c88"], ["#e3efe2", "#3c6a39"], ["#f3e1e6", "#87394f"], ["#e7e3f3", "#4b3f86"], ["#f4ead2", "#7a5a12"]] as const;

function colourFor(userId: string) {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return FACE_COLOURS[hash % FACE_COLOURS.length]!;
}

function initials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words.at(-1)![0] : "")).toUpperCase();
}

export function Face({ person, agent = false, size = 18 }: { person: Pick<BoardPerson, "userId" | "name" | "imageUrl">; agent?: boolean; size?: number }) {
  const [background, foreground] = colourFor(person.userId);
  return (
    <span className={`person-face ${agent ? "has-agent" : ""}`} style={{ width: size, height: size, background, color: foreground, fontSize: Math.round(size * 0.42) }}>
      {person.imageUrl ? <img src={person.imageUrl} alt="" referrerPolicy="no-referrer" /> : initials(person.name)}
      {agent ? <span className="person-face-agent"><Bot size={11} /></span> : null}
    </span>
  );
}

function timeAgo(at: string) {
  const minutes = Math.round((Date.now() - Date.parse(at)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The face of whoever last changed a card, on shared boards only. */
export function CardFace({ cardId }: { cardId: string }) {
  const board = useContext(BoardPeopleContext);
  if (!board?.shared) return null;
  const change = board.cards[cardId];
  if (!change) return null;
  const person = board.people.find((entry) => entry.userId === change.userId) ?? { userId: change.userId, name: change.userId, imageUrl: null };
  const who = change.agent ? `${person.name}'s agent${change.clientName ? ` (${change.clientName})` : ""}` : person.name;
  return (
    <span className="card-face" title={`${who}: ${change.summary} · ${timeAgo(change.at)}`}>
      <Face person={person} agent={change.agent} />
    </span>
  );
}

/** "Maya Okafor" or "Maya Okafor's agent (Claude)" for a history entry on a shared board, else null. */
export function useChangeAuthor(attribution: { userId: string; clientName: string; actor: string } | undefined, actor?: string) {
  const board = useContext(BoardPeopleContext);
  if (!board?.shared) return null;
  if (!attribution) {
    // Versions made in Local Mode, before the board went online: the owner's, or the owner's agents'.
    const owner = board.people.find((entry) => entry.role === "owner");
    if (!owner) return null;
    return { person: owner, agent: actor === "agent", via: null };
  }
  const person = board.people.find((entry) => entry.userId === attribution.userId) ?? { userId: attribution.userId, name: attribution.userId, imageUrl: null };
  return { person, agent: attribution.actor === "agent", via: attribution.actor === "agent" ? attribution.clientName : null };
}

/** On shared boards: the face and name of whoever made a history entry, and the agent they used. */
export function HistoryAuthor({ attribution, actor }: { attribution?: { userId: string; clientName: string; actor: string } | undefined; actor?: string }) {
  const author = useChangeAuthor(attribution, actor);
  if (!author) return null;
  return (
    <span className="history-author">
      <Face person={author.person} size={16} />
      <span>{author.person.name}</span>
      {author.agent ? <span className="history-author-chip"><Bot size={10} /> {author.via ?? "agent"}</span> : null}
    </span>
  );
}

const LEVEL_LABEL = { read: "Read", plan: "Plan", complete: "Plan and complete" } as const;
const ROLE_LABEL = { owner: "Owner", editor: "Editor", viewer: "Viewer" } as const;

/** An invitation nobody has used up yet, as the owner's invite list returns it. */
export interface WaitingInvite {
  id: string;
  role: "editor" | "viewer";
  email: string | null;
  createdAt: string;
  expiresAt: string;
  joined: number;
}

/** The owner's waiting invitations, each with Cancel, so an address can be invited again. */
export function WaitingInvites({ invites, busy, onCancel }: { invites: WaitingInvite[]; busy: boolean; onCancel: (invite: WaitingInvite) => void }) {
  if (!invites.length) return null;
  const until = (at: string) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return (
    <div className="online-board-section"><h3>Waiting invitations</h3>
      {invites.map((invite) => (
        <div className="people-row" key={invite.id}>
          <span className="face-col connection-icon">{invite.email ? <Mail size={14} /> : <Link size={14} />}</span>
          <div className="who"><b>{invite.email ?? "Invite link"}</b>
            <small>{invite.email ? "Invited" : "Created"} {timeAgo(invite.createdAt)} · works until {until(invite.expiresAt)}{invite.email ? "" : ` · ${invite.joined ? `${invite.joined} joined` : "nobody has joined yet"}`}</small></div>
          <div className="col"><span className="muted">{ROLE_LABEL[invite.role]}</span></div>
          <button className="online-board-button quiet" disabled={busy} aria-label={`Cancel the invitation ${invite.email ? `for ${invite.email}` : "link"}`} onClick={() => onCancel(invite)}>Cancel</button>
        </div>
      ))}
    </div>
  );
}

/**
 * People on an online board (approved mockup): each person's role, and what
 * their agents may do. You choose for your own agents; you can see the
 * others' choices. The owner changes roles and removes people.
 */
export function PeopleModal({ repoId, boardTitle, onInvite, onClose }: { repoId: string; boardTitle: string; onInvite: () => void; onClose: () => void }) {
  const [board, setBoard] = useState<BoardPeople | null>(null);
  const [invites, setInvites] = useState<WaitingInvite[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/boards/${encodeURIComponent(repoId)}/online`;
  const loads = useRef(0);
  const load = useCallback(async () => {
    // Only the newest load may update the panel, so an older answer can't bring back a cancelled invitation.
    const current = ++loads.current;
    const failed = (failure: unknown, prefix = "") => {
      if (current === loads.current) setError(prefix + (failure instanceof Error ? failure.message : String(failure)));
      return null;
    };
    const people = await request<BoardPeople>(`${base}/people`).catch((failure) => failed(failure));
    // Only the owner may see invitations; anyone else would be refused.
    const owner = people?.people.some((person) => person.you && person.role === "owner");
    const waiting = owner ? await request<{ invites: WaitingInvite[] }>(`${base}/invites`).catch((failure) => failed(failure, "Planban couldn't show the waiting invitations: ")) : null;
    if (current !== loads.current) return;
    setBoard(people);
    setInvites(waiting?.invites ?? []);
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      await load();
      setBusy(false);
    }
  }
  const me = board?.people.find((person) => person.you);
  const iOwn = me?.role === "owner";
  const myLevels = (["read", "plan", "complete"] as const).filter((level) => me?.role !== "viewer" || level === "read");
  return (
    <Modal eyebrow={boardTitle} title="People" onClose={onClose}
      footer={iOwn ? <button className="primary update-now-action" onClick={onInvite}><Users size={14} /> Invite people</button> : undefined}>
      <div className="online-board-section">
        <div className="people-colhead"><span className="face-col" /><span className="who">Person</span><span className="col">Role</span><span className="col wide">Their agents may</span></div>
        {!board ? <p className="muted">Loading…</p> : board.people.map((person) => (
          <div className="people-row" key={person.userId}>
            <Face person={person} size={28} />
            <div className="who"><b>{person.name}{person.you ? <span className="muted"> (you)</span> : null}</b><small>{person.you ? "You" : ROLE_LABEL[person.role]}</small></div>
            <div className="col">
              {iOwn && person.role !== "owner" ? (
                <select className="online-board-select" value={person.role} disabled={busy} aria-label={`${person.name}'s role`}
                  onChange={(event) => void act(() => request(`${base}/members/${encodeURIComponent(person.userId)}/role`, { role: event.target.value }))}>
                  <option value="editor">Editor</option><option value="viewer">Viewer</option>
                </select>
              ) : <span className="muted">{ROLE_LABEL[person.role]}</span>}
            </div>
            <div className="col wide">
              {person.you ? (
                <select className="online-board-select" value={person.agentLevel} disabled={busy} aria-label="What your agents may do"
                  onChange={(event) => void act(() => request(`${base}/people/me/agents`, { level: event.target.value }))}>
                  {myLevels.map((level) => <option key={level} value={level}>{LEVEL_LABEL[level]}</option>)}
                </select>
              ) : <span className="muted">{LEVEL_LABEL[person.agentLevel]}</span>}
            </div>
            {iOwn && person.role !== "owner" ? (
              <button className="online-board-button quiet" disabled={busy} aria-label={`Remove ${person.name}`}
                onClick={() => {
                  if (window.confirm(`Remove ${person.name} from ${boardTitle}? They and their agents lose access at once.`)) {
                    void act(() => request(`${base}/members/${encodeURIComponent(person.userId)}/remove`, {}));
                  }
                }}>Remove</button>
            ) : <span className="remove-col" />}
          </div>
        ))}
      </div>
      {iOwn ? <WaitingInvites invites={invites} busy={busy} onCancel={(invite) => {
        if (window.confirm(invite.email ? `Cancel the invitation for ${invite.email}? Its link stops working.` : "Cancel this invite link? It stops working, and people who already joined stay on the board.")) {
          void act(() => request(`${base}/invites/${encodeURIComponent(invite.id)}/revoke`, {}));
        }
      }} /> : null}
      <div className="online-board-section"><p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: "18px" }}>Each person chooses what their own agents may do: read, plan, or plan and complete. An agent can never do more than its person. You choose for your agents; you can see the others' choices.</p></div>
      {error ? <div className="online-board-section"><p className="online-board-error" role="alert">{error}</p></div> : null}
    </Modal>
  );
}

/** Invite by email or by link (approved mockup); links last 7 days. */
export function InviteModal({ repoId, boardTitle, onClose }: { repoId: string; boardTitle: string; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [emailRole, setEmailRole] = useState<"editor" | "viewer">("editor");
  const [linkRole, setLinkRole] = useState<"editor" | "viewer">("viewer");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const base = `/api/boards/${encodeURIComponent(repoId)}/online/invites`;
  async function invite(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await request<{ link: string; emailSent: boolean }>(base, body);
      setMade(result.link);
      const copied = await navigator.clipboard?.writeText(result.link).then(() => true, () => false);
      setNote(body.email
        ? result.emailSent ? `Sent. ${String(body.email)} gets an email from Planban with a link to sign in and open this board.` : `Planban cannot send emails yet, so send ${String(body.email)} this link yourself${copied ? " (copied)" : ""}. It only works for their email address.`
        : copied ? "Link copied. It works for 7 days." : "Copy this link; it works for 7 days.");
      if (body.email) setEmail("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal eyebrow={boardTitle} title="Invite people" onClose={onClose}>
      <div className="online-board-section"><h3>By email</h3>
        <div className="online-board-row">
          <input className="online-board-input" type="email" placeholder="name@example.com" value={email} onChange={(event) => setEmail(event.target.value)} aria-label="Email address" />
          <select className="online-board-select" value={emailRole} onChange={(event) => setEmailRole(event.target.value as "editor" | "viewer")} aria-label="Role"><option value="editor">Editor</option><option value="viewer">Viewer</option></select>
          <button className="online-board-button primary-accent" disabled={busy || !email.trim()} onClick={() => void invite({ email, role: emailRole })}><Mail size={13} /> Send invite</button>
        </div>
      </div>
      <div className="online-board-section"><h3>By link</h3>
        <div className="online-board-row">
          <div className="grow"><b><Link size={14} /> Anyone with the link can join as</b><small>The link works for 7 days. Each person still signs in with their own account.</small></div>
          <select className="online-board-select" value={linkRole} onChange={(event) => setLinkRole(event.target.value as "editor" | "viewer")} aria-label="Role for the link"><option value="viewer">Viewer</option><option value="editor">Editor</option></select>
          <button className="online-board-button" disabled={busy} onClick={() => void invite({ role: linkRole })}><Copy size={13} /> Copy link</button>
        </div>
        {made ? <input className="online-board-input" style={{ marginTop: 10 }} readOnly value={made} onFocus={(event) => event.target.select()} aria-label="Invite link" /> : null}
        {note ? <p className="muted" style={{ margin: "8px 0 0", fontSize: 12 }}>{note}</p> : null}
        {error ? <p className="online-board-error" role="alert">{error}</p> : null}
      </div>
      <div className="online-board-section"><h3>What the roles mean</h3>
        <div className="online-board-body" style={{ padding: 0, fontSize: 12, lineHeight: "18px" }}>
          <p style={{ margin: "0 0 4px" }}><b>Owner</b> <span className="muted">can do everything, including inviting people and taking the board online or local.</span></p>
          <p style={{ margin: "0 0 4px" }}><b>Editor</b> <span className="muted">can change cards, specs and plans, and mark work complete.</span></p>
          <p style={{ margin: 0 }}><b>Viewer</b> <span className="muted">can read the board and its history.</span></p>
        </div>
      </div>
    </Modal>
  );
}

interface Connection {
  id: string;
  kind: "dev" | "machine" | "oauth" | "key";
  name: string;
  clientName: string;
  boards: "all" | string[];
  level: "read" | "plan" | "complete";
  lastUsedAt: string;
  active: boolean;
  current: boolean;
}

/** Your connections, under your account (approved mockup): each agent and key, what it may do, when it was last used. */
/** A claude.ai self-registration this person approved (owner decision 22). */
type Registration = { id: string; name: string; registeredAt: string; connected: boolean };

export function ConnectionsModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<{ signedIn: boolean; command?: string; connections: Connection[]; registrations?: Registration[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => setData(await request<{ signedIn: boolean; connections: Connection[]; registrations?: Registration[] }>("/api/online/connections").catch((failure) => {
    setError(failure instanceof Error ? failure.message : String(failure));
    return null;
  })), []);
  useEffect(() => {
    void load();
  }, [load]);
  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
      await load();
    }
  }
  const live = (data?.connections ?? []).filter((connection) => connection.active);
  const agents = live.filter((connection) => connection.kind === "oauth" || (connection.kind === "dev" && connection.boards !== "all"));
  const machines = live.filter((connection) => connection.kind === "machine" || (connection.kind === "dev" && connection.boards === "all"));
  const keys = live.filter((connection) => connection.kind === "key");
  const where = (connection: Connection) => connection.boards === "all" ? "All your boards" : connection.boards.join(", ");
  const row = (connection: Connection, icon: React.ReactNode, levelEditable: boolean) => (
    <div className="people-row" key={connection.id}>
      <span className="face-col connection-icon">{icon}</span>
      <div className="who"><b>{connection.kind === "oauth" ? connection.clientName : connection.name}{connection.current ? <span className="muted"> (this Mac)</span> : null}</b><small>{where(connection)} · last used {timeAgo(connection.lastUsedAt)}</small></div>
      <div className="col wide">
        {levelEditable ? (
          <select className="online-board-select" value={connection.level} disabled={busy} aria-label="What it may do"
            onChange={(event) => void act(() => request(`/api/online/connections/${encodeURIComponent(connection.id)}/access`, { level: event.target.value }))}>
            {(["read", "plan", "complete"] as const).map((level) => <option key={level} value={level}>{LEVEL_LABEL[level]}</option>)}
          </select>
        ) : <span className="muted">{connection.kind === "machine" ? "Everything you can do" : LEVEL_LABEL[connection.level]}</span>}
      </div>
      {connection.current ? <span className="remove-col" /> : (
        <button className="online-board-button" disabled={busy} onClick={() => void act(() => request(`/api/online/connections/${encodeURIComponent(connection.id)}/revoke`, {}))}>Cut off</button>
      )}
    </div>
  );
  const cutOffEverything = () => {
    if (!window.confirm("Cut off every other agent, key, machine and Claude registration on your account? This Mac stays signed in.")) return;
    // The service revokes the complete set, not just what this list shows.
    void act(async () => {
      const result = await request<{ complete: boolean }>("/api/online/connections/revoke-others", {});
      if (!result.complete) throw new Error("Some connections are still being cut off. Choose Cut off everything again to finish.");
    });
  };
  return (
    <Modal eyebrow="Your account" title="Connections" onClose={onClose}
      footer={data?.signedIn ? <button className="danger" disabled={busy} onClick={cutOffEverything}>Cut off everything</button> : undefined}>
      {!data ? <div className="online-board-section"><p className="muted">Loading…</p></div> : !data.signedIn ? (
        <div className="online-board-section"><p className="muted">This Mac is not signed in to Planban Online. Connections appear here once you take a board online.</p></div>
      ) : (
        <>
          <div className="online-board-section"><h3>Agents</h3>{agents.length ? agents.map((connection) => row(connection, <Bot size={16} />, connection.kind === "oauth")) : <p className="muted">No AI apps are connected.</p>}</div>
          <div className="online-board-section"><h3>Machines</h3>{machines.map((connection) => row(connection, <Laptop size={16} />, false))}</div>
          {data.registrations?.length ? (
            <div className="online-board-section"><h3>Claude registrations</h3>
              {data.registrations.map((registration) => (
                <div className="people-row" key={registration.id}>
                  <span className="face-col connection-icon"><Bot size={16} /></span>
                  <div className="who"><b>{registration.name}</b><small>Registered {timeAgo(registration.registeredAt)} · {registration.connected ? "connected" : "not connected"}</small></div>
                  <div className="col wide" />
                  <button className="online-board-button" disabled={busy} onClick={() => void act(() => request(`/api/online/connections/${encodeURIComponent(registration.id)}/revoke`, {}))}>Remove</button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="online-board-section"><h3>Personal access keys</h3>{keys.length ? keys.map((connection) => row(connection, <KeyRound size={16} />, false)) : <p className="muted">No keys. Create one from the command line with <code>{data?.command ?? "planban"} online keys create</code>.</p>}</div>
        </>
      )}
      {error ? <div className="online-board-section"><p className="online-board-error" role="alert">{error}</p></div> : null}
    </Modal>
  );
}
