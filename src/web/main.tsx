import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleArrowUp,
  Copy,
  ExternalLink,
  FilePenLine,
  HelpCircle,
  Loader2,
  MessageSquareText,
  Minimize2,
  Pencil,
  Play,
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
  kind?: "project" | "demo";
  archivedAt?: string | null;
  lastOpenedAt: string;
  updatedAt: string;
}

interface BoardsPayload {
  currentRepoId: string | null;
  boards: BoardRecord[];
}

interface VersionInfo {
  version: string;
  pluginVersion: string;
  mcpVersion: string;
  storageSchemaVersion: number;
  sourceUrl: string;
}

interface UpdateManifest {
  schemaVersion?: 1;
  version: string;
  pluginVersion: string;
  mcpVersion: string;
  storageSchemaVersion: number;
  minimumStorageSchemaVersion: number;
  publishedAt: string;
  sourceUrl: string;
  releaseNotesUrl: string;
  summary: string;
  updatePrompt: string;
  postUpdateRoute?: "tutorial" | "board" | "board-with-changelog";
  tutorialVersion?: number;
  showTutorialWhenUpdatingFromBefore?: string;
  changelogTitle?: string;
  changelogSummary?: string;
}

interface UpdateStatusPayload {
  checkedAt: string;
  metadataUrl: string;
  current: VersionInfo;
  latest: UpdateManifest | null;
  updateAvailable: boolean;
  compatible: boolean;
  checkError: string | null;
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

function isTutorialPath() {
  return window.location.pathname === "/tutorial";
}

function tutorialPath(mode = "first-run") {
  return `/tutorial?mode=${encodeURIComponent(mode)}`;
}

function replaceBoardPath(repoId: string | null) {
  const nextPath = repoId ? `/boards/${encodeURIComponent(repoId)}` : "/boards";
  if (window.location.pathname !== nextPath) window.history.replaceState(null, "", nextPath);
}

function pushBoardPath(repoId: string | null) {
  const nextPath = repoId ? `/boards/${encodeURIComponent(repoId)}` : "/boards";
  if (window.location.pathname !== nextPath) window.history.pushState(null, "", nextPath);
}

function openTutorial(mode = "first-run") {
  window.location.assign(tutorialPath(mode));
}

const tutorialStorageKey = "planban:tutorial:v1";

type TutorialProgress = "completed" | "skipped" | null;

function readTutorialProgress(): TutorialProgress {
  try {
    const raw = window.localStorage.getItem(tutorialStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { status?: unknown };
    return parsed.status === "completed" || parsed.status === "skipped" ? parsed.status : null;
  } catch {
    return null;
  }
}

function writeTutorialProgress(status: Exclude<TutorialProgress, null>) {
  window.localStorage.setItem(
    tutorialStorageKey,
    JSON.stringify({
      status,
      updatedAt: new Date().toISOString(),
    }),
  );
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

async function writeClipboardText(text: string) {
  try {
    await navigator.clipboard?.writeText(text);
    return true;
  } catch {
    // Keep going to the textarea fallback below.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    return copied;
  } catch {
    return false;
  }
}

async function copyFeedbackPrompt(state: PlanbanState, feedback: string) {
  return await writeClipboardText(buildFeedbackPrompt(state, feedback));
}

function buildTutorialCreatePrompt(state: PlanbanState, planningContext: string) {
  const boardUrl = `${window.location.origin}/boards/${encodeURIComponent(state.manifest.repoId)}`;
  return [
    "Hit enter to create Planban roadmap items with your agent.",
    "",
    "Use the Planban plugin or skill if it is available.",
    "I want to turn rough project context into Planban roadmap items.",
    "",
    "Use this demo board as orientation only:",
    formatOptionalLine("Demo board", boardUrl),
    "",
    "Ask me what project or repo I want to plan, then inspect the context I provide from repo docs, GitHub Issues, Notion, Linear, Jira, plain notes, or a short spoken/written project update.",
    "If there is no Planban board for that project yet, ask before initializing one. Then create a small set of reviewable Planban roadmap items with clear titles, summaries, statuses, next actions, and specs.",
    "Do not invent private project facts. Ask one concise clarifying question if the input is too thin.",
    "",
    "User-provided planning context:",
    planningContext.trim() || "(The user has not added context yet. Ask one short question to get started.)",
  ].join("\n");
}

async function openCodexPromptForState(state: PlanbanState, prompt: string) {
  const url = new URL("codex://threads/new");
  url.searchParams.set("path", state.cwd);
  url.searchParams.set("prompt", prompt);
  await api<{ opened: boolean }>("/api/open-codex-thread", {
    method: "POST",
    body: JSON.stringify({ url: url.toString() }),
  });
}

function buildUpdatePrompt(state: PlanbanState, status: UpdateStatusPayload) {
  const boardUrl = `${window.location.origin}/boards/${encodeURIComponent(state.manifest.repoId)}`;
  const tutorialUrl = `${window.location.origin}/tutorial?mode=first-run`;
  const latest = status.latest;
  const postUpdateInstruction = updatePostInstallInstruction(status, boardUrl, tutorialUrl);
  return [
    "Hit enter to update Planban with your agent.",
    "",
    "Use the Planban plugin or skill if it is available.",
    "I want to update my local Planban install safely.",
    "",
    formatOptionalLine("Current Planban version", status.current.version),
    formatOptionalLine("Current plugin version", status.current.pluginVersion),
    formatOptionalLine("Current MCP version", status.current.mcpVersion),
    formatOptionalLine("Latest Planban version", latest?.version ?? "(unknown)"),
    formatOptionalLine("Latest plugin version", latest?.pluginVersion ?? "(unknown)"),
    formatOptionalLine("Latest MCP version", latest?.mcpVersion ?? "(unknown)"),
    formatOptionalLine("Release notes", latest?.releaseNotesUrl ?? "(none)"),
    formatOptionalLine("Release-specific update instructions", latest?.updatePrompt ?? "(none)"),
    formatOptionalLine("Post-update route", postUpdateInstruction),
    formatOptionalLine("Source", latest?.sourceUrl ?? status.current.sourceUrl),
    formatOptionalLine("Current board", boardUrl),
    "",
    "Before changing anything, inspect how Planban is installed on this machine.",
    "The public README install flow normally creates a local clone marketplace. If that is the install shape, update the clone first, then reinstall the plugin from that local marketplace.",
    "Only use codex plugin marketplace upgrade planban when the marketplace is actually a Git-backed marketplace snapshot.",
    "Before any storage migration, create a timestamped backup of the affected ~/.planban state and explain how to restore it.",
    "Do not upload or expose private board contents, repo paths, logs, or local project details.",
    "",
    "Primary local clone commands, to verify before running:",
    "git pull",
    "npm install",
    "node scripts/configure-local-plugin.mjs",
    "codex plugin add planban@planban",
    "",
    "Git-backed marketplace fallback, only if inspection confirms that install shape:",
    "codex plugin marketplace upgrade planban",
    "codex plugin add planban@planban",
    "",
    "After updating, verify the running Planban version, the installed plugin version, MCP tools, and board load.",
    postUpdateInstruction,
  ].join("\n");
}

function versionParts(version: string) {
  const core = version.trim().replace(/^v/u, "").split(/[+-]/u)[0] ?? "0";
  return core.split(".").map((part) => {
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
}

function compareVersionStrings(left: string, right: string) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

function shouldRouteToTutorial(status: UpdateStatusPayload) {
  const latest = status.latest;
  if (!latest) return false;
  if (latest.postUpdateRoute === "tutorial") return true;
  if (!latest.showTutorialWhenUpdatingFromBefore) return false;
  return compareVersionStrings(status.current.version, latest.showTutorialWhenUpdatingFromBefore) < 0;
}

function updatePostInstallInstruction(status: UpdateStatusPayload, boardUrl: string, tutorialUrl: string) {
  const latest = status.latest;
  if (shouldRouteToTutorial(status)) {
    return `After updating, open ${tutorialUrl} in the Codex in-app browser so the user can see the Planban tutorial. If the board opens instead, make sure the Planban tour banner is visible when the tutorial has not been completed or skipped locally.`;
  }
  if (latest?.postUpdateRoute === "board-with-changelog") {
    const title = latest.changelogTitle ? ` titled "${latest.changelogTitle}"` : "";
    const summary = latest.changelogSummary ? ` Summary: ${latest.changelogSummary}` : "";
    return `After updating, reopen ${boardUrl} in the Codex in-app browser and show the what's-new modal${title}.${summary}`;
  }
  return `After updating, reopen ${boardUrl} in the Codex in-app browser and confirm the running version.`;
}

async function openCodexUpdateThread(state: PlanbanState, status: UpdateStatusPayload) {
  const prompt = buildUpdatePrompt(state, status);
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
        ? `Could not open Codex automatically. The update prompt has been copied if clipboard access is available.\n\n${error.message}`
        : "Could not open Codex automatically. The update prompt has been copied if clipboard access is available.",
    );
    return { opened: false, copied: true };
  }
}

async function copyUpdatePrompt(state: PlanbanState, status: UpdateStatusPayload) {
  const prompt = buildUpdatePrompt(state, status);
  return { copied: await writeClipboardText(prompt), prompt };
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

function groupItemsInCurrentOrder(items: RoadmapItem[]) {
  const grouped: Record<Status, RoadmapItem[]> = {
    "in-progress": [],
    "up-next": [],
    pending: [],
    complete: [],
    archived: [],
  };
  for (const item of items) grouped[item.status].push(item);
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
      {...(readOnly ? {} : attributes)}
      {...(readOnly ? {} : listeners)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(item.id);
        }
      }}
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
      const copied = await copyFeedbackPrompt(state, feedback);
      setStatus(copied
        ? "Copied. Paste it into Codex to provide feedback through your agent."
        : "Clipboard access was blocked. Use Open in Codex instead.");
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

function UpdateModal({
  state,
  status,
  onClose,
}: {
  state: PlanbanState;
  status: UpdateStatusPayload | null;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<"open" | "copy" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  const latest = status?.latest ?? null;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function openInCodex() {
    if (!status) return;
    setBusy("open");
    setMessage(null);
    setManualPrompt(null);
    try {
      const result = await openCodexUpdateThread(state, status);
      setMessage(result.opened ? "Opened a Codex draft thread. Hit enter there to continue." : "Copied the update prompt.");
      if (result.opened) onClose();
    } finally {
      setBusy(null);
    }
  }

  async function copyPrompt() {
    if (!status) return;
    setBusy("copy");
    setMessage(null);
    setManualPrompt(null);
    try {
      const result = await copyUpdatePrompt(state, status);
      if (result.copied) {
        setMessage("Copied. Paste it into Codex to update Planban through your agent.");
      } else {
        setManualPrompt(result.prompt);
        setMessage("Clipboard access was blocked. Select the prompt below, or open a Codex draft instead.");
      }
    } catch {
      const prompt = buildUpdatePrompt(state, status);
      setManualPrompt(prompt);
      setMessage("Clipboard access was blocked. Select the prompt below, or open a Codex draft instead.");
    } finally {
      setBusy(null);
    }
  }

  return createPortal(
    <div className="modal-backdrop update-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="update-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="feedback-modal-header">
          <div>
            <p className="eyebrow">Planban updates</p>
            <h2 id="update-title">{status?.updateAvailable ? "Update available" : "Planban updates"}</h2>
            {status ? (
              <p className="update-version-line">
                {status.current.version}
                {latest?.version ? ` -> ${latest.version}` : ""}
              </p>
            ) : null}
          </div>
          <TooltipButton label="Close updates" className="toolbar-icon-button" onClick={onClose}>
            <X size={14} />
          </TooltipButton>
        </header>
        <div className="update-modal-body">
          {status ? (
            <>
              {status.checkError ? (
                <p className="update-note">Could not check for updates: {status.checkError}</p>
              ) : status.updateAvailable ? (
                <section className="update-summary">
                  <p className="eyebrow">What's changed</p>
                  {latest?.changelogTitle ? <h3>{latest.changelogTitle}</h3> : null}
                  <p>{latest?.changelogSummary ?? latest?.summary}</p>
                </section>
              ) : (
                <p className="update-note">You are on the latest known Planban version.</p>
              )}
              {!status.compatible ? (
                <p className="update-warning">This update may require a storage migration. Ask Codex to back up your Planban data before updating.</p>
              ) : null}
              <div className="update-links">
                {latest?.releaseNotesUrl ? (
                  <a href={latest.releaseNotesUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={13} />
                    View release notes
                  </a>
                ) : null}
              </div>
            </>
          ) : (
            <p className="update-note">Checking for updates...</p>
          )}
          {message ? <p className="feedback-status">{message}</p> : null}
          {manualPrompt ? (
            <textarea
              className="manual-prompt-fallback"
              readOnly
              value={manualPrompt}
              aria-label="Update prompt"
              onFocus={(event) => event.currentTarget.select()}
            />
          ) : null}
        </div>
        <footer className="feedback-actions">
          <button onClick={copyPrompt} disabled={!status || busy !== null}>
            {busy === "copy" ? <Loader2 size={14} className="spin" /> : <Copy size={14} />}
            Copy prompt
          </button>
          <button className="primary" onClick={openInCodex} disabled={!status || busy !== null}>
            {busy === "open" ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
            Update with Codex
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function FirstRunPrompt({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section className="first-run-prompt" aria-label="Planban tutorial">
      <div>
        <p className="eyebrow">Planban tour</p>
        <h2>Take the two-minute tour</h2>
        <p>
          Learn how the board, cards, specs, and Codex prompts stay in sync.
        </p>
      </div>
      <div className="first-run-prompt-actions">
        <button
          onClick={() => {
            writeTutorialProgress("skipped");
            onDismiss();
          }}
        >
          Skip
        </button>
        <button className="primary" onClick={() => openTutorial("first-run")}>
          <Play size={14} />
          Start tutorial
        </button>
      </div>
    </section>
  );
}

const fallbackTutorialItems: RoadmapItem[] = [
  {
    id: "drag-this-card-to-in-progress",
    title: "Drag this card to In Progress",
    status: "up-next",
    priority: 1,
    summary: "Try the board by moving this card into In Progress.",
    nextAction: "Move this card, then ask Codex to summarize the board.",
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: null,
    planDoc: null,
    completedAt: null,
    updatedAt: null,
  },
  {
    id: "open-this-roadmap-item-in-codex",
    title: "Open this roadmap item in Codex",
    status: "up-next",
    priority: 2,
    summary: "Use a card to start an agent thread with the right context.",
    nextAction: "Start from a card when you want Codex to pick up the full planning context.",
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: null,
    planDoc: null,
    completedAt: null,
    updatedAt: null,
  },
  {
    id: "send-feedback-from-the-toolbar",
    title: "Send feedback from the toolbar",
    status: "pending",
    priority: 3,
    summary: "Feedback is handed to your agent before anything is filed publicly.",
    nextAction: "Use the feedback icon or Planban Feedback when something is rough.",
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: null,
    planDoc: null,
    completedAt: null,
    updatedAt: null,
  },
  {
    id: "mark-a-card-complete-when-you-are-done",
    title: "Mark a card Complete when you are done",
    status: "in-progress",
    priority: 1,
    summary: "Completion should be intentional, especially when an agent is doing the work.",
    nextAction: "Drag this In Progress card to Complete once you are happy with the work.",
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: null,
    planDoc: null,
    completedAt: null,
    updatedAt: null,
  },
  {
    id: "ask-codex-to-create-roadmap-items-from-your-plans",
    title: "Ask Codex to create roadmap items from your plans",
    status: "pending",
    priority: 4,
    summary: "Bring existing project context from docs, issues, Notion, Jira, Linear, or plain notes.",
    nextAction: "Give Codex your current planning context and ask it to draft Planban roadmap items for review.",
    tags: [],
    icon: null,
    blockedBy: null,
    specDoc: null,
    planDoc: null,
    completedAt: null,
    updatedAt: null,
  },
];

function tutorialItemsFromState(state: PlanbanState | null) {
  const source = state?.roadmap.roadmapItems.length ? state.roadmap.roadmapItems : fallbackTutorialItems;
  return source.slice(0, 5).map((item) => ({ ...item }));
}

function TutorialBackground({ items }: { items: RoadmapItem[] }) {
  return (
    <div className="tutorial-background-board">
      <header>
        <div>
          <p className="eyebrow">Planban</p>
          <h2>Planban Demo</h2>
        </div>
        <div className="tutorial-background-actions">
          <span>v1</span>
          <span />
          <span />
        </div>
      </header>
      <TutorialMiniBoard items={items} selectedId={null} onSelect={() => undefined} />
    </div>
  );
}

function TutorialMiniBoard({
  items,
  selectedId,
  onSelect,
  onItemsChange,
  draggable = false,
}: {
  items: RoadmapItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onItemsChange?: (items: RoadmapItem[], selectedId?: string) => void;
  draggable?: boolean;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeSize, setActiveSize] = useState<{ width: number; height: number } | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<Status | null>(null);
  const [draftItems, setDraftItems] = useState<RoadmapItem[] | null>(null);
  const draftItemsRef = useRef<RoadmapItem[] | null>(null);
  const displayItems = draftItems ?? items;
  const grouped = groupItemsInCurrentOrder(displayItems);
  const visible = statuses.filter((status) => status !== "archived");

  function updateDraftItems(nextItems: RoadmapItem[] | null) {
    draftItemsRef.current = nextItems;
    setDraftItems(nextItems);
  }

  function findStatus(id: string, currentItems = displayItems): Status | null {
    if (statuses.includes(id as Status)) return id as Status;
    return currentItems.find((item) => item.id === id)?.status ?? null;
  }

  function moveIntoStatus(currentItems: RoadmapItem[], id: string, status: Status, beforeId: string | null) {
    const active = currentItems.find((item) => item.id === id);
    if (!active) return currentItems;
    const remaining = currentItems.filter((item) => item.id !== id);
    const moved = { ...active, status };
    const insertAt = beforeId
      ? remaining.findIndex((item) => item.id === beforeId)
      : remaining.map((item) => item.status).lastIndexOf(status) + 1;
    const safeInsertAt = insertAt >= 0 ? insertAt : remaining.length;
    return [...remaining.slice(0, safeInsertAt), moved, ...remaining.slice(safeInsertAt)];
  }

  function moveWithinStatus(currentItems: RoadmapItem[], id: string, overId: string, status: Status) {
    const statusItems = groupItemsInCurrentOrder(currentItems)[status];
    const from = statusItems.findIndex((item) => item.id === id);
    const to = statusItems.findIndex((item) => item.id === overId);
    if (from < 0 || to < 0 || from === to) return currentItems;
    const movedStatusItems = arrayMove(statusItems, from, to);
    return statuses.flatMap((entryStatus) => (entryStatus === status ? movedStatusItems : groupItemsInCurrentOrder(currentItems)[entryStatus]));
  }

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    setActiveId(id);
    updateDraftItems(items);
    onSelect(id);
    const rect = event.active.rect.current.initial;
    setActiveSize(rect ? { width: rect.width, height: rect.height } : null);
  }

  function handleDragOver(event: DragOverEvent) {
    const draggingId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    if (!overId) return;
    const currentItems = draftItemsRef.current ?? items;
    const target = findStatus(overId, currentItems);
    setDragOverStatus(target);
    if (!target) return;
    const active = currentItems.find((item) => item.id === draggingId);
    if (!active) return;
    const overItem = currentItems.find((item) => item.id === overId);
    const nextItems = overItem && overItem.id !== draggingId && overItem.status === active.status
      ? moveWithinStatus(currentItems, draggingId, overId, active.status)
      : active.status === target
        ? currentItems
        : moveIntoStatus(currentItems, draggingId, target, overItem?.id ?? null);
    if (nextItems !== currentItems) updateDraftItems(nextItems);
  }

  function handleDragEnd(event: DragEndEvent) {
    const id = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    const currentItems = draftItemsRef.current ?? items;
    setActiveId(null);
    setActiveSize(null);
    setDragOverStatus(null);
    updateDraftItems(null);
    if (!overId) return;

    const active = currentItems.find((item) => item.id === id);
    const target = findStatus(overId, currentItems);
    if (!active || !target) return;
    const overItem = currentItems.find((item) => item.id === overId);
    const nextItems = overItem && overItem.status === active.status
      ? moveWithinStatus(currentItems, id, overId, active.status)
      : moveIntoStatus(currentItems, id, target, overItem?.id ?? null);
    onItemsChange?.(nextItems, id);
  }

  function handleDragCancel() {
    setActiveId(null);
    setActiveSize(null);
    setDragOverStatus(null);
    updateDraftItems(null);
  }

  const board = (
    <div className="tutorial-mini-board" aria-label="Planban tutorial board preview">
      {visible.map((status) => (
        <TutorialMiniColumn
          key={status}
          status={status}
          items={grouped[status]}
          highlighted={dragOverStatus === status}
          draggable={draggable}
          onSelect={onSelect}
          selectedId={selectedId}
        />
      ))}
    </div>
  );

  if (!draggable) return board;

  const activeItem = activeId ? displayItems.find((item) => item.id === activeId) ?? items.find((item) => item.id === activeId) : null;
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollisionDetection}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {board}
      <DragOverlay>
        {activeItem ? (
          <button className="tutorial-mini-card drag-card" style={activeSize ?? undefined}>
            <b>{activeItem.title}</b>
            {activeItem.nextAction || activeItem.summary ? <span>{activeItem.nextAction || activeItem.summary}</span> : null}
          </button>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function TutorialMiniColumn({
  status,
  items,
  highlighted,
  draggable,
  selectedId,
  onSelect,
}: {
  status: Status;
  items: RoadmapItem[];
  highlighted: boolean;
  draggable: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { setNodeRef } = useDroppable({ id: status, disabled: !draggable });
  return (
    <section ref={setNodeRef} className={`tutorial-mini-column ${draggable ? "drag-enabled" : ""} ${highlighted ? "highlighted" : ""}`}>
      <header>
        <span>{labels[status]}</span>
        <b>{items.length}</b>
      </header>
      <SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}>
        <div className="tutorial-mini-stack">
          {items.map((item) => (
            draggable ? (
              <TutorialMiniSortableCard
                key={item.id}
                item={item}
                selected={selectedId === item.id}
                onSelect={onSelect}
              />
            ) : (
              <button
                key={item.id}
                className={`tutorial-mini-card ${selectedId === item.id ? "active" : ""}`}
                onClick={() => onSelect(item.id)}
              >
                <b>{item.title}</b>
                {item.nextAction || item.summary ? <span>{item.nextAction || item.summary}</span> : null}
              </button>
            )
          ))}
        </div>
      </SortableContext>
    </section>
  );
}

function TutorialMiniSortableCard({
  item,
  selected,
  onSelect,
}: {
  item: RoadmapItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
  };
  return (
    <button
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`tutorial-mini-card ${selected ? "active" : ""} ${isDragging ? "is-dragging" : ""}`}
      onClick={() => onSelect(item.id)}
    >
      <b>{item.title}</b>
      {item.nextAction || item.summary ? <span>{item.nextAction || item.summary}</span> : null}
    </button>
  );
}

function TutorialLiveBoard({
  items: sourceItems,
  onSelect,
  onItemsChange,
  draggable = true,
}: {
  items: RoadmapItem[];
  onSelect: (id: string) => void;
  onItemsChange?: (items: RoadmapItem[], selectedId?: string) => void;
  draggable?: boolean;
}) {
  const [items, setItems] = useState<RoadmapItem[]>(sourceItems);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeSize, setActiveSize] = useState<{ width: number; height: number } | null>(null);
  const [dragOver, setDragOver] = useState<Status | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const grouped = useMemo(() => groupItemsInCurrentOrder(items), [items]);
  const activeItem = activeId ? items.find((item) => item.id === activeId) : null;
  const visibleStatuses = statuses.filter((status) => status !== "archived");

  useEffect(() => {
    setItems(sourceItems);
  }, [sourceItems]);

  function moveItem(id: string, status: Status) {
    if (!draggable) return;
    setItems((previous) => {
      const nextItems = previous.map((item) => (item.id === id ? { ...item, status } : item));
      onItemsChange?.(nextItems, id);
      return nextItems;
    });
    onSelect(id);
  }

  function findStatus(id: string): Status | null {
    if (statuses.includes(id as Status)) return id as Status;
    return items.find((item) => item.id === id)?.status ?? null;
  }

  function onDragStart(event: DragStartEvent) {
    if (!draggable) return;
    const id = String(event.active.id);
    setActiveId(id);
    onSelect(id);
    const rect = event.active.rect.current.initial;
    setActiveSize(rect ? { width: rect.width, height: rect.height } : null);
  }

  function onDragOver(event: DragOverEvent) {
    if (!draggable) return;
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

  function onDragEnd(event: DragEndEvent) {
    if (!draggable) return;
    const id = String(event.active.id);
    const overId = event.over ? String(event.over.id) : null;
    setActiveId(null);
    setActiveSize(null);
    setDragOver(null);
    if (!overId) {
      setItems(sourceItems);
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
    onItemsChange?.(nextItems, id);
    onSelect(id);
  }

  function onDragCancel() {
    setActiveId(null);
    setActiveSize(null);
    setDragOver(null);
    setItems(sourceItems);
  }

  return (
    <section className="tutorial-live-board" aria-label="Interactive Planban board tutorial">
      <DndContext
        sensors={sensors}
        collisionDetection={boardCollisionDetection}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        <div className="board-grid" style={{ gridTemplateColumns: visibleStatuses.map(() => "minmax(230px, 1fr)").join(" ") }}>
          {visibleStatuses.map((status) => (
            <Column
              key={status}
              status={status}
              items={grouped[status]}
              collapsed={false}
              cardsHidden={false}
              highlighted={dragOver === status}
              onToggleCollapsed={() => undefined}
              onToggleCards={() => undefined}
              onSelect={onSelect}
              onStartCodex={() => undefined}
              onMove={moveItem}
              onDelete={() => undefined}
              readOnly={!draggable}
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
    </section>
  );
}

function TutorialIntroPreview() {
  return (
    <section className="tutorial-intro-preview">
      <div>
        <p className="eyebrow">Project memory</p>
        <h3>Use boards as a second brain</h3>
        <p>Store plans, ideas, rough notes, future features, priorities, and what to work on next.</p>
      </div>
      <ArrowRight size={18} />
      <div>
        <p className="eyebrow">Codex works</p>
        <h3>Start from the same state</h3>
        <p>Your agent can read and update the board, then keep the card status and docs in sync.</p>
      </div>
    </section>
  );
}

function TutorialDetailPreview({ item, onBack }: { item: RoadmapItem | null; onBack?: () => void }) {
  return (
    <aside className="tutorial-detail-preview revealed">
      <header>
        <div>
          <p className="eyebrow">Roadmap item</p>
          <h3>{item?.title ?? "Selected card"}</h3>
        </div>
        {onBack ? <button onClick={onBack}>Back to board</button> : null}
      </header>
      <dl>
        <div>
          <dt>Status</dt>
          <dd>{item ? labels[item.status] : "None"}</dd>
        </div>
        <div>
          <dt>Next action</dt>
          <dd>{item?.nextAction ?? "Each card can carry the next useful thing for you or Codex to do."}</dd>
        </div>
        <div>
          <dt>Spec</dt>
          <dd>Specs and plans sit with the card so a new agent thread can start with context.</dd>
        </div>
      </dl>
    </aside>
  );
}

function TutorialPlanningComposer({
  state,
  planningContext,
  onPlanningContextChange,
}: {
  state: PlanbanState | null;
  planningContext: string;
  onPlanningContextChange: (value: string) => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const prompt = state ? buildTutorialCreatePrompt(state, planningContext) : "";
  const hasPlanningContext = planningContext.trim().length > 0;
  const promptDisabledReason = !state
    ? "The demo board is still loading."
    : !hasPlanningContext
      ? "Please provide some context in the box above before copying a prompt or opening a Codex thread."
      : undefined;
  const canUsePrompt = Boolean(state) && hasPlanningContext;

  async function copyPrompt() {
    if (!canUsePrompt) {
      if (promptDisabledReason) setMessage(promptDisabledReason);
      return;
    }
    await navigator.clipboard?.writeText(prompt).catch(() => undefined);
    setMessage("Prompt copied. Paste it into Codex when you are ready.");
  }

  async function openInCodex() {
    if (!state || !canUsePrompt) {
      if (promptDisabledReason) setMessage(promptDisabledReason);
      return;
    }
    try {
      await openCodexPromptForState(state, prompt);
      setMessage("Opened a Codex draft thread. Your tutorial progress will be here when you come back.");
    } catch {
      await navigator.clipboard?.writeText(prompt).catch(() => undefined);
      setMessage("Could not open Codex automatically, so the prompt was copied if clipboard access was available.");
    }
  }

  return (
    <section className="tutorial-composer">
      <p className="eyebrow">Try it with your context</p>
      <label htmlFor="tutorial-planning-context">
        Paste a project note, repo summary, issue list, external planning export, or a rough description.
      </label>
      <textarea
        id="tutorial-planning-context"
        value={planningContext}
        onChange={(event) => onPlanningContextChange(event.target.value)}
        placeholder="Example: I have a local project for a small SaaS dashboard. The next work is onboarding, billing settings, and a cleaner release checklist..."
      />
      <div className="tutorial-composer-actions">
        <span className={`tutorial-action-tooltip ${!canUsePrompt ? "blocked" : ""}`} data-tooltip={promptDisabledReason}>
          <button onClick={copyPrompt} disabled={!canUsePrompt}>
            <Copy size={14} />
            Copy prompt
          </button>
        </span>
        <span className={`tutorial-action-tooltip ${!canUsePrompt ? "blocked" : ""}`} data-tooltip={promptDisabledReason}>
          <button className="primary" onClick={openInCodex} disabled={!canUsePrompt}>
            <Send size={14} />
            Open in Codex thread
          </button>
        </span>
      </div>
      {message ? <p className="tutorial-status">{message}</p> : null}
    </section>
  );
}

function TutorialFeedbackPreview() {
  return (
    <section className="tutorial-feedback-preview">
      <div className="tutorial-toolbar-preview" aria-hidden="true">
        <span>v1</span>
        <button>
          <MessageSquareText size={15} />
        </button>
        <button>
          <RefreshCw size={15} />
        </button>
      </div>
      <div>
        <p className="eyebrow">Feedback button</p>
        <h3>Send rough feedback through your agent</h3>
        <p>
          Type the bug, request, or reaction. Planban turns it into a Codex-ready prompt, then your
          agent helps prepare a GitHub issue before anything is public.
        </p>
      </div>
    </section>
  );
}

const tutorialSteps = [
  {
    title: "Planban keeps planning shared",
    copy: "Use each Planban board as a project second brain: plans, ideas, rough notes, future features, priorities, and roadmap state that Codex can read and update with you.",
  },
  {
    title: "Cards move as work changes",
    copy: "Drag cards between Up Next, In Progress, Pending, and Complete so priority and status stay visible. Try moving the In Progress card to Complete when the work is reviewed.",
  },
  {
    title: "Cards hold the working context",
    copy: "Click to open a card and see its next action, spec, plan, and the context Codex should use when starting work.",
  },
  {
    title: "Open Planban from any thread",
    copy: "Codex browser tabs are thread-local, but Planban can be summoned again from your Codex chat thread with /PB, /Planban, or a plain prompt.",
  },
  {
    title: "Create planning from rough context",
    copy: "Codex can create Planban boards for the projects that need them, then populate those boards from notes, repo docs, GitHub Issues, or connected tools such as Notion, Linear, and Jira.",
  },
  {
    title: "Feedback is agent-native too",
    copy: "Use the feedback icon on your board or the /planban feedback command in your agent. Your agent packages the issue before anything is sent to us.",
  },
] as const;

function TutorialPage({ onSelectBoard }: { onSelectBoard: (repoId: string | null) => void }) {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode") ?? "first-run";
  const [state, setState] = useState<PlanbanState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [tutorialItems, setTutorialItems] = useState<RoadmapItem[]>(() => tutorialItemsFromState(null));
  const [selectedId, setSelectedId] = useState<string | null>("drag-this-card-to-in-progress");
  const [detailRevealed, setDetailRevealed] = useState(false);
  const [stepTwoMoved, setStepTwoMoved] = useState(false);
  const [planningContext, setPlanningContext] = useState("");
  const step = tutorialSteps[stepIndex]!;
  const selectedItem = tutorialItems.find((item) => item.id === selectedId) ?? tutorialItems[0] ?? null;
  const isFinalStep = stepIndex === tutorialSteps.length - 1;
  const nextButtonLabel = stepIndex === 1 ? "Next: open a card" : "Next";

  useEffect(() => {
    let cancelled = false;
    async function loadDemo() {
      try {
        const demoState = await api<PlanbanState>("/api/demo", { method: "POST", body: "{}" });
        if (cancelled) return;
        setState(demoState);
        const nextItems = tutorialItemsFromState(demoState);
        setTutorialItems(nextItems);
        setSelectedId(nextItems.find((item) => item.id === "drag-this-card-to-in-progress")?.id ?? nextItems[0]?.id ?? null);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Could not prepare the demo board");
      }
    }
    void loadDemo();
    return () => {
      cancelled = true;
    };
  }, []);

  function finish(status: "completed" | "skipped") {
    writeTutorialProgress(status);
    if (state) onSelectBoard(state.manifest.repoId);
    else window.location.assign("/boards");
  }

  function goToStep(index: number) {
    setStepIndex(Math.max(0, Math.min(tutorialSteps.length - 1, index)));
    if (index !== 2) setDetailRevealed(false);
    if (index === 1) {
      const completionCard = tutorialItems.find((item) => item.id === "mark-a-card-complete-when-you-are-done");
      if (completionCard) setSelectedId(completionCard.id);
    }
  }

  function resetTutorialDemoState() {
    const nextItems = tutorialItemsFromState(state);
    setTutorialItems(nextItems);
    setSelectedId(nextItems.find((item) => item.id === "drag-this-card-to-in-progress")?.id ?? nextItems[0]?.id ?? null);
    setStepTwoMoved(false);
  }

  function moveTutorialItem(id: string, status: Status, beforeId: string | null = null) {
    setTutorialItems((current) => {
      const active = current.find((item) => item.id === id);
      if (!active) return current;
      const remaining = current.filter((item) => item.id !== id);
      const moved = { ...active, status };
      let insertAt = -1;
      if (beforeId) {
        insertAt = remaining.findIndex((item) => item.id === beforeId);
      }
      if (insertAt < 0) {
        const targetIndexes = remaining
          .map((item, index) => (item.status === status ? index : -1))
          .filter((index) => index >= 0);
        insertAt = targetIndexes.length ? Math.max(...targetIndexes) + 1 : remaining.length;
      }
      return [...remaining.slice(0, insertAt), moved, ...remaining.slice(insertAt)];
    });
    setSelectedId(id);
    if (status === "complete") setStepTwoMoved(true);
  }

  return (
    <main className="tutorial-screen">
      <div className="tutorial-background" aria-hidden="true">
        <TutorialBackground items={tutorialItems} />
      </div>

      <section className="tutorial-shell" aria-label="Planban tutorial">
        <header className="tutorial-header">
          <div>
            <p className="eyebrow">{mode === "whats-new" ? "Planban update" : "Welcome to Planban"}</p>
            <h1>A local board that Codex can work from</h1>
          </div>
          <div className="tutorial-header-actions">
            <button
              onClick={() => {
                resetTutorialDemoState();
                setDetailRevealed(false);
                setPlanningContext("");
                goToStep(0);
              }}
            >
              <RotateCcw size={14} />
              Restart
            </button>
            <button onClick={() => finish("skipped")}>Skip</button>
          </div>
        </header>

        <div className="tutorial-body">
          <section className="tutorial-copy">
            <div className="tutorial-progress" aria-label={`Step ${stepIndex + 1} of ${tutorialSteps.length}`}>
              {tutorialSteps.map((entry, index) => (
                <button
                  key={entry.title}
                  className={index === stepIndex ? "active" : index < stepIndex ? "done" : ""}
                  aria-label={`Go to step ${index + 1}: ${entry.title}`}
                  onClick={() => goToStep(index)}
                />
              ))}
            </div>
            <p className="tutorial-step-label">Step {stepIndex + 1} of {tutorialSteps.length}</p>
            <h2>{step.title}</h2>
            <p>{step.copy}</p>

            {stepIndex === 1 ? (
              <div className="tutorial-step-action">
                <div>
                  <b>Move a card</b>
                  <span>Try moving the selected In Progress card to Complete.</span>
                </div>
                <button className="tutorial-action" onClick={() => moveTutorialItem(selectedItem?.id ?? "mark-a-card-complete-when-you-are-done", "complete")}>
                  <ArrowRight size={14} />
                  Move selected card
                </button>
                {stepTwoMoved ? (
                  <p className="tutorial-status success">
                    Card moved. Choose Next: open a card to continue.
                  </p>
                ) : null}
              </div>
            ) : null}

            {stepIndex === 2 ? (
              <div className="tutorial-step-action">
                <div>
                  <b>Click any card</b>
                  <span>Planban cards open into the working context Codex can read.</span>
                </div>
              </div>
            ) : null}

            {error ? <p className="tutorial-status">Demo board fallback active: {error}</p> : null}
          </section>

          <section className={`tutorial-stage ${stepIndex === 3 ? "empty" : ""}`}>
            {stepIndex === 0 ? (
              <TutorialIntroPreview />
            ) : stepIndex === 3 ? (
              null
            ) : stepIndex === 4 ? (
              <TutorialPlanningComposer
                state={state}
                planningContext={planningContext}
                onPlanningContextChange={setPlanningContext}
              />
            ) : stepIndex === 5 ? (
              <TutorialFeedbackPreview />
            ) : stepIndex === 2 && detailRevealed ? (
              <div className="tutorial-stage-board">
                <TutorialDetailPreview item={selectedItem} onBack={() => setDetailRevealed(false)} />
              </div>
            ) : (
              <div className="tutorial-stage-board">
                {stepIndex === 1 ? (
                  <TutorialLiveBoard
                    items={tutorialItems}
                    onSelect={setSelectedId}
                    onItemsChange={(nextItems, nextSelectedId) => {
                      setTutorialItems(nextItems);
                      if (nextSelectedId) setSelectedId(nextSelectedId);
                      setStepTwoMoved(true);
                    }}
                  />
                ) : stepIndex === 2 ? (
                  <TutorialLiveBoard
                    items={tutorialItems}
                    onSelect={(id) => {
                      setSelectedId(id);
                      setDetailRevealed(true);
                    }}
                    draggable={false}
                  />
                ) : (
                  <TutorialMiniBoard
                    items={tutorialItems}
                    selectedId={selectedId}
                    onSelect={(id) => {
                      setSelectedId(id);
                      if (stepIndex === 2) setDetailRevealed(true);
                    }}
                  />
                )}
              </div>
            )}
          </section>
        </div>

        <footer className="tutorial-footer">
          <button onClick={() => goToStep(stepIndex - 1)} disabled={stepIndex === 0}>
            Back
          </button>
          {isFinalStep ? (
            <button className="primary" onClick={() => finish("completed")}>
              <CheckCircle2 size={14} />
              Finish tutorial
            </button>
          ) : (
            <button className="primary" onClick={() => goToStep(stepIndex + 1)}>
              {nextButtonLabel}
              <ArrowRight size={14} />
            </button>
          )}
        </footer>
      </section>
    </main>
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
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatusPayload | null>(null);
  const [showFirstRunPrompt, setShowFirstRunPrompt] = useState(() => readTutorialProgress() === null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const boardId = state.manifest.repoId;
  const displayState = preview?.state ?? state;
  const previewVersion = preview?.version ?? null;
  const isPreviewing = preview !== null;
  const isDemoBoard = boardId === "planban-demo";

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

  const loadUpdateStatus = useCallback(async () => {
    const payload = await api<UpdateStatusPayload>("/api/update-status");
    setUpdateStatus(payload);
    return payload;
  }, []);

  useEffect(() => {
    setPreview(null);
    void loadHistory().catch(() => setHistory(null));
    void loadUpdateStatus().catch(() => undefined);
  }, [boardId, loadHistory, loadUpdateStatus]);

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
      <header className={`app-header ${updateStatus?.updateAvailable ? "has-update" : ""}`}>
        <div className="board-title-group">
          <div className="board-breadcrumb">
            <span className="board-breadcrumb-main">
              <button className="board-breadcrumb-home" onClick={() => onSelectBoard(null)}>Planban</button>
              <span>/</span>
              <span>{state.roadmap.project.title}</span>
            </span>
          </div>
          <BoardPicker boards={boards} currentRepoId={boardId} onSelectBoard={onSelectBoard} />
        </div>
        <div className={`header-controls ${updateStatus?.updateAvailable ? "has-update" : ""}`}>
          {updateStatus?.updateAvailable ? (
            <div className="header-update-row">
              <button
                className="toolbar-button update-available-button"
                onClick={() => {
                  setUpdateOpen(true);
                  void loadUpdateStatus().catch(() => undefined);
                }}
              >
                <CircleArrowUp size={14} />
                <span>Update Available</span>
              </button>
            </div>
          ) : null}
          <div className="header-actions">
            {!isDemoBoard ? (
              <HistoryPicker
                history={history}
                previewVersion={previewVersion}
                onSelectVersion={previewHistoryVersion}
                onReturnToCurrent={returnToCurrent}
              />
            ) : null}
            <TooltipButton
              label="Open Planban tutorial"
              className="toolbar-icon-button tooltip-below"
              onClick={() => openTutorial("first-run")}
            >
              <HelpCircle size={14} />
            </TooltipButton>
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
        </div>
      </header>

      {feedbackOpen ? <FeedbackModal state={state} onClose={() => setFeedbackOpen(false)} /> : null}
      {updateOpen ? (
        <UpdateModal
          state={state}
          status={updateStatus}
          onClose={() => setUpdateOpen(false)}
        />
      ) : null}

      {showFirstRunPrompt && !isPreviewing ? (
        <FirstRunPrompt onDismiss={() => setShowFirstRunPrompt(false)} />
      ) : null}

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

function BoardDashboard({
  boards,
  onSelectBoard,
  onBoardsChanged,
}: {
  boards: BoardRecord[];
  onSelectBoard: (repoId: string) => void;
  onBoardsChanged: () => Promise<void>;
}) {
  const [showArchivedBoards, setShowArchivedBoards] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ kind: "archive" | "delete"; board: BoardRecord } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [busyAction, setBusyAction] = useState<"archive" | "delete" | "restore" | null>(null);
  const [toast, setToast] = useState<{ tone: "success" | "error"; message: string; detail?: string } | null>(null);
  const activeBoards = boards.filter((board) => !board.archivedAt);
  const archivedBoards = boards.filter((board) => board.archivedAt);
  const visibleBoards = showArchivedBoards ? archivedBoards : activeBoards;

  useEffect(() => {
    if (!toast) return undefined;
    const timeout = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (showArchivedBoards && archivedBoards.length === 0) {
      setShowArchivedBoards(false);
    }
  }, [archivedBoards.length, showArchivedBoards]);

  useEffect(() => {
    if (!pendingAction) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !busyAction) closeBoardActionModal();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busyAction, pendingAction]);

  function closeBoardActionModal() {
    setPendingAction(null);
    setDeleteConfirm("");
  }

  function startBoardAction(kind: "archive" | "delete", board: BoardRecord) {
    setDeleteConfirm("");
    setPendingAction({ kind, board });
  }

  async function restoreWholeBoard(board: BoardRecord) {
    setBusyAction("restore");
    try {
      await api<{ board: BoardRecord }>(`/api/boards/${encodeURIComponent(board.repoId)}/restore`, {
        method: "POST",
        body: "{}",
      });
      await onBoardsChanged();
      setToast({ tone: "success", message: `Restored ${board.title}` });
    } catch (error) {
      setToast({
        tone: "error",
        message: `Could not restore ${board.title}`,
        detail: error instanceof Error ? error.message : "Restore failed.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function confirmBoardAction() {
    if (!pendingAction) return;
    const { kind, board } = pendingAction;
    if (kind === "delete" && deleteConfirm !== board.repoId) return;
    setBusyAction(kind);
    try {
      if (kind === "archive") {
        await api<{ board: BoardRecord }>(`/api/boards/${encodeURIComponent(board.repoId)}/archive`, {
          method: "POST",
          body: "{}",
        });
        await onBoardsChanged();
        setToast({ tone: "success", message: `Archived ${board.title}` });
      } else {
        const result = await api<{ repoId: string; backupPath: string | null }>(`/api/boards/${encodeURIComponent(board.repoId)}`, {
          method: "DELETE",
          body: JSON.stringify({ confirmRepoId: board.repoId }),
        });
        await onBoardsChanged();
        setToast({
          tone: "success",
          message: `Deleted ${board.title}`,
          detail: result.backupPath ? "Backup saved locally." : "No local planning root existed to back up.",
        });
      }
      closeBoardActionModal();
    } catch (error) {
      setToast({
        tone: "error",
        message: kind === "archive" ? `Could not archive ${board.title}` : `Could not delete ${board.title}`,
        detail: error instanceof Error ? error.message : "Board action failed.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <main className="board-dashboard">
      <header className="app-header">
        <div>
          <p className="eyebrow">Planban</p>
          <h1>Boards</h1>
        </div>
        {archivedBoards.length > 0 ? (
          <button
            className={`archive-toggle ${showArchivedBoards ? "active" : ""}`}
            aria-pressed={showArchivedBoards}
            onClick={() => setShowArchivedBoards((value) => !value)}
          >
            <span>{showArchivedBoards ? "Active boards" : "Archived boards"}</span>
            <span className="archive-switch" aria-hidden="true">
              <span className="archive-switch-knob" />
            </span>
          </button>
        ) : null}
      </header>
      <section className="board-list">
        {visibleBoards.length > 0 ? (
          visibleBoards.map((board) => (
            <article key={board.repoId} className={`board-list-item ${board.archivedAt ? "archived" : ""}`}>
              <button className="board-list-open" onClick={() => onSelectBoard(board.repoId)} disabled={Boolean(board.archivedAt)}>
                <span>
                  <span className="board-list-title-row">
                    <b>{board.title}</b>
                    {board.kind === "demo" ? <small className="board-kind-pill">Demo</small> : null}
                    {board.archivedAt ? <small className="board-kind-pill">Archived</small> : null}
                  </span>
                  <small>{board.cwd}</small>
                </span>
                <small>{board.repoId}</small>
              </button>
              <span className="board-list-actions">
                {board.archivedAt ? (
                  <TooltipButton
                    label={`Restore ${board.title}`}
                    tooltipPlacement="top"
                    className="board-list-action-button"
                    onClick={() => void restoreWholeBoard(board)}
                  >
                    <RotateCcw size={14} />
                  </TooltipButton>
                ) : (
                  <TooltipButton
                    label={`Archive ${board.title}`}
                    tooltipPlacement="top"
                    className="board-list-action-button"
                    onClick={() => startBoardAction("archive", board)}
                  >
                    <Archive size={14} />
                  </TooltipButton>
                )}
                <TooltipButton
                  label={`Delete ${board.title}`}
                  tooltipPlacement="top"
                  className="board-list-action-button danger"
                  onClick={() => startBoardAction("delete", board)}
                >
                  <Trash2 size={14} />
                </TooltipButton>
              </span>
            </article>
          ))
        ) : (
          <div className="empty-boards">
            <h2>{showArchivedBoards ? "No archived boards" : "No Planban boards registered yet"}</h2>
            <p>
              {showArchivedBoards
                ? "Archived boards will appear here when you hide boards from your normal list."
                : "Open Planban from a project or initialize a repo to add it to this device."}
            </p>
          </div>
        )}
      </section>
      {pendingAction ? (
        <div className="modal-backdrop board-action-backdrop" role="presentation" onMouseDown={() => {
          if (!busyAction) closeBoardActionModal();
        }}>
          <section
            className="board-action-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="board-action-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="feedback-modal-header">
              <div>
                <p className="eyebrow">{pendingAction.kind === "archive" ? "Archive board" : "Delete board"}</p>
                <h2 id="board-action-title">
                  {pendingAction.kind === "archive"
                    ? pendingAction.board.kind === "demo"
                      ? "Remove this demo board?"
                      : `Archive ${pendingAction.board.title}?`
                    : `Delete ${pendingAction.board.title}?`}
                </h2>
              </div>
              <TooltipButton label="Close" className="toolbar-icon-button" onClick={closeBoardActionModal} disabled={Boolean(busyAction)}>
                <X size={14} />
              </TooltipButton>
            </header>
            <div className="board-action-modal-body">
              {pendingAction.kind === "archive" ? (
                <>
                  <p>Archive hides this board from your normal board list while keeping its local Planban state intact.</p>
                  <p>You can restore it later from the archived boards view.</p>
                </>
              ) : (
                <>
                  <p>Delete removes this board from Planban after creating a timestamped local backup.</p>
                  <p>Planban will not delete the source project repository.</p>
                  <label className="board-delete-confirm">
                    <span>Type <b>{pendingAction.board.repoId}</b> to confirm.</span>
                    <input
                      autoFocus
                      value={deleteConfirm}
                      onChange={(event) => setDeleteConfirm(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && deleteConfirm === pendingAction.board.repoId && !busyAction) {
                          event.preventDefault();
                          void confirmBoardAction();
                        }
                      }}
                      placeholder={pendingAction.board.repoId}
                      disabled={busyAction === "delete"}
                    />
                  </label>
                </>
              )}
            </div>
            <footer className="feedback-actions">
              <button onClick={closeBoardActionModal} disabled={Boolean(busyAction)}>Cancel</button>
              <button
                className={`board-action-confirm ${pendingAction.kind === "delete" ? "danger primary" : "archive primary"}`}
                onClick={() => void confirmBoardAction()}
                disabled={Boolean(busyAction) || (pendingAction.kind === "delete" && deleteConfirm !== pendingAction.board.repoId)}
              >
                {busyAction === pendingAction.kind ? <Loader2 size={14} className="spin" /> : pendingAction.kind === "archive" ? <Archive size={14} /> : <Trash2 size={14} />}
                {pendingAction.kind === "archive" ? "Archive" : "Delete board"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
      {toast ? (
        <div className={`toast ${toast.tone}`} role="status" aria-live="polite">
          <b>{toast.message}</b>
          {toast.detail ? <span>{toast.detail}</span> : null}
        </div>
      ) : null}
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
        api<BoardsPayload>("/api/boards?includeArchived=true"),
      ]);
      if (requestId !== appLoadRequestRef.current) return;
      setInitialized(status.initialized);
      setBoards(boardsPayload.boards);
      if (isTutorialPath()) {
        setSelectedRepoId(null);
        setState(null);
        return;
      }
      const routeRepoId = repoIdFromPath();
      const activeBoards = boardsPayload.boards.filter((board) => !board.archivedAt);
      const nextRepoId = isBoardDashboardPath()
        ? null
        : routeRepoId ?? selectedRepoIdRef.current ?? status.currentRepoId ?? null;
      if (nextRepoId) {
        if (!activeBoards.some((board) => board.repoId === nextRepoId)) {
          replaceBoardPath(null);
          setSelectedRepoId(null);
          setState(null);
          return;
        }
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
    events.addEventListener("boards", () => void load());
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
  if (isTutorialPath()) return <TutorialPage onSelectBoard={selectBoard} />;
  if (!selectedRepoId && boards.length > 0) return <BoardDashboard boards={boards} onSelectBoard={selectBoard} onBoardsChanged={load} />;
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
  if (!selectedRepoId && boards.length === 0) return <BoardDashboard boards={boards} onSelectBoard={selectBoard} onBoardsChanged={load} />;
  if (!state) return <main className="loading-screen">Loading Planban...</main>;
  return <BoardView state={state} boards={boards.filter((board) => !board.archivedAt)} onStateChange={setState} onSelectBoard={selectBoard} />;
}

createRoot(document.getElementById("root")!).render(<App />);
