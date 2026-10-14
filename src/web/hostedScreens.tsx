// The screens only the web page has (Planban 2.0 plan, phase 4; approved
// mockup sections 5, 6, 7 and 9): Log in or sign up, the board list with its
// first-run checklist and waiting invitations, invitations, one-tap approval
// of an agent's sign-in, and the account menu.
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy, Loader2, Plus } from "lucide-react";
import { ConnectionsModal, NewBoardModal } from "./onlineBoard";
import { pageFetch } from "./transport";
import {
  clearApproval, clearInvite, loadClerk, pendingApproval, pendingInvite, previewInvite, rememberAccount, rememberedAccount,
  safeNext, signInSettings, signOutWeb, startWebSession, type ClerkBrowser, type InvitePreview,
} from "./webAccount";

type Json = Record<string, unknown>;

/** The page's own routes on the web, answered by the hosted adapter. Errors carry the service's status and reason. */
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await pageFetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Planban-Client": "web" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await response.json().catch(() => ({})) as Json;
  if (!response.ok) throw Object.assign(new Error(typeof json.error === "string" ? json.error : `Planban answered ${response.status}.`), { status: response.status, body: json });
  return json as T;
}

const statusOf = (error: unknown) => (error as { status?: number } | null)?.status;
const reasonOf = (error: unknown) => (error as { body?: Json } | null)?.body?.reason as string | undefined;

export function signInPath(next = `${window.location.pathname}${window.location.search}${window.location.hash}`) {
  return `/sign-in?next=${encodeURIComponent(next)}`;
}

/** Which web-only screen this address is, if any. */
export function webScreen(pathname = window.location.pathname): "sign-in" | "invite" | "approve" | null {
  if (pathname === "/sign-in") return "sign-in";
  if (pathname.startsWith("/invite/")) return "invite";
  if (pathname === "/approve") return "approve";
  return null;
}

function Wordmark({ height = 20 }: { height?: number }) {
  return (
    <picture className="web-wordmark">
      <source srcSet="/assets/planban-logo-wordmark-white.svg" media="(prefers-color-scheme: dark)" />
      <img src="/assets/planban-logo-wordmark-black.svg" alt="Planban" style={{ height }} />
    </picture>
  );
}

function initials(account: { email: string | null; name: string | null } | null) {
  const source = account?.name?.trim() || account?.email?.split("@")[0] || "";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "·";
}

/** The person's avatar, opening the account menu: who is signed in, Connections, and Sign out. */
export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = rememberedAccount();
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const items = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    // Focus goes into the menu, onto its first item.
    items()[0]?.focus();
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  const onMenuKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      list[(at + (event.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? list[0] : list.at(-1))?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    }
  };
  async function signOut() {
    setError(null);
    try {
      await signOutWeb();
      window.location.assign("/sign-in");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }
  return (
    <div className="web-account" ref={ref}>
      <button ref={triggerRef} className="web-avatar" aria-label="Your account" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); setOpen(true); } }}>{initials(account)}</button>
      {open ? (
        <div className="web-account-menu" role="menu" aria-label="Your account" onKeyDown={onMenuKey}>
          {account?.email ? <p className="web-account-who">Signed in as <b>{account.email}</b></p> : null}
          <button role="menuitem" tabIndex={-1} onClick={() => { close(false); setConnections(true); }}>Connections</button>
          <button role="menuitem" tabIndex={-1} onClick={() => void signOut()}>Sign out</button>
          {error ? <p className="web-account-note" role="alert">{error}</p> : null}
          <p className="web-account-note">To delete your account, email hello@planban.ai.</p>
        </div>
      ) : null}
      {connections ? <ConnectionsModal onClose={() => { setConnections(false); triggerRef.current?.focus(); }} /> : null}
    </div>
  );
}

function AppHeader() {
  return (
    <header className="web-apphead">
      <a href="/" aria-label="Your boards"><Wordmark /></a>
      <span className="web-apphead-right"><AccountMenu /></span>
    </header>
  );
}

