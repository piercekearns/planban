import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  FilePenLine,
  Loader2,
  MessageSquareText,
  Minimize2,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import {
  closestCorners,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import "./styles.css";

const statuses = ["in-progress", "up-next", "pending", "complete", "archived"] as const;
type Status = (typeof statuses)[number];
type DocKind = "spec" | "plan";

interface RoadmapItem {
  id: string;
  title: string;
  status: Status;
  priority: number | null;
  summary: string | null;
  nextAction: string | null;
  tags: string[];
  icon: string | null;
  blockedBy: string | null;
  specDoc: string | null;
  planDoc: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  metadata?: Record<string, unknown>;
}

interface PlanbanState {
  cwd: string;
  manifest: { repoId: string };
  manifestPath: string;
  planningRoot: string;
  roadmapPath: string;
  roadmap: {
    revision: number;
    project: { id: string; title: string; status: string; description: string; tags: string[] };
    roadmapItems: RoadmapItem[];
  };
}

interface BoardRecord {
  repoId: string;
  title: string;
  cwd: string;
  planningRoot: string;
  roadmapPath: string;
  manifestPath: string;
  lastOpenedAt: string;
  updatedAt: string;
}

interface BoardsPayload {
  currentRepoId: string | null;
  boards: BoardRecord[];
}

interface DocPayload {
  cardId: string;
  kind: DocKind;
  path: string | null;
  exists: boolean;
  markdown: string;
  mtimeMs: number | null;
}

type HistoryActor = "user" | "agent" | "import" | "system";

interface HistoryEntry {
  version: number;
  roadmapRevision: number;
  createdAt: string;
  actor: HistoryActor;
  operation: string;
  summary: string;
  affectedCards: string[];
  affectedDocs: Array<{ cardId: string; kind: DocKind; path: string | null }>;
}

interface HistoryPayload {
  currentVersion: number;
  retention: {
    boardVersions: number;
    cardVersions: number;
    documentVersions: number;
    maxAgeDays: number;
  };
  entries: HistoryEntry[];
}

function boardPath(repoId: string, path: string) {
  return `/api/boards/${encodeURIComponent(repoId)}${path}`;
}

function repoIdFromPath() {
  const match = window.location.pathname.match(/^\/boards\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function isBoardDashboardPath() {
  return window.location.pathname === "/boards";
}

function replaceBoardPath(repoId: string | null) {
  const nextPath = repoId ? `/boards/${encodeURIComponent(repoId)}` : "/boards";
  if (window.location.pathname !== nextPath) window.history.replaceState(null, "", nextPath);
}

function pushBoardPath(repoId: string | null) {
  const nextPath = repoId ? `/boards/${encodeURIComponent(repoId)}` : "/boards";
  if (window.location.pathname !== nextPath) window.history.pushState(null, "", nextPath);
}

const labels: Record<Status, string> = {
  "in-progress": "In Progress",
  "up-next": "Up Next",
  pending: "Pending",
  complete: "Complete",
  archived: "Archived",
};

function joinLocalPath(root: string, relativePath: string | null) {
  if (!relativePath) return null;
  return `${root.replace(/\/+$/, "")}/${relativePath.replace(/^\/+/, "")}`;
}

function formatOptionalLine(label: string, value: string | number | null | undefined) {
  return `${label}: ${value === null || value === undefined || value === "" ? "(none)" : value}`;
}

function getCodexThreadMeta(item: RoadmapItem) {
  const value = item.metadata?.codexThread;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function getCodexThreadId(item: RoadmapItem) {
  const threadId = getCodexThreadMeta(item).threadId;
  return typeof threadId === "string" && threadId.trim() ? threadId.trim() : null;
}

function hasPendingCodexThread(item: RoadmapItem) {
  const meta = getCodexThreadMeta(item);
  return !getCodexThreadId(item) && meta.status === "pending" && typeof meta.launchToken === "string";
}

function createLaunchToken(item: RoadmapItem) {
  const random = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `planban:${item.id}:${random}`;
}

function buildCodexDraftPrompt(state: PlanbanState, item: RoadmapItem, launchToken: string) {
  const specPath = joinLocalPath(state.planningRoot, item.specDoc);
  const planPath = joinLocalPath(state.planningRoot, item.planDoc);
  const boardUrl = `${window.location.origin}/boards/${encodeURIComponent(state.manifest.repoId)}`;
  const demoSuccessMessage = typeof item.metadata?.demoSuccessMessage === "string"
    ? item.metadata.demoSuccessMessage
    : "New thread created successfully. Check the In Progress column in your Planban board.";

  if (item.metadata?.demoCodexPrompt === true) {
    return [
      "Hit enter to test out this prompt.",
      "",
      `I am testing the Planban roadmap item "${item.title}".`,
      "",
      formatOptionalLine("Repository", state.cwd),
      formatOptionalLine("Planban board", boardUrl),
      formatOptionalLine("Card id", item.id),
      formatOptionalLine("Status", labels[item.status]),
      formatOptionalLine("Spec doc", specPath),
      formatOptionalLine("Launch token", launchToken),
      "",
      "Use the Planban plugin or skill if it is available.",
      "Open the Planban board in the Codex in-app browser so the demo board is visible beside this thread.",
      "Move this roadmap item to In Progress.",
      "Update this roadmap item's summary to: New thread created successfully.",
      "Update this roadmap item's next action to: Check the In Progress column in your Planban Demo board.",
      "",
      demoSuccessMessage,
    ].join("\n");
  }

  return [
    `I am starting work on the Planban roadmap item "${item.title}".`,
    "",
    formatOptionalLine("Repository", state.cwd),
    formatOptionalLine("Planban board", boardUrl),
    formatOptionalLine("Card id", item.id),
    formatOptionalLine("Status", labels[item.status]),
    formatOptionalLine("Spec doc", specPath),
    formatOptionalLine("Plan doc", planPath),
    formatOptionalLine("Launch token", launchToken),
    "",
    "First, open the Planban board in the Codex in-app browser so the roadmap is visible beside this thread.",
    "Use the Planban plugin or skill if it is available.",
    "Read .planban/project.json, .planban/agent-context.md, and the linked docs before changing roadmap state.",
    "If you start implementation work on this item, move it to In Progress if it is not already there.",
    "When your implementation and verification are done, leave the item In Progress with a next action for user review/testing.",
    "Move the item to Complete only if I explicitly ask you to, manually confirm completion after testing/review, or clearly waive user-side verification.",
    "",
    "I want to:",
  ].join("\n");
}

async function openCodexDraftThread(state: PlanbanState, item: RoadmapItem) {
  const existingThreadId = getCodexThreadId(item);
  if (existingThreadId) {
    await api<{ opened: boolean }>("/api/open-codex-thread", {
      method: "POST",
      body: JSON.stringify({ url: `codex://threads/${existingThreadId}` }),
    });
    return null;
  }

  const launchToken = createLaunchToken(item);
  const url = new URL("codex://threads/new");
  url.searchParams.set("path", state.cwd);
  const prompt = buildCodexDraftPrompt(state, item, launchToken);
  url.searchParams.set("prompt", prompt);
  try {
    const result = await api<{ opened: boolean; state?: PlanbanState }>(boardPath(state.manifest.repoId, `/cards/${item.id}/codex-thread/draft`), {
      method: "POST",
      body: JSON.stringify({ url: url.toString(), launchToken }),
    });
    return result.state ?? null;
  } catch (error) {
    await navigator.clipboard?.writeText(prompt).catch(() => undefined);
    window.alert(
      error instanceof Error
        ? `Could not open Codex automatically. The draft prompt has been copied if clipboard access is available.\n\n${error.message}`
        : "Could not open Codex automatically. The draft prompt has been copied if clipboard access is available.",
    );
    return null;
  }
}

function buildFeedbackPrompt(state: PlanbanState, feedback: string) {
  const boardUrl = `${window.location.origin}/boards/${encodeURIComponent(state.manifest.repoId)}`;
  return [
    "Hit enter to provide feedback via your agent.",
    "",
    "Use the Planban plugin or skill if it is available.",
    "I want to give feedback on Planban. Please turn the feedback below into a concise GitHub issue for piercekearns/planban.",
    "",
    "Choose the right issue type: bug, feature request, or general product feedback.",
    "Ask me one clarifying question if needed.",
    "Before filing anything, show me the issue title and body and ask me to confirm.",
    "Do not include private repo paths, board contents, logs, screenshots, local URLs, or personal project details in the public issue unless I explicitly approve them.",
    "If GitHub access is available, use the repository's issue forms or gh issue create after I confirm. Otherwise, give me the finished issue draft and the GitHub issue chooser link.",
    "",
    "Local context for orientation only. Do not include this in the public issue unless I approve it:",
    formatOptionalLine("Board", state.roadmap.project.title),
    formatOptionalLine("Repo id", state.manifest.repoId),
    formatOptionalLine("Board URL", boardUrl),
    "",
    "Feedback:",
    feedback.trim(),
  ].join("\n");
}

async function openCodexFeedbackThread(state: PlanbanState, feedback: string) {
  const prompt = buildFeedbackPrompt(state, feedback);
  const url = new URL("codex://threads/new");
  url.searchParams.set("path", state.cwd);
  url.searchParams.set("prompt", prompt);

  try {
    await api<{ opened: boolean }>("/api/open-codex-thread", {
      method: "POST",
      body: JSON.stringify({ url: url.toString() }),
    });
    return { opened: true, copied: false };
  } catch (error) {
    await navigator.clipboard?.writeText(prompt).catch(() => undefined);
    window.alert(
      error instanceof Error
        ? `Could not open Codex automatically. The feedback prompt has been copied if clipboard access is available.\n\n${error.message}`
        : "Could not open Codex automatically. The feedback prompt has been copied if clipboard access is available.",
    );
    return { opened: false, copied: true };
  }
}

async function copyFeedbackPrompt(state: PlanbanState, feedback: string) {
  if (!navigator.clipboard) throw new Error("Clipboard access is unavailable");
  const prompt = buildFeedbackPrompt(state, feedback);
  await navigator.clipboard.writeText(prompt);
}

function versionLabel(version: number, currentVersion: number | null) {
  return `v${version}${version === currentVersion ? " (current)" : ""}`;
}

function docKindLabel(kind: DocKind) {
  return kind === "spec" ? "Spec" : "Plan";
}

const boardCollisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args);
  if (pointerCollisions.length > 0) return pointerCollisions;

  const rectCollisions = rectIntersection(args);
  if (rectCollisions.length > 0) return rectCollisions;

  return closestCorners(args);
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const headers = {
    "Content-Type": "application/json",
    ...(init?.headers ?? {}),
  } as Record<string, string>;
  if (method !== "GET" && method !== "HEAD" && !headers["Idempotency-Key"]) {
    headers["Idempotency-Key"] = `web:${Date.now()}:${crypto.randomUUID()}`;
  }
  const response = await fetch(path, {
    ...init,
    headers,
  });
  const text = await response.text();
  let payload: { error?: string } | T | null = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text) as { error?: string } | T;
    } catch {
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      throw new Error(`Expected JSON response from ${path}`);
    }
  }
  if (!response.ok) {
    const errorMessage =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Request failed: ${response.status}`;
    const error = new Error(errorMessage);
    Object.assign(error, { status: response.status });
    throw error;
  }
  if (payload === null) throw new Error(`Empty response from ${path}`);
  return payload as T;
}

function groupItems(items: RoadmapItem[]) {
  const grouped: Record<Status, RoadmapItem[]> = {
    "in-progress": [],
    "up-next": [],
    pending: [],
    complete: [],
    archived: [],
  };
  for (const item of items) grouped[item.status].push(item);
  for (const status of statuses) {
    grouped[status].sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));
  }
  return grouped;
}

function stripFrontmatter(markdown: string) {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function formatHistoryTime(input: string) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return input;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

type TooltipPlacement = "top" | "bottom";

interface TooltipPosition {
  anchorLeft: number;
  anchorTop: number;
  anchorBottom: number;
  placement: TooltipPlacement;
}

function FloatingTooltip({ label, position }: { label: string; position: TooltipPosition }) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState({ left: position.anchorLeft, top: position.anchorTop });

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    if (!tooltip) return;

    const rect = tooltip.getBoundingClientRect();
    const viewportPadding = 8;
    const left = Math.min(
      Math.max(position.anchorLeft - rect.width / 2, viewportPadding),
      window.innerWidth - rect.width - viewportPadding,
    );
    let top =
      position.placement === "top"
        ? position.anchorTop - rect.height - viewportPadding
        : position.anchorBottom + viewportPadding;

    if (top < viewportPadding) top = position.anchorBottom + viewportPadding;
    if (top + rect.height > window.innerHeight - viewportPadding) {
      top = Math.max(viewportPadding, position.anchorTop - rect.height - viewportPadding);
    }

    setStyle({ left, top });
  }, [position]);

  return (
    <div ref={tooltipRef} className="floating-tooltip" role="tooltip" style={style}>
      {label}
    </div>
  );
}

function TooltipButton({
  label,
  className = "",
  tooltipPlacement = "top",
  children,
  onBlur,
  onFocus,
  onPointerEnter,
  onPointerLeave,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tooltipPlacement?: TooltipPlacement }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);
  const [tooltip, setTooltip] = useState<TooltipPosition | null>(null);

  function clearTimer() {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  function showTooltip() {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      anchorLeft: rect.left + rect.width / 2,
      anchorTop: rect.top,
      anchorBottom: rect.bottom,
      placement: tooltipPlacement,
    });
  }

  function scheduleTooltip() {
    clearTimer();
    timerRef.current = window.setTimeout(showTooltip, 450);
  }

  function hideTooltip() {
    clearTimer();
    setTooltip(null);
  }

  useEffect(() => clearTimer, []);

  return (
    <>
      <button
        {...props}
        ref={buttonRef}
        aria-label={label}
        className={`tooltip-trigger ${className}`}
        onBlur={(event) => {
          onBlur?.(event);
          hideTooltip();
        }}
        onFocus={(event) => {
          onFocus?.(event);
          scheduleTooltip();
        }}
        onPointerEnter={(event) => {
          onPointerEnter?.(event);
          scheduleTooltip();
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          hideTooltip();
        }}
      >
        {children}
      </button>
      {tooltip ? createPortal(<FloatingTooltip label={label} position={tooltip} />, document.body) : null}
    </>
  );
}

function CardContent({ item }: { item: RoadmapItem }) {
  const description = item.nextAction || item.summary || "";

  return (
    <>
      <div className="card-title-row">
        <p className="card-title">
          {item.icon ? <span className="card-title-icon">{item.icon}</span> : null}
          {item.title}
        </p>
        {item.priority ? <span className="priority">P{item.priority}</span> : null}
      </div>
      {description ? <p className="card-copy">{description}</p> : null}
    </>
  );
}

function SortableCard({
  item,
  onSelect,
  onStartCodex,
  onMove,
  onDelete,
  readOnly = false,
}: {
  item: RoadmapItem;
  onSelect: (id: string) => void;
  onStartCodex: (item: RoadmapItem) => void;
  onMove: (id: string, status: Status) => void;
  onDelete: (id: string) => void;
  readOnly?: boolean;
}) {
  const hasDescription = Boolean(item.nextAction || item.summary);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: readOnly,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };
  const codexThreadId = getCodexThreadId(item);
  const codexPending = hasPendingCodexThread(item);
  const codexLabel = codexThreadId
    ? "Open Codex thread"
    : codexPending
      ? "Codex draft opened"
      : "Start in Codex";

  return (
    <article
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      tabIndex={0}
      onClick={() => onSelect(item.id)}
      className={`card ${hasDescription ? "" : "compact"} ${readOnly ? "read-only" : ""} ${isDragging ? "is-dragging" : ""}`}
    >
      <CardContent item={item} />
      {!readOnly ? (
        <div className="card-actions" onPointerDown={(event) => event.stopPropagation()}>
          <div className="card-action-group">
            <TooltipButton
              label={codexLabel}
              className={`${codexThreadId ? "codex-linked" : ""} ${codexPending ? "codex-pending" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                onStartCodex(item);
              }}
            >
              {codexPending ? <Loader2 size={14} /> : <SquarePen size={14} />}
            </TooltipButton>
          </div>
          <div className="card-action-group">
            {item.status !== "complete" && item.status !== "archived" ? (
              <TooltipButton
                label="Mark complete"
                onClick={(event) => {
                  event.stopPropagation();
                  onMove(item.id, "complete");
                }}
              >
                <CheckCircle2 size={14} />
              </TooltipButton>
            ) : null}
            {item.status !== "archived" ? (
              <TooltipButton
                label="Archive"
                onClick={(event) => {
                  event.stopPropagation();
                  onMove(item.id, "archived");
                }}
              >
                <Archive size={14} />
              </TooltipButton>
            ) : (
              <TooltipButton
                label="Restore"
                onClick={(event) => {
                  event.stopPropagation();
                  onMove(item.id, "pending");
                }}
              >
                <RotateCcw size={14} />
              </TooltipButton>
            )}
            {item.status === "archived" ? (
              <TooltipButton
                label="Delete permanently"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete(item.id);
                }}
              >
                <Trash2 size={14} />
              </TooltipButton>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function Column({
  status,
  items,
  collapsed,
  cardsHidden,
  highlighted,
  onToggleCollapsed,
  onToggleCards,
  onSelect,
  onStartCodex,
  onMove,
  onDelete,
  readOnly = false,
}: {
  status: Status;
  items: RoadmapItem[];
  collapsed: boolean;
  cardsHidden: boolean;
  highlighted: boolean;
  onToggleCollapsed: () => void;
  onToggleCards: () => void;
  onSelect: (id: string) => void;
  onStartCodex: (item: RoadmapItem) => void;
  onMove: (id: string, status: Status) => void;
  onDelete: (id: string) => void;
  readOnly?: boolean;
}) {
  const { setNodeRef } = useDroppable({ id: status });

  if (collapsed) {
    return (
      <section ref={setNodeRef} className="column collapsed">
        <button onClick={onToggleCollapsed} className="icon-button">
          <Minimize2 size={14} />
        </button>
        <div className="vertical-label">
          <span>{labels[status]}</span>
          <b>{items.length}</b>
        </div>
      </section>
    );
  }

  return (
    <section ref={setNodeRef} className={`column ${highlighted ? "highlighted" : ""}`}>
      <header className="column-header">
        <button onClick={onToggleCards} className="icon-button">
          {cardsHidden ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <h2>{labels[status]}</h2>
        <span className="count">{items.length}</span>
        <button onClick={onToggleCollapsed} className="icon-button right">
          <Minimize2 size={14} />
        </button>
      </header>
      <div className={`column-drop-zone ${highlighted && !readOnly ? "highlighted" : ""}`}>
        {!cardsHidden ? (
          <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
            <div className="card-stack">
              {items.map((item) => (
                <SortableCard
                  key={item.id}
                  item={item}
                  onSelect={onSelect}
                  onStartCodex={onStartCodex}
                  onMove={onMove}
                  onDelete={onDelete}
                  readOnly={readOnly}
                />
              ))}
              {items.length === 0 ? <div className="empty-drop">Drop here</div> : null}
            </div>
          </SortableContext>
        ) : (
          <div className="empty-drop">{items.length} cards hidden</div>
        )}
      </div>
    </section>
  );
}

function BoardPicker({
  boards,
  currentRepoId,
  onSelectBoard,
}: {
  boards: BoardRecord[];
  currentRepoId: string;
  onSelectBoard: (repoId: string) => void;
}) {
  const orderedBoards = useMemo(
    () => boards.slice().sort((a, b) => a.title.localeCompare(b.title) || a.cwd.localeCompare(b.cwd)),
    [boards],
  );
  const [open, setOpen] = useState(false);
  const [visibleBoards, setVisibleBoards] = useState(orderedBoards);
  const containerRef = useRef<HTMLDivElement>(null);
  const currentBoard = boards.find((board) => board.repoId === currentRepoId);
  const canSwitch = orderedBoards.length > 1;
  const pickerBoards = open ? visibleBoards : orderedBoards;

  useEffect(() => {
    if (!open) setVisibleBoards(orderedBoards);
  }, [open, orderedBoards]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div ref={containerRef} className="board-picker">
      <button
        className={`board-picker-trigger ${canSwitch ? "" : "single-board"}`}
        aria-haspopup={canSwitch ? "listbox" : undefined}
        aria-expanded={canSwitch ? open : undefined}
        onClick={() => {
          if (!canSwitch) return;
          setOpen((value) => {
            const nextOpen = !value;
            if (nextOpen) setVisibleBoards(orderedBoards);
            return nextOpen;
          });
        }}
      >
        <span>{currentBoard?.title ?? currentRepoId}</span>
        {canSwitch ? <ChevronDown size={16} /> : null}
      </button>
      {open ? (
        <div className="board-picker-popover" role="listbox" aria-label="Switch Planban board">
          {pickerBoards.map((board) => (
            <button
              key={board.repoId}
              className={board.repoId === currentRepoId ? "active" : ""}
              role="option"
              aria-selected={board.repoId === currentRepoId}
              onClick={() => {
                setOpen(false);
                onSelectBoard(board.repoId);
              }}
            >
              <span>
                <b>{board.title}</b>
                <small>{board.cwd}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function HistoryPicker({
  history,
  previewVersion,
  onSelectVersion,
  onReturnToCurrent,
}: {
  history: HistoryPayload | null;
  previewVersion: number | null;
  onSelectVersion: (version: number) => void;
  onReturnToCurrent: () => void;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const currentVersion = history?.currentVersion ?? 1;

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div ref={containerRef} className="history-picker">
      <button
        className={`history-trigger ${previewVersion ? "previewing" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>v{previewVersion ?? currentVersion}</span>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="history-popover" role="listbox" aria-label="Board version history">
          {previewVersion ? (
            <button
              role="option"
              aria-selected={false}
              onClick={() => {
                setOpen(false);
                onReturnToCurrent();
              }}
            >
              <span>
                <b>Close preview</b>
                <small>{versionLabel(currentVersion, currentVersion)}</small>
              </span>
            </button>
          ) : null}
          {(history?.entries ?? []).map((entry) => {
            const isCurrent = entry.version === currentVersion;
            const isPreview = entry.version === previewVersion;
            return (
              <button
                key={entry.version}
                className={isPreview ? "active" : ""}
                role="option"
                aria-selected={isPreview}
                onClick={() => {
                  setOpen(false);
                  if (isCurrent) onReturnToCurrent();
                  else onSelectVersion(entry.version);
                }}
              >
                <span>
                  <b>
                    {versionLabel(entry.version, currentVersion)}
                  </b>
                  <small>
                    {formatHistoryTime(entry.createdAt)} · {entry.actor} · {entry.summary}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function FeedbackModal({
  state,
  onClose,
}: {
  state: PlanbanState;
  onClose: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<"open" | "copy" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const canSubmit = feedback.trim().length > 0 && busy === null;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function openInCodex() {
    if (!canSubmit) return;
    setBusy("open");
    setStatus(null);
    try {
      const result = await openCodexFeedbackThread(state, feedback);
      setStatus(result.opened ? "Opened a Codex draft thread. Hit enter there to continue." : "Copied the feedback prompt.");
      if (result.opened) onClose();
    } finally {
      setBusy(null);
    }
  }

  async function copyPrompt() {
    if (!canSubmit) return;
    setBusy("copy");
    setStatus(null);
    try {
      await copyFeedbackPrompt(state, feedback);
      setStatus("Copied. Paste it into Codex to provide feedback through your agent.");
    } catch {
      setStatus("Clipboard access was blocked. Try opening a Codex draft instead.");
    } finally {
      setBusy(null);
    }
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="feedback-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="feedback-modal-header">
          <div>
            <p className="eyebrow">Planban feedback</p>
            <h2 id="feedback-title">Tell us what happened</h2>
          </div>
          <TooltipButton label="Close feedback" className="toolbar-icon-button" onClick={onClose}>
            <X size={14} />
          </TooltipButton>
        </header>
        <textarea
          autoFocus
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          placeholder="Describe the bug, request, rough edge, or reaction. Your agent will turn this into the right feedback format."
        />
        <p className="feedback-privacy">
          Planban will hand this to your agent as a draft. Nothing is posted publicly until you confirm it.
        </p>
        {status ? <p className="feedback-status">{status}</p> : null}
        <footer className="feedback-actions">
          <button onClick={copyPrompt} disabled={!canSubmit}>
            {busy === "copy" ? <Loader2 size={14} className="spin" /> : <Copy size={14} />}
            Copy prompt
          </button>
          <button className="primary" onClick={openInCodex} disabled={!canSubmit}>
            {busy === "open" ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            Open in Codex
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function isCardDetailsHistory(entry: HistoryEntry, cardId: string) {
  return (
    entry.affectedCards.includes(cardId) &&
    !entry.operation.startsWith("doc.") &&
    entry.operation !== "history.restore.doc"
  );
}

function isDocHistory(entry: HistoryEntry, cardId: string, kind: DocKind) {
  return entry.affectedDocs.some((doc) => doc.cardId === cardId && doc.kind === kind);
}

function VersionChangeMenu({
  label,
  entries,
  currentVersion,
  previewVersion,
  onSelectVersion,
  onReturnToCurrent,
}: {
  label: string;
  entries: HistoryEntry[];
  currentVersion: number | null;
  previewVersion: number | null;
  onSelectVersion: ((version: number) => void) | undefined;
  onReturnToCurrent: (() => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  if (entries.length === 0) return null;
  const viewedBoardVersion = previewVersion ?? currentVersion;
  const activeEntry = entries.find((entry) => viewedBoardVersion !== null && entry.version <= viewedBoardVersion) ?? entries[0]!;
  const activeVersion = activeEntry.version;

  return (
    <div ref={containerRef} className="version-change-menu">
      <button
        className={`version-change-trigger ${previewVersion ? "previewing" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{label}</span>
        <b>Viewing {versionLabel(activeVersion, currentVersion)}</b>
        <ChevronDown size={14} />
      </button>
      {open ? (
        <div className="version-change-popover" role="listbox" aria-label={`${label} changed versions`}>
          {entries.map((entry) => {
            const isCurrent = entry.version === currentVersion;
            const isActive = entry.version === activeVersion;
            return (
              <button
                key={entry.version}
                className={isActive ? "active" : ""}
                role="option"
                aria-selected={isActive}
                disabled={isCurrent && !previewVersion && isActive}
                onClick={() => {
                  setOpen(false);
                  if (isCurrent) onReturnToCurrent?.();
                  else onSelectVersion?.(entry.version);
                }}
              >
                <span>
                  <b>{versionLabel(entry.version, currentVersion)}</b>
                  <small>{formatHistoryTime(entry.createdAt)} · {entry.summary}</small>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function DetailView({
  state,
  item,
  boardId,
  onBack,
  onStateRefresh,
  history,
  previewVersion = null,
  previewEntry = null,
  onSelectVersion,
  onReturnToCurrent,
  onRestoreCard,
  onRestoreDoc,
}: {
  state: PlanbanState;
  item: RoadmapItem;
  boardId: string;
  onBack: () => void;
  onStateRefresh: () => void;
  history?: HistoryPayload | null;
  previewVersion?: number | null;
  previewEntry?: HistoryEntry | null;
  onSelectVersion?: (version: number) => void;
  onReturnToCurrent?: () => void;
  onRestoreCard?: (cardId: string) => void;
  onRestoreDoc?: (cardId: string, kind: DocKind) => void;
}) {
  const availableDocKinds = useMemo<DocKind[]>(
    () => ["spec", ...(item.planDoc ? (["plan"] as const) : [])],
    [item.planDoc],
  );
  const [activeTab, setActiveTab] = useState<DocKind>("spec");
  const [docsByKind, setDocsByKind] = useState<Partial<Record<DocKind, DocPayload>>>({});
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const doc = docsByKind[activeTab] ?? null;
  const isPreviewing = previewVersion !== null;
  const currentVersion = history?.currentVersion ?? null;
  const cardHistoryEntries = useMemo(
    () => (history?.entries ?? []).filter((entry) => isCardDetailsHistory(entry, item.id)),
    [history, item.id],
  );
  const activeDocHistoryEntries = useMemo(
    () => (history?.entries ?? []).filter((entry) => isDocHistory(entry, item.id, activeTab)),
    [activeTab, history, item.id],
  );
  const canRestoreActiveDoc = isPreviewing && activeDocHistoryEntries.some((entry) => entry.version === previewVersion);

  useEffect(() => {
    if (!availableDocKinds.includes(activeTab)) setActiveTab("spec");
  }, [activeTab, availableDocKinds]);

  useEffect(() => {
    setDocsByKind({});
    setDraft("");
    setEditing(false);
    setActiveTab("spec");
  }, [boardId, item.id, previewVersion]);

  const loadDoc = useCallback(
    async (kind: DocKind) => {
      const payload = await api<DocPayload>(
        previewVersion
          ? boardPath(boardId, `/history/${previewVersion}/cards/${item.id}/docs/${kind}`)
          : boardPath(boardId, `/cards/${item.id}/docs/${kind}`),
      );
      setDocsByKind((current) => ({ ...current, [kind]: payload }));
      return payload;
    },
    [boardId, item.id, previewVersion],
  );

  useEffect(() => {
    let cancelled = false;
    for (const kind of availableDocKinds) {
      void loadDoc(kind).then((payload) => {
        if (cancelled) return;
        setDocsByKind((current) => ({ ...current, [kind]: payload }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [availableDocKinds, loadDoc]);

  useEffect(() => {
    setEditing(false);
    setDraft(doc?.markdown ?? "");
  }, [activeTab, doc]);

  async function saveDoc() {
    setBusy(true);
    try {
      const payload = await api<DocPayload>(boardPath(boardId, `/cards/${item.id}/docs/${activeTab}`), {
        method: "PUT",
        body: JSON.stringify({ markdown: draft, expectedMtimeMs: doc?.mtimeMs ?? null }),
      });
      setDocsByKind((current) => ({ ...current, [activeTab]: payload }));
      setDraft(payload.markdown);
      setEditing(false);
      onStateRefresh();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Document save failed");
      const payload = await loadDoc(activeTab);
      setDraft(payload.markdown);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="detail">
      <header className="detail-header">
        <button onClick={onBack} className="back-button">
          <ArrowLeft size={16} />
        </button>
        <div>
          <p className="eyebrow">{isPreviewing ? `Historical roadmap item · v${previewVersion}` : "Roadmap item"}</p>
          <h1>{item.title}</h1>
          {previewEntry ? (
            <p className="detail-history-note">
              {formatHistoryTime(previewEntry.createdAt)} · {previewEntry.summary}
            </p>
          ) : null}
        </div>
        {isPreviewing ? (
          <div className="detail-history-actions">
            <button onClick={onReturnToCurrent}>Close preview</button>
            <button className="primary" onClick={() => onRestoreCard?.(item.id)}>
              Restore card details
            </button>
          </div>
        ) : null}
      </header>

      <section className="overview-panel">
        <div className="meta-grid">
          <div>
            <span>Status</span>
            <b>{labels[item.status]}</b>
          </div>
          <div>
            <span>Priority</span>
            <b>{item.priority ? `P${item.priority}` : "None"}</b>
          </div>
          <div>
            <span>Planning root</span>
            <b className="path-text">{state.planningRoot}</b>
          </div>
          <div className="meta-version-cell">
            <VersionChangeMenu
              label="Card details"
              entries={cardHistoryEntries}
              currentVersion={currentVersion}
              previewVersion={previewVersion}
              onSelectVersion={onSelectVersion}
              onReturnToCurrent={onReturnToCurrent}
            />
          </div>
        </div>
        {item.nextAction ? (
          <div className="next-action">
            <span>Next action</span>
            <p>{item.nextAction}</p>
          </div>
        ) : null}
      </section>

      <section className="doc-shell">
        <div className="doc-tabs">
          <button className={activeTab === "spec" ? "active" : ""} onClick={() => setActiveTab("spec")}>
            Spec
          </button>
          {item.planDoc ? (
            <button className={activeTab === "plan" ? "active" : ""} onClick={() => setActiveTab("plan")}>
              Plan
            </button>
          ) : null}
          {!isPreviewing ? (
            <TooltipButton
              label={editing ? "Preview document" : "Edit document"}
              className="edit-doc"
              onClick={() => setEditing((value) => !value)}
            >
              <FilePenLine size={14} />
            </TooltipButton>
          ) : null}
        </div>

        {doc ? (
          editing ? (
            <div className="editor-pane">
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
              <div className="editor-actions">
                <button onClick={() => setDraft(doc.markdown)}>Reset</button>
                <button className="primary" onClick={saveDoc} disabled={busy}>
                  {busy ? <Loader2 size={14} className="spin" /> : <Pencil size={14} />}
                  Save {activeTab}
                </button>
              </div>
            </div>
          ) : doc.exists ? (
            <article className="markdown-body">
              <div className="doc-version-row">
                <VersionChangeMenu
                  label={`${docKindLabel(activeTab)} document`}
                  entries={activeDocHistoryEntries}
                  currentVersion={currentVersion}
                  previewVersion={previewVersion}
                  onSelectVersion={onSelectVersion}
                  onReturnToCurrent={onReturnToCurrent}
                />
                {canRestoreActiveDoc ? (
                  <button className="primary" onClick={() => onRestoreDoc?.(item.id, activeTab)}>
                    Restore {docKindLabel(activeTab).toLowerCase()} to latest
                  </button>
                ) : null}
              </div>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(doc.markdown)}</ReactMarkdown>
            </article>
          ) : isPreviewing ? (
            <div className="missing-doc">
              <div className="doc-version-row">
                <VersionChangeMenu
                  label={`${docKindLabel(activeTab)} document`}
                  entries={activeDocHistoryEntries}
                  currentVersion={currentVersion}
                  previewVersion={previewVersion}
                  onSelectVersion={onSelectVersion}
                  onReturnToCurrent={onReturnToCurrent}
                />
              </div>
              <p>No {activeTab} document snapshot exists for this card in v{previewVersion}.</p>
            </div>
          ) : (
            <div className="missing-doc">
              <p>No {activeTab} document exists for this card yet.</p>
              <button onClick={() => setEditing(true)}>Create {activeTab}</button>
            </div>
          )
        ) : (
          <div className="loading">Loading document...</div>
        )}
      </section>
    </main>
  );
}

function BoardView({
  state,
  boards,
  onStateChange,
  onSelectBoard,
}: {
  state: PlanbanState;
  boards: BoardRecord[];
  onStateChange: (next: PlanbanState) => void;
  onSelectBoard: (repoId: string | null) => void;
}) {
  const [items, setItems] = useState<RoadmapItem[]>(state.roadmap.roadmapItems);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [hiddenCards, setHiddenCards] = useState<Record<string, boolean>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeSize, setActiveSize] = useState<{ width: number; height: number } | null>(null);
  const [dragOver, setDragOver] = useState<Status | null>(null);
  const [history, setHistory] = useState<HistoryPayload | null>(null);
  const [preview, setPreview] = useState<{ version: number; entry: HistoryEntry | null; state: PlanbanState } | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const boardId = state.manifest.repoId;
  const displayState = preview?.state ?? state;
  const previewVersion = preview?.version ?? null;
  const isPreviewing = preview !== null;

  useEffect(() => {
    setItems(displayState.roadmap.roadmapItems);
    setSelectedId((current) => {
      if (!current) return null;
      return displayState.roadmap.roadmapItems.some((item) => item.id === current) ? current : null;
    });
  }, [displayState.manifest.repoId, displayState.roadmap.roadmapItems]);

  const loadHistory = useCallback(async () => {
    const payload = await api<HistoryPayload>(boardPath(boardId, "/history"));
    setHistory(payload);
    return payload;
  }, [boardId]);

  useEffect(() => {
    setPreview(null);
    void loadHistory().catch(() => setHistory(null));
  }, [boardId, loadHistory]);

  const selectedItem = selectedId ? items.find((item) => item.id === selectedId) : null;
  const activeItem = activeId ? items.find((item) => item.id === activeId) : null;
  const grouped = useMemo(() => groupItems(items), [items]);
  const hasArchivedCards = grouped.archived.length > 0;
  const visibleStatuses = showArchived && hasArchivedCards ? statuses : statuses.filter((status) => status !== "archived");

  useEffect(() => {
    if (!hasArchivedCards) setShowArchived(false);
  }, [hasArchivedCards]);

  async function refreshState() {
    const next = await api<PlanbanState>(boardPath(boardId, "/state"));
    onStateChange(next);
    await loadHistory().catch(() => undefined);
  }

  useEffect(() => {
    if (isPreviewing) return undefined;
    const pendingItems = state.roadmap.roadmapItems.filter(hasPendingCodexThread);
    if (pendingItems.length === 0) return undefined;
    let cancelled = false;

    async function syncPendingCodexThreads() {
      for (const item of pendingItems) {
        try {
          const result = await api<{ linked: boolean; state?: PlanbanState }>(
            boardPath(boardId, `/cards/${item.id}/codex-thread/sync`),
            { method: "POST", body: "{}" },
          );
          if (!cancelled && result.linked && result.state) {
            onStateChange(result.state);
            await loadHistory().catch(() => undefined);
            return;
          }
        } catch {
          // Keep the board usable if Codex session discovery is temporarily unavailable.
        }
      }
    }

    void syncPendingCodexThreads();
    const interval = window.setInterval(() => void syncPendingCodexThreads(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [boardId, isPreviewing, loadHistory, onStateChange, state.roadmap.revision, state.roadmap.roadmapItems]);

  async function previewHistoryVersion(version: number) {
    if (history && version === history.currentVersion) {
      setPreview(null);
      return;
    }
    const next = await api<PlanbanState>(boardPath(boardId, `/history/${version}`));
    const entry = history?.entries.find((candidate) => candidate.version === version) ?? null;
    setPreview({ version, entry, state: next });
  }

  function returnToCurrent() {
    setPreview(null);
  }

  async function restoreBoardFromPreview() {
    if (!preview) return;
    const confirmed = window.confirm(`Restore the board state from v${preview.version} to the latest version?`);
    if (!confirmed) return;
    const next = await api<PlanbanState>(boardPath(boardId, `/history/${preview.version}/restore-board`), {
      method: "POST",
      body: JSON.stringify({ actor: "user" }),
    });
    setPreview(null);
    onStateChange(next);
    await loadHistory().catch(() => undefined);
  }

  async function restoreCardFromPreview(cardId: string) {
    if (!preview) return;
    const item = preview.state.roadmap.roadmapItems.find((entry) => entry.id === cardId);
    const confirmed = window.confirm(`Restore "${item?.title ?? cardId}" card details from v${preview.version} to the latest version?`);
    if (!confirmed) return;
    const next = await api<PlanbanState>(boardPath(boardId, `/history/${preview.version}/cards/${cardId}/restore`), {
      method: "POST",
      body: JSON.stringify({ actor: "user" }),
    });
    setPreview(null);
    onStateChange(next);
    await loadHistory().catch(() => undefined);
  }

  async function restoreDocFromPreview(cardId: string, kind: DocKind) {
    if (!preview) return;
    const confirmed = window.confirm(`Restore this ${kind} document from v${preview.version} to the latest version?`);
    if (!confirmed) return;
    await api<DocPayload>(boardPath(boardId, `/history/${preview.version}/cards/${cardId}/docs/${kind}/restore`), {
      method: "POST",
      body: JSON.stringify({ actor: "user" }),
    });
    setPreview(null);
    await refreshState();
  }

  async function moveItem(id: string, status: Status) {
    if (isPreviewing) return;
    try {
      const next = await api<PlanbanState>(boardPath(boardId, `/cards/${id}/move`), {
        method: "POST",
        body: JSON.stringify({ status, baseRevision: state.roadmap.revision }),
      });
      onStateChange(next);
      await loadHistory().catch(() => undefined);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Card move failed");
      await refreshState();
    }
  }

  async function deleteItem(id: string) {
    if (isPreviewing) return;
    const item = items.find((entry) => entry.id === id);
    if (!item) return;
    const confirmed = window.confirm(
      `Delete "${item.title}" permanently from this Planban board? This also removes its local Planban docs.`,
    );
    if (!confirmed) return;

    try {
      const next = await api<PlanbanState>(boardPath(boardId, `/cards/${id}`), {
        method: "DELETE",
        body: JSON.stringify({ baseRevision: state.roadmap.revision }),
      });
      onStateChange(next);
      await loadHistory().catch(() => undefined);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Card delete failed");
      await refreshState();
    }
  }

  async function startCodexThread(item: RoadmapItem) {
    const nextState = await openCodexDraftThread(state, item);
    if (nextState) onStateChange(nextState);
  }

  function findStatus(id: string): Status | null {
    if (statuses.includes(id as Status)) return id as Status;
    return items.find((item) => item.id === id)?.status ?? null;
  }

  function onDragStart(event: DragStartEvent) {
    if (isPreviewing) return;
    setActiveId(String(event.active.id));
    const rect = event.active.rect.current.initial;
    setActiveSize(rect ? { width: rect.width, height: rect.height } : null);
  }

  function onDragOver(event: DragOverEvent) {
    if (isPreviewing) return;
    const draggingId = String(event.active.id);
    if (!event.over) return;
    const target = findStatus(String(event.over.id));
    setDragOver(target);
    if (!target) return;
    setItems((previous) => {
      const active = previous.find((item) => item.id === draggingId);
      if (!active || active.status === target) return previous;
      return previous.map((item) => (item.id === draggingId ? { ...item, status: target } : item));
    });
  }

  async function onDragEnd(event: DragEndEvent) {
    if (isPreviewing) return;
    const id = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    setActiveId(null);
    setActiveSize(null);
    setDragOver(null);
    if (!overId) {
      setItems(state.roadmap.roadmapItems);
      return;
    }

    const active = items.find((item) => item.id === id);
    const targetStatus = findStatus(overId);
    if (!active || !targetStatus) return;

    let nextItems = items;
    const overItem = items.find((item) => item.id === overId);
    if (overItem && overItem.status === active.status) {
      const columnItems = grouped[active.status];
      const from = columnItems.findIndex((item) => item.id === id);
      const to = columnItems.findIndex((item) => item.id === overId);
      const movedColumn = arrayMove(columnItems, from, to);
      nextItems = statuses.flatMap((status) => (status === active.status ? movedColumn : grouped[status]));
    } else {
      const remaining = items.filter((item) => item.id !== id);
      const moved = { ...active, status: targetStatus };
      const insertAt = overItem
        ? remaining.findIndex((item) => item.id === overItem.id)
        : remaining.map((item) => item.status).lastIndexOf(targetStatus) + 1;
      const safeInsertAt = insertAt >= 0 ? insertAt : remaining.length;
      nextItems = [...remaining.slice(0, safeInsertAt), moved, ...remaining.slice(safeInsertAt)];
    }

    setItems(nextItems);

    try {
      const reordered = await api<PlanbanState>(boardPath(boardId, "/cards/reorder"), {
        method: "POST",
        body: JSON.stringify({
          baseRevision: state.roadmap.revision,
          items: nextItems.map((item) => ({ id: item.id, status: item.status })),
        }),
      });
      onStateChange(reordered);
      await loadHistory().catch(() => undefined);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Card reorder failed");
      await refreshState();
    }
  }

  if (selectedItem) {
    return (
      <DetailView
        state={displayState}
        item={selectedItem}
        boardId={boardId}
        onBack={() => setSelectedId(null)}
        onStateRefresh={refreshState}
        history={history}
        previewVersion={previewVersion}
        previewEntry={preview?.entry ?? null}
        onSelectVersion={previewHistoryVersion}
        onReturnToCurrent={returnToCurrent}
        onRestoreCard={restoreCardFromPreview}
        onRestoreDoc={restoreDocFromPreview}
      />
    );
  }

  return (
    <main className="board-screen">
      <header className="app-header">
        <div className="board-title-group">
          <div className="board-breadcrumb">
            <button onClick={() => onSelectBoard(null)}>Planban</button>
            <span>/</span>
            <span>{state.roadmap.project.title}</span>
          </div>
          <BoardPicker boards={boards} currentRepoId={boardId} onSelectBoard={onSelectBoard} />
        </div>
        <div className="header-actions">
          <HistoryPicker
            history={history}
            previewVersion={previewVersion}
            onSelectVersion={previewHistoryVersion}
            onReturnToCurrent={returnToCurrent}
          />
          <TooltipButton label="Provide feedback" className="toolbar-icon-button tooltip-below" onClick={() => setFeedbackOpen(true)}>
            <MessageSquareText size={14} />
          </TooltipButton>
          <TooltipButton label="Refresh board from disk" className="toolbar-icon-button tooltip-below" onClick={refreshState}>
            <RefreshCw size={14} />
          </TooltipButton>
          {hasArchivedCards ? (
            <TooltipButton
              label={showArchived ? "Hide archived cards" : "Show archived cards"}
              className={`archive-toggle ${showArchived ? "active" : ""}`}
              aria-pressed={showArchived}
              onClick={() => setShowArchived((value) => !value)}
            >
              <span>Archive</span>
              <span className="archive-switch" aria-hidden="true">
                <span className="archive-switch-knob" />
              </span>
            </TooltipButton>
          ) : null}
        </div>
      </header>

      {feedbackOpen ? <FeedbackModal state={state} onClose={() => setFeedbackOpen(false)} /> : null}

      {preview ? (
        <section className="history-preview-banner">
          <div>
            <b>Viewing v{preview.version}</b>
            <span>
              {preview.entry ? `${formatHistoryTime(preview.entry.createdAt)} · ${preview.entry.summary}` : "Historical board snapshot"}
            </span>
          </div>
          <button onClick={returnToCurrent}>Close preview</button>
          <button className="primary" onClick={restoreBoardFromPreview}>
            Restore board state
          </button>
        </section>
      ) : null}

      <DndContext
        sensors={sensors}
        collisionDetection={boardCollisionDetection}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        <div className="board-grid" style={{ gridTemplateColumns: visibleStatuses.map((status) => (collapsed[status] ? "72px" : "minmax(280px, 1fr)")).join(" ") }}>
          {visibleStatuses.map((status) => (
            <Column
              key={status}
              status={status}
              items={grouped[status]}
              collapsed={collapsed[status] === true}
              cardsHidden={hiddenCards[status] === true}
              highlighted={dragOver === status}
              onToggleCollapsed={() => setCollapsed((value) => ({ ...value, [status]: !value[status] }))}
              onToggleCards={() => setHiddenCards((value) => ({ ...value, [status]: !value[status] }))}
              onSelect={setSelectedId}
              onStartCodex={startCodexThread}
              onMove={moveItem}
              onDelete={deleteItem}
              readOnly={isPreviewing}
            />
          ))}
        </div>
        <DragOverlay>
          {activeId ? (
            <article className={`card drag-card ${activeItem?.nextAction || activeItem?.summary ? "" : "compact"}`} style={activeSize ?? undefined}>
              {activeItem ? <CardContent item={activeItem} /> : null}
            </article>
          ) : null}
        </DragOverlay>
      </DndContext>
    </main>
  );
}

function BoardDashboard({ boards, onSelectBoard }: { boards: BoardRecord[]; onSelectBoard: (repoId: string) => void }) {
  return (
    <main className="board-dashboard">
      <header className="app-header">
        <div>
          <p className="eyebrow">Planban</p>
          <h1>Boards</h1>
        </div>
      </header>
      <section className="board-list">
        {boards.length > 0 ? (
          boards.map((board) => (
            <button key={board.repoId} className="board-list-item" onClick={() => onSelectBoard(board.repoId)}>
              <span>
                <b>{board.title}</b>
                <small>{board.cwd}</small>
              </span>
              <small>{board.repoId}</small>
            </button>
          ))
        ) : (
          <div className="empty-boards">
            <h2>No Planban boards registered yet</h2>
            <p>Open Planban from a project or initialize a repo to add it to this device.</p>
          </div>
        )}
      </section>
    </main>
  );
}

function Onboarding({ onReady }: { onReady: (state: PlanbanState) => void }) {
  const [busy, setBusy] = useState(false);
  async function enable() {
    setBusy(true);
    try {
      onReady(await api<PlanbanState>("/api/init", { method: "POST", body: "{}" }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="onboarding">
      <div className="onboarding-copy">
        <p className="eyebrow">Project planning protocol</p>
        <h1>Enable Planban for this repo</h1>
        <p>
          Planban will create repo-local discovery files and a device-local board so Codex and you
          can work from the same roadmap.
        </p>
        <button className="primary large" onClick={enable} disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : null}
          Enable Planban
        </button>
      </div>
      <div className="ghost-board">
        {statuses.filter((status) => status !== "archived").map((status) => (
          <section key={status}>
            <b>{labels[status]}</b>
            <span />
            <span />
          </section>
        ))}
      </div>
    </main>
  );
}

function App() {
  const [state, setState] = useState<PlanbanState | null>(null);
  const [boards, setBoards] = useState<BoardRecord[]>([]);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(() => repoIdFromPath());
  const [initialized, setInitialized] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appLoadRequestRef = useRef(0);
  const boardLoadRequestRef = useRef(0);
  const selectedRepoIdRef = useRef<string | null>(selectedRepoId);

  useEffect(() => {
    selectedRepoIdRef.current = selectedRepoId;
  }, [selectedRepoId]);

  const selectBoard = useCallback((repoId: string | null) => {
    appLoadRequestRef.current += 1;
    boardLoadRequestRef.current += 1;
    pushBoardPath(repoId);
    setSelectedRepoId(repoId);
    setState(null);
  }, []);

  const loadSelectedBoard = useCallback(async (repoId: string) => {
    const requestId = ++boardLoadRequestRef.current;
    const nextState = await api<PlanbanState>(boardPath(repoId, "/state"));
    if (requestId !== boardLoadRequestRef.current) return null;
    const routeRepoId = repoIdFromPath();
    if (routeRepoId !== repoId && selectedRepoIdRef.current !== repoId) return null;
    setState(nextState);
    return nextState;
  }, []);

  const load = useCallback(async () => {
    const requestId = ++appLoadRequestRef.current;
    try {
      const [status, boardsPayload] = await Promise.all([
        api<{ initialized: boolean; currentRepoId: string | null }>("/api/status"),
        api<BoardsPayload>("/api/boards"),
      ]);
      if (requestId !== appLoadRequestRef.current) return;
      setInitialized(status.initialized);
      setBoards(boardsPayload.boards);
      const routeRepoId = repoIdFromPath();
      const nextRepoId = isBoardDashboardPath()
        ? null
        : routeRepoId ?? selectedRepoIdRef.current ?? status.currentRepoId ?? null;
      if (nextRepoId) {
        replaceBoardPath(nextRepoId);
        setSelectedRepoId(nextRepoId);
        await loadSelectedBoard(nextRepoId);
      } else {
        setSelectedRepoId(null);
        setState(null);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load");
    }
  }, [loadSelectedBoard]);

  useEffect(() => {
    void load();
    const events = new EventSource("/api/events");
    events.addEventListener("state", () => void load());
    return () => events.close();
  }, [load]);

  useEffect(() => {
    const onPopState = () => {
      const next = repoIdFromPath();
      setSelectedRepoId(next);
      setState(null);
      if (next) void loadSelectedBoard(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadSelectedBoard]);

  useEffect(() => {
    if (!selectedRepoId) return;
    void loadSelectedBoard(selectedRepoId);
  }, [loadSelectedBoard, selectedRepoId]);

  if (error) return <main className="error-screen">{error}</main>;
  if (!selectedRepoId && boards.length > 0) return <BoardDashboard boards={boards} onSelectBoard={selectBoard} />;
  if (initialized === false && boards.length === 0) {
    return (
      <Onboarding
        onReady={(next) => {
          setState(next);
          setBoards([
            {
              repoId: next.manifest.repoId,
              title: next.roadmap.project.title,
              cwd: next.cwd,
              planningRoot: next.planningRoot,
              roadmapPath: next.roadmapPath,
              manifestPath: next.manifestPath,
              lastOpenedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ]);
          setSelectedRepoId(next.manifest.repoId);
          replaceBoardPath(next.manifest.repoId);
        }}
      />
    );
  }
  if (!selectedRepoId && boards.length === 0) return <BoardDashboard boards={boards} onSelectBoard={selectBoard} />;
  if (!state) return <main className="loading-screen">Loading Planban...</main>;
  return <BoardView state={state} boards={boards} onStateChange={setState} onSelectBoard={selectBoard} />;
}

createRoot(document.getElementById("root")!).render(<App />);