/** Log in or sign up (approved mockup section 5): Clerk's own sign-in, then this browser's Planban session. */
export function SignInPage() {
  const next = safeNext(new URLSearchParams(window.location.search).get("next"));
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "finishing" | "unavailable" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const clerkRef = useRef<ClerkBrowser | null>(null);
  const finishing = useRef(false);
  // Clerk's own check before creating an account shows no text inside our layout; say what's happening.
  const [checking, setChecking] = useState(() => window.location.hash.includes("protect-check"));
  useEffect(() => {
    const onHash = () => setChecking(window.location.hash.includes("protect-check"));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const finish = useCallback(async (clerk: ClerkBrowser) => {
    if (finishing.current) return;
    finishing.current = true;
    setStatus("finishing");
    try {
      const token = await clerk.session?.getToken();
      if (!token) throw new Error("Sign-in didn't finish. Try again.");
      await startWebSession(token);
      rememberAccount({ email: clerk.user?.primaryEmailAddress?.emailAddress ?? null, name: clerk.user?.fullName ?? null });
      window.location.assign(next);
    } catch (error) {
      finishing.current = false;
      setMessage(error instanceof Error ? error.message : String(error));
      setStatus("error");
    }
  }, [next]);

  useEffect(() => {
    let cancelled = false;
    let stopListening: (() => void) | null = null;
    void (async () => {
      try {
        const settings = await signInSettings();
        if (cancelled) return;
        if (!settings) return setStatus("unavailable");
        const clerk = await loadClerk(settings);
        if (cancelled) return;
        clerkRef.current = clerk;
        if (clerk.session?.status === "active") return void finish(clerk);
        setStatus("ready");
        stopListening = clerk.addListener(({ session }) => {
          if (session?.status === "active") void finish(clerk);
        });
        if (mountRef.current) {
          clerk.mountSignIn(mountRef.current, {
            withSignUp: true,
            // GitHub sends people back here, which then finishes on its own.
            forceRedirectUrl: window.location.href,
            signUpForceRedirectUrl: window.location.href,
            appearance: {
              layout: { socialButtonsPlacement: "top", logoPlacement: "none" },
              elements: { header: { display: "none" }, footer: { display: "none" }, card: { boxShadow: "none", border: "0", padding: "0", background: "transparent" }, rootBox: { width: "100%" }, cardBox: { width: "100%", boxShadow: "none", border: "0" } },
            },
          });
        }
      } catch (error) {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : String(error));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      stopListening?.();
      const element = mountRef.current;
      if (element && clerkRef.current) clerkRef.current.unmountSignIn(element);
    };
  }, [finish]);

  async function startAgain() {
    // A sign-in Planban won't accept any more (for example after Sign out other devices) needs a fresh one.
    await clerkRef.current?.signOut().catch(() => undefined);
    window.location.reload();
  }

  return (
    <main className="web-screen web-signin">
      <div className="web-signin-card">
        <Wordmark height={22} />
        <h1>Log in or sign up</h1>
        <p className="web-sub">Free. Your boards stay private until you share them.</p>
        {status === "unavailable" ? <p className="web-note" role="alert">Sign-in isn't available here yet.</p> : null}
        <div ref={mountRef} className="web-clerk" hidden={status !== "ready"} />
        {status === "ready" && checking ? <p className="web-muted" role="status"><Loader2 size={14} className="spin" /> Checking this browser before creating your account…</p> : null}
        {status === "loading" || status === "finishing" ? <p className="web-muted" role="status"><Loader2 size={14} className="spin" /> {status === "loading" ? "Loading sign-in…" : "Signing you in…"}</p> : null}
        {status === "error" ? (
          <div className="web-note" role="alert">
            <p>{message}</p>
            <button className="web-button" onClick={() => void startAgain()}>Sign in again</button>
          </div>
        ) : null}
        <p className="web-muted">We'll email you a code. No password.</p>
        <p className="web-foot">New here? The same steps create your account.</p>
      </div>
    </main>
  );
}

interface ListedBoard {
  repoId: string;
  title: string;
  online?: { role: "owner" | "editor" | "viewer"; authority: string; lastChangedAt: string; people?: number; needYou?: number; ownerName?: string };
}

const ROLE = { owner: "Owner", editor: "Editor", viewer: "Viewer" } as const;

function changedAgo(at: string | undefined) {
  if (!at) return "";
  const then = Date.parse(at);
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "changed just now";
  if (minutes < 60) return `changed ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `changed ${hours} hour${hours === 1 ? "" : "s"} ago`;
  if (hours < 48) return "changed yesterday";
  return `changed ${new Date(then).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

function BoardRow({ board, onOpen }: { board: ListedBoard; onOpen: () => void }) {
  const online = board.online;
  const owned = online?.role === "owner";
  const others = Math.max(0, (online?.people ?? 1) - 1);
  const who = owned ? (others ? `You and ${others} other${others === 1 ? "" : "s"}` : "Only you") : `Shared by ${online?.ownerName ?? "someone"}`;
  const away = online && online.authority !== "online";
  return (
    <button className="web-row" onClick={onOpen}>
      <span className="web-row-main">
        <b>{board.title}</b>
        <small>{away ? "Taken back to a computer · read-only here" : [who, changedAgo(online?.lastChangedAt)].filter(Boolean).join(" · ")}</small>
      </span>
      {owned && online?.needYou ? <span className="web-needs">{online.needYou} need you</span> : null}
      {online ? <span className="web-role">{ROLE[online.role]}</span> : null}
      <ChevronRight size={16} className="web-row-arrow" aria-hidden="true" />
    </button>
  );
}

interface WaitingInvite { id: string; boardTitle: string; role: "editor" | "viewer"; inviterName: string }
const DISMISSED_KEY = "planban.web.notNow";

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="web-prompt">
      <span>{text}</span>
      <button onClick={() => void navigator.clipboard?.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); })}>
        {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
      </button>
    </div>
  );
}

/** A new account's checklist (approved mockup section 6). The last two steps tick themselves off. */
function FirstRun({ ownsOnlineBoard, appConnected, onNewBoard, agentDone, onToggleAgent, onHide }: {
  ownsOnlineBoard: boolean; appConnected: boolean; onNewBoard: () => void; agentDone: boolean; onToggleAgent: () => void; onHide?: () => void;
}) {
  const account = rememberedAccount();
  const toggleAgent = onToggleAgent;
  const step = (done: boolean, title: string, body: ReactNode, manual?: () => void) => (
    <li className={`web-step ${done ? "done" : ""}`}>
      {manual ? (
        <button className="web-step-box" role="checkbox" aria-checked={done} aria-label={`${title}: ${done ? "done" : "not done yet"}`} onClick={manual}>{done ? <Check size={11} /> : null}</button>
      ) : <span className="web-step-box" aria-hidden="true">{done ? <Check size={11} /> : null}</span>}
      <div><b>{title}{!manual ? <span className="visually-hidden">{done ? ", done" : ", not done yet"}</span> : null}</b>{body}</div>
    </li>
  );
  const mcp = `${window.location.origin}/mcp`;
  return (
    <section className="web-first-run" aria-labelledby="welcome-title">
      <h1 id="welcome-title" className="web-h">Welcome to Planban</h1>
      <p className="web-sub">Your online boards will appear here. Planban lives in your agents, so start there. The last two steps tick themselves off when Planban sees them happen. A board someone shares with you appears above these steps.</p>
      <ol className="web-steps">
        {step(true, "Create your account", <small>{account?.email ? `Signed in as ${account.email}.` : "You're signed in."}</small>)}
        {step(agentDone, "Put Planban in your agent", <><small>Paste this into Codex or Claude Code, then tick this off yourself:</small><CopyLine text="Install Planban from planban-ai/planban and open my board" /></>, toggleAgent)}
        {step(ownsOnlineBoard, "Take a board online", <><small>In Planban on your computer: Board settings, then Take online. Or ask your agent:</small><CopyLine text="Take this Planban board online" /></>)}
        {step(appConnected, "Connect ChatGPT or Claude", <><small>Add a connector with this address, then click Allow:</small><CopyLine text={mcp} /></>)}
      </ol>
      <p className="web-foot web-center">Or <button className="web-link" onClick={onNewBoard}>start an empty board here</button> · Invited? Open the link in your email.</p>
      {onHide ? <p className="web-foot web-center"><button className="web-link" onClick={onHide}>Hide these steps</button></p> : null}
    </section>
  );
}

/** Your boards (approved mockup section 7), with waiting invitations at the top. */
export function HostedDashboard({ boards, onSelectBoard, onBoardsChanged }: { boards: ListedBoard[]; onSelectBoard: (repoId: string) => void; onBoardsChanged: () => Promise<void> }) {
  const [newBoard, setNewBoard] = useState(false);
  const [invites, setInvites] = useState<WaitingInvite[]>([]);
  const [dismissed, setDismissed] = useState<string[]>(() => JSON.parse(sessionStorage.getItem(DISMISSED_KEY) ?? "[]") as string[]);
  const [appConnected, setAppConnected] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owned = boards.filter((board) => board.online?.role === "owner");
  const shared = boards.filter((board) => board.online && board.online.role !== "owner");
  const ownsOnlineBoard = owned.some((board) => board.online?.authority === "online");
  const [agentDone, setAgentDone] = useState(() => localStorage.getItem("planban.web.agentStep") === "1");
  const [stepsHidden, setStepsHidden] = useState(() => localStorage.getItem("planban.web.stepsHidden") === "1");
  const toggleAgent = () => {
    localStorage.setItem("planban.web.agentStep", agentDone ? "0" : "1");
    setAgentDone(!agentDone);
  };
  const hideSteps = () => {
    localStorage.setItem("planban.web.stepsHidden", "1");
    setStepsHidden(true);
  };
  // The checklist stays until every step is done (so the last ones are seen ticking off), or until hidden.
  const allDone = agentDone && ownsOnlineBoard && appConnected;
  const firstRun = (withHide: boolean) => (
    <FirstRun ownsOnlineBoard={ownsOnlineBoard} appConnected={appConnected} onNewBoard={() => setNewBoard(true)}
      agentDone={agentDone} onToggleAgent={toggleAgent} {...(withHide ? { onHide: hideSteps } : {})} />
  );

  const recheck = useCallback(async () => {
    const [waiting, connections] = await Promise.all([
      call<{ invitations: WaitingInvite[] }>("/api/online/invites").catch(() => ({ invitations: [] })),
      call<{ connections?: Array<{ kind: string; active?: boolean }> }>("/api/online/connections").catch(() => ({ connections: [] })),
    ]);
    setInvites(waiting.invitations);
    setAppConnected((connections.connections ?? []).some((connection) => connection.kind === "oauth" && connection.active !== false));
  }, []);
  useEffect(() => {
    void recheck();
    const onFocus = () => { if (!document.hidden) void recheck(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [recheck]);

  async function join(invite: WaitingInvite) {
    setBusy(invite.id);
    setError(null);
    try {
      const joined = await call<{ boardId: string; title: string }>(`/api/online/invites/${encodeURIComponent(invite.id)}/accept`, {});
      announceJoined(joined.title);
      await onBoardsChanged();
      onSelectBoard(joined.boardId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  }
  const notNow = (invite: WaitingInvite) => {
    const next = [...dismissed, invite.id];
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next));
    setDismissed(next);
  };
  const showing = invites.filter((invite) => !dismissed.includes(invite.id));

  return (
    <main className="web-screen">
      <AppHeader />
      <div className="web-wrap">
        {showing.map((invite) => (
          <div className="web-banner" key={invite.id}>
            <span><b>{invite.inviterName} invited you to {invite.boardTitle}</b> as {invite.role === "editor" ? "an editor" : "a viewer"}.</span>
            <button className="web-button dark" disabled={busy !== null} onClick={() => void join(invite)}>{busy === invite.id ? <Loader2 size={13} className="spin" /> : null}Join</button>
            <button className="web-button ghost" disabled={busy !== null} onClick={() => notNow(invite)}>Not now</button>
          </div>
        ))}
        {error ? <p className="web-note" role="alert">{error}</p> : null}
        {owned.length || shared.length ? (
          <>
            <div className="web-secthead">
              <h1 className="web-h">Your boards</h1>
              <button className="web-button dark" onClick={() => setNewBoard(true)}><Plus size={14} /> <span className="web-wide-only">New board</span><span className="web-narrow-only">New</span></button>
            </div>
            {owned.length ? <div className="web-panel">{owned.map((board) => <BoardRow key={board.repoId} board={board} onOpen={() => onSelectBoard(board.repoId)} />)}</div> : null}
            {shared.length ? (
              <>
                <div className="web-secthead"><h2>Shared with you</h2></div>
                <div className="web-panel">{shared.map((board) => <BoardRow key={board.repoId} board={board} onOpen={() => onSelectBoard(board.repoId)} />)}</div>
              </>
            ) : null}
            {owned.length ? <p className="web-foot">Boards on your computer stay there. To add one here, open it in the Planban app and choose Take online.</p> : null}
            {!allDone && !stepsHidden ? <div className="web-first-run-below">{firstRun(true)}</div> : null}
          </>
        ) : firstRun(false)}
      </div>
      {newBoard ? <NewBoardModal onClose={() => setNewBoard(false)} onCreated={(repoId) => {
        setNewBoard(false);
        void onBoardsChanged().then(() => onSelectBoard(repoId));
      }} /> : null}
    </main>
  );
}

const JOINED_KEY = "planban.web.joined";
export function announceJoined(title: string) {
  sessionStorage.setItem(JOINED_KEY, title);
}

/** "You joined Northfold", once, on the board just joined. */
export function JoinedNote() {
  const [title] = useState(() => {
    const value = sessionStorage.getItem(JOINED_KEY);
    sessionStorage.removeItem(JOINED_KEY);
    return value;
  });
  const [shown, setShown] = useState(Boolean(title));
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(false), 5000);
    return () => window.clearTimeout(timer);
  }, [shown]);
  return shown && title ? <div className="web-toast" role="status">You joined {title}</div> : null;
}

const roleSentence = (role: "editor" | "viewer") => role === "editor"
  ? "you can change cards, Specs and Plans, and mark work complete"
  : "you can read the board, its Specs and Plans and its history";

/** From an invitation link to the board (approved mockup section 9). */
export function InvitePage({ onOpenBoard }: { onOpenBoard: (boardId: string) => void }) {
  const [token] = useState(pendingInvite);
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [outcome, setOutcome] = useState<{ kind: "member"; boardId: string; title: string } | { kind: "refused"; reason: string | undefined; sentTo?: string | undefined; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const account = rememberedAccount();

  /** Joins: only ever from the person's own tap on Join. */
  const join = useCallback(async () => {
    if (!token) return;
    setBusy(true);
    try {
      const joined = await call<{ boardId: string; title: string; alreadyMember: boolean }>("/api/online/invites/accept", { token });
      if (joined.alreadyMember) {
        setOutcome({ kind: "member", boardId: joined.boardId, title: joined.title });
        return;
      }
      clearInvite();
      announceJoined(joined.title);
      onOpenBoard(joined.boardId);
    } catch (error) {
      if (statusOf(error) === 401) return setSignedIn(false);
      setOutcome({ kind: "refused", reason: reasonOf(error), sentTo: (error as { body?: Json }).body?.sentTo as string | undefined, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }, [token, onOpenBoard]);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      const [shown, me] = await Promise.all([
        previewInvite(token).catch(() => ({ state: "unknown" as const })),
        call("/api/online/me").then(() => true, (error) => (statusOf(error) === 401 ? false : null)),
      ]);
      // Someone already on the board sees "You're already on this board", whatever state the invitation is in. Reads only.
      if (me) {
        const member = await call<{ member: boolean; boardId?: string; title?: string }>("/api/online/invites/membership", { token }).catch(() => null);
        if (member?.member && member.boardId) setOutcome({ kind: "member", boardId: member.boardId, title: member.title ?? "This board" });
      }
      setPreview(shown);
      setSignedIn(me);
    })();
  }, [token]);

  async function switchAccount() {
    try {
      await signOutWeb();
      window.location.assign(signInPath("/invite/pending"));
    } catch (failure) {
      window.alert(failure instanceof Error ? failure.message : String(failure));
    }
  }

  const card = (title: string, body: ReactNode, actions?: ReactNode) => (
    <main className="web-screen">
      <AppHeaderMaybe signedIn={signedIn === true} />
      <div className="web-wrap narrow">
        <section className="web-panel web-card" aria-labelledby="invite-title">
          <p className="web-eyebrow">Invitation</p>
          <h1 id="invite-title" className="web-h">{title}</h1>
          {body}
          {actions ? <div className="web-actions">{actions}</div> : null}
        </section>
      </div>
    </main>
  );

  if (!token) return card("This invitation link is incomplete", <p className="web-sub">Open the link from your email again, or ask the person who invited you for a new one.</p>);
  if (!preview || signedIn === null && preview.state === "valid") return card("Opening your invitation…", <p className="web-muted"><Loader2 size={14} className="spin" /> One moment.</p>);
  if (outcome?.kind === "member") {
    return card("You're already on this board", <p className="web-sub">{outcome.title} is in your boards.</p>,
      <button className="web-button dark" onClick={() => { clearInvite(); onOpenBoard(outcome.boardId); }}>Open {outcome.title}</button>);
  }
  const reason = outcome?.kind === "refused" ? outcome.reason : preview.state === "valid" ? undefined : preview.state;
  if (reason === "wrong_email") {
    return card("This invitation is for another email",
      <p className="web-sub">It was sent to {outcome?.kind === "refused" && outcome.sentTo ? outcome.sentTo : "a different address"}. Log in with that address, or ask for a new invitation.</p>,
      <button className="web-button" onClick={() => void switchAccount()}>Log in with another account</button>);
  }
  if (reason === "expired") return card("This invitation has expired", <p className="web-sub">Invitations last 7 days. Ask the person who invited you for a new one.</p>);
  if (reason === "cancelled" || reason === "used") return card("This invitation was cancelled", <p className="web-sub">Ask the person who invited you if you still need access.</p>);
  if (reason === "unavailable") return card("This board isn't online at the moment", <p className="web-sub">Ask the person who invited you.</p>);
  if (preview.state !== "valid") return card("This invitation link doesn't work", <p className="web-sub">Check you opened the whole link from your email, or ask for a new invitation.</p>);
  if (outcome?.kind === "refused") return card("Couldn't join", <p className="web-note" role="alert">{outcome.message}</p>);

  const body = <p className="web-sub">You'll join as {preview.role === "editor" ? "an Editor" : "a Viewer"}: {roleSentence(preview.role)}.</p>;
  if (!signedIn) {
    return card(`${preview.inviterName} invited you to ${preview.boardTitle}`, <>{body}<p className="web-muted">Log in or sign up to join. It's free.</p></>,
      <button className="web-button dark" onClick={() => window.location.assign(signInPath("/invite/pending"))}>Log in or sign up</button>);
  }
  return card(`${preview.inviterName} invited you to ${preview.boardTitle}`,
    <>{body}{account?.email ? <p className="web-muted">Signed in as {account.email}</p> : null}</>,
    <button className="web-button dark" disabled={busy} onClick={() => void join()}>{busy ? <Loader2 size={13} className="spin" /> : null}Join {preview.boardTitle}</button>);
}

function AppHeaderMaybe({ signedIn }: { signedIn: boolean }) {
  return signedIn ? <AppHeader /> : <header className="web-apphead"><a href="/" aria-label="Planban"><Wordmark /></a></header>;
}

/** One-tap approval of an agent's sign-in (Spec point 16): who is asking, the code to compare, Allow or Deny. */
export function ApprovePage() {
  // Read once: answering clears the stored request, and the page still shows the outcome.
  const [note] = useState(pendingApproval);
  const [state, setState] = useState<"loading" | "signed-out" | "waiting" | "ended" | "allowed" | "denied" | "error">("loading");
  const [request, setRequest] = useState<{ clientName: string; permission: string; userCode: string; expiresAt: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!note) return;
    void call<{ state: "waiting" | "ended"; clientName?: string; permission?: string; userCode?: string; expiresAt?: string }>("/api/online/device/preview", { request: note }).then((shown) => {
      if (shown.state !== "waiting") return setState("ended");
      setRequest({ clientName: shown.clientName!, permission: shown.permission!, userCode: shown.userCode!, expiresAt: shown.expiresAt! });
      setState("waiting");
    }, (error) => {
      if (statusOf(error) === 401) return setState("signed-out");
      setMessage(error instanceof Error ? error.message : String(error));
      setState("error");
    });
  }, [note]);

  async function decide(decision: "allow" | "deny") {
    setBusy(true);
    try {
      const result = await call<{ state: "allowed" | "denied" | "ended" }>("/api/online/device/decide", { request: note, decision });
      clearApproval();
      setState(result.state);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setState("error");
    } finally {
      setBusy(false);
    }
  }

  const frame = (title: string, body: ReactNode, actions?: ReactNode) => (
    <main className="web-screen">
      <AppHeaderMaybe signedIn={state !== "signed-out"} />
      <div className="web-wrap narrow">
        <section className="web-panel web-card" aria-labelledby="approve-title">
          <p className="web-eyebrow">Sign-in request</p>
          <h1 id="approve-title" className="web-h">{title}</h1>
          {body}
          {actions ? <div className="web-actions">{actions}</div> : null}
        </section>
      </div>
    </main>
  );

  if (!note) return frame("This approval link is incomplete", <p className="web-sub">Ask the agent to show its sign-in link again.</p>);
  if (state === "loading") return frame("Checking the request…", <p className="web-muted"><Loader2 size={14} className="spin" /> One moment.</p>);
  if (state === "signed-out") {
    return frame("Log in to answer this request", <p className="web-sub">An agent asked to use your Planban account. Log in on this device to see who is asking, then Allow or Deny.</p>,
      <button className="web-button dark" onClick={() => window.location.assign(signInPath("/approve"))}>Log in</button>);
  }
  if (state === "ended") return frame("This request has ended", <p className="web-sub">Requests last 10 minutes and can be answered once. Ask the agent to start again.</p>);
  if (state === "allowed") return frame("Allowed", <p className="web-sub">You can go back to {request?.clientName ?? "the agent"}. It signs in by itself in a moment.</p>);
  if (state === "denied") return frame("Denied", <p className="web-sub">{request?.clientName ?? "The agent"} can't use your account. Nothing else changed.</p>);
  if (state === "error" || !request) return frame("Couldn't answer this request", <p className="web-note" role="alert">{message}</p>);
  return frame(`Allow ${request.clientName}?`, (
    <>
      <p className="web-sub">{request.clientName} is asking to use your Planban account: {request.permission}</p>
      <div className="web-code-compare">
        <span>Check that the agent shows this code</span>
        <b>{request.userCode}</b>
      </div>
      <p className="web-muted">Only allow it if you started this. Your board permissions still apply, and you can cut it off any time from Connections.</p>
    </>
  ), (
    <>
      <button className="web-button" disabled={busy} onClick={() => void decide("deny")}>Deny</button>
      <button className="web-button dark" disabled={busy} onClick={() => void decide("allow")}>{busy ? <Loader2 size={13} className="spin" /> : null}Allow</button>
    </>
  ));
}

