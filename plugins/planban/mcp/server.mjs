import { spawn } from "node:child_process";
import readline from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function resolveRuntimeRoot() {
  const bundledRuntimeRoot = resolve(PLUGIN_ROOT, "runtime");
  if (existsSync(resolve(bundledRuntimeRoot, "src/core/storage.ts"))) return bundledRuntimeRoot;
  if (process.env.PLANBAN_REPO_ROOT) return resolve(process.env.PLANBAN_REPO_ROOT);
  return resolve(PLUGIN_ROOT, "../..");
}

const PLANBAN_RUNTIME_ROOT = resolveRuntimeRoot();
const HAS_BUILT_WEB_BUNDLE = existsSync(resolve(PLANBAN_RUNTIME_ROOT, "dist/web/index.html"));
const storageModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/storage.ts")).href);
const registryModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/registry.ts")).href);
const typesModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/types.ts")).href);
const queryModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/workItemQuery.ts")).href);
const demoModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/demo.ts")).href);
const versionModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/version.ts")).href);

const { cardAncestry, createCard, createCards, createGroup, exportFlatVersion1, getStatus, loadState, moveCard, readDoc, reconstructHierarchy, setCardParent, updateCard, writeDoc } = storageModule;
const { archiveBoard, deleteBoard, duplicateBoard, listAllBoards, listBoards, resolveBoardCwd, restoreBoard } = registryModule;
const { PLANBAN_STATUSES } = typesModule;
const { queryWorkItems } = queryModule;
const { ensureDemoBoard } = demoModule;
const { PLANBAN_MCP_VERSION } = versionModule;

const SERVER_NAME = "Planban MCP";
const SERVER_VERSION = PLANBAN_MCP_VERSION;
const JsonRpcError = {
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export function planbanMcpServerVersion() {
  return SERVER_VERSION;
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function requireObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function requireText(value, name) {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string.`);
  }
  return value;
}

function optionalString(value, name) {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
}

function optionalNullableString(value, name) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireString(value, name);
}

function optionalNumber(value, name) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  return value;
}

function optionalRevision(value, name) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return value;
}

function optionalBoolean(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean.`);
  return value;
}

function optionalStringArray(value, name) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${name} must be an array of strings.`);
  }
  return value;
}

function optionalMetadata(value, name) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object or null.`);
  }
  return value;
}

function requireDocKind(value) {
  const kind = requireString(value, "kind");
  if (kind !== "spec" && kind !== "plan") throw new Error("kind must be spec or plan.");
  return kind;
}

function requireStatus(value) {
  const status = requireString(value, "status");
  if (!PLANBAN_STATUSES.includes(status)) {
    throw new Error(`status must be one of: ${PLANBAN_STATUSES.join(", ")}.`);
  }
  return status;
}

function optionalStatus(value, name) {
  if (value === undefined || value === null) return undefined;
  return requireStatus(value, name);
}

function optionalCreatePosition(value, name) {
  if (value === undefined || value === null) return undefined;
  const position = requireString(value, name);
  if (position !== "top" && position !== "bottom") throw new Error(`${name} must be top or bottom.`);
  return position;
}

async function cwdFromArgs(args) {
  if (typeof args.cwd === "string" && args.cwd.trim()) return resolve(args.cwd);
  if (typeof args.repoId === "string" && args.repoId.trim()) return await resolveBoardCwd(args.repoId.trim());
  throw new Error("cwd or repoId is required.");
}

function summarizeBoard(state) {
  return {
    cwd: state.cwd,
    manifestPath: state.manifestPath,
    planningRoot: state.planningRoot,
    roadmapPath: state.roadmapPath,
    repoId: state.manifest.repoId,
    revision: state.roadmap.revision,
    project: state.roadmap.project,
    columns: state.roadmap.columns,
    roadmapItems: state.roadmap.roadmapItems,
  };
}

function findCard(state, cardId) {
  const card = state.roadmap.roadmapItems.find((item) => item.id === cardId);
  if (!card) throw new Error(`Card not found: ${cardId}`);
  return card;
}

function repoIdFromCwd(cwd) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(cwd, ".planban/project.json"), "utf8"));
    return typeof manifest.repoId === "string" && manifest.repoId.trim() ? manifest.repoId.trim() : null;
  } catch {
    return null;
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json();
}

async function verifyWebSurface(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.text();
    if (!body.includes('<div id="root"></div>')) throw new Error("response is not the Planban web surface");
    const parsedUrl = new URL(url);
    const boardMatch = parsedUrl.pathname.match(/^\/boards\/([^/]+)$/u);
    if (boardMatch) {
      const health = await fetch(`${parsedUrl.origin}/api/boards/${boardMatch[1]}/health`, { signal: controller.signal });
      if (!health.ok) throw new Error(`board health returned HTTP ${health.status}`);
      const payload = await health.json().catch(() => null);
      if (payload?.ok !== true) throw new Error("board health response was invalid");
    }
  } catch (error) {
    throw new Error(`Planban service resolved ${url}, but URL verification failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

function verifiedLaunchResult({ cwd, port, started, url }) {
  return {
    ok: true,
    cwd,
    port,
    started,
    url,
    urlVerified: true,
    serviceReady: true,
    capabilities: {
      canonicalUrl: true,
      browserPresentation: "client-optional",
      userReplyRequiresUrl: true,
    },
    userReply: {
      urlRequired: true,
      url,
      markdown: `[Open the verified board](${url})`,
    },
    diagnostics: [
      {
        boundary: "service-url",
        status: "ready",
        code: started ? "service_started" : "service_reused",
      },
    ],
  };
}

async function statusFor(baseUrl) {
  return await fetchJson(`${baseUrl}/api/status`);
}

async function boardsFor(baseUrl) {
  return await fetchJson(`${baseUrl}/api/boards`);
}

async function waitForStatus(baseUrl, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      return await statusFor(baseUrl);
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw lastError ?? new Error("Timed out waiting for Planban.");
}

async function isPortOpen(port, timeoutMs = 750) {
  return await new Promise((resolveProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveProbe(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function boardUrl(baseUrl, status, cwd) {
  const targetRepoId = repoIdFromCwd(cwd);
  const statusRepoId = status.currentRepoId ?? status.repoId;

  if (targetRepoId && statusRepoId === targetRepoId) {
    return `${baseUrl}/boards/${encodeURIComponent(targetRepoId)}`;
  }

  const boards = await boardsFor(baseUrl).catch(() => null);
  const boardList = Array.isArray(boards?.boards) ? boards.boards : null;

  if (targetRepoId) {
    const hasTargetBoard = boardList?.some((board) => board.repoId === targetRepoId) ?? statusRepoId === targetRepoId;
    return hasTargetBoard ? `${baseUrl}/boards/${encodeURIComponent(targetRepoId)}` : `${baseUrl}/boards`;
  }

  if (boardList?.length === 1 && typeof boardList[0]?.repoId === "string") {
    return `${baseUrl}/boards/${encodeURIComponent(boardList[0].repoId)}`;
  }

  if (boardList && boardList.length !== 1) return `${baseUrl}/boards`;

  return statusRepoId ? `${baseUrl}/boards/${encodeURIComponent(statusRepoId)}` : `${baseUrl}/boards`;
}

async function launchBoard(args) {
  const cwd = optionalBoolean(args.demo, "demo") ? (await ensureDemoBoard()).cwd : await cwdFromArgs(args);
  const port = optionalNumber(args.port, "port") ?? 4317;
  if (!Number.isInteger(port) || port <= 0) throw new Error("port must be a positive integer.");
  const baseUrl = `http://127.0.0.1:${port}`;
  const existingStatus = await statusFor(baseUrl).catch(() => null);
  if (existingStatus) {
    const url = await boardUrl(baseUrl, existingStatus, cwd);
    await verifyWebSurface(url);
    return verifiedLaunchResult({ cwd, port, started: false, url });
  }

  if (await isPortOpen(port)) {
    throw new Error(`Port ${port} is already in use by another service. Stop that process or choose a different Planban port.`);
  }

  const repoRoot = process.env.PLANBAN_REPO_ROOT ? resolve(process.env.PLANBAN_REPO_ROOT) : resolve(process.cwd());
  const cliPath = resolve(repoRoot, "bin/planban.mjs");
  if (!existsSync(cliPath)) throw new Error(`Planban CLI not found at ${cliPath}`);

  const serveArgs = [cliPath, "serve", "--cwd", cwd, "--port", String(port)];
  if (HAS_BUILT_WEB_BUNDLE) serveArgs.push("--no-vite");

  const child = spawn(process.execPath, serveArgs, {
    cwd: repoRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const status = await waitForStatus(baseUrl);
  const url = await boardUrl(baseUrl, status, cwd);
  await verifyWebSurface(url);
  return verifiedLaunchResult({ cwd, port, started: true, url });
}

const schema = {
  object(properties, required = []) {
    return {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    };
  },
};

const commonBoardProperties = {
  cwd: {
    type: "string",
    description: "Absolute path to a repository with .planban/project.json. Required unless repoId is provided.",
  },
  repoId: {
    type: "string",
    description: "Registered Planban repo id. Used only when cwd is omitted.",
  },
};

const tools = [
  {
    name: "planban_status",
    title: "Planban Status",
    description: "Check whether Planban is initialized for a local repository and report live state paths.",
    inputSchema: schema.object(commonBoardProperties),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_list_boards",
    title: "List Planban Boards",
    description: "List registered local Planban boards on this device.",
    inputSchema: schema.object({
      includeArchived: { type: "boolean", description: "Include archived boards." },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_archive_board",
    title: "Archive Planban Board",
    description: "Archive a whole Planban board. This hides it from normal board lists but keeps local planning state intact.",
    inputSchema: schema.object({
      repoId: { type: "string", description: "Registered Planban repo id to archive." },
    }, ["repoId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_restore_board",
    title: "Restore Planban Board",
    description: "Restore an archived Planban board.",
    inputSchema: schema.object({
      repoId: { type: "string", description: "Registered Planban repo id to restore." },
    }, ["repoId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_duplicate_board",
    title: "Duplicate Planban Board",
    description: "Duplicate a whole Planban board into a new local Planban board. The source board is left untouched.",
    inputSchema: schema.object({
      sourceRepoId: { type: "string", description: "Registered Planban repo id to duplicate." },
      repoId: { type: "string", description: "Optional repo id for the duplicated board." },
      title: { type: "string", description: "Optional title for the duplicated board." },
    }, ["sourceRepoId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_delete_board",
    title: "Delete Planban Board",
    description: "Delete a whole Planban board after creating a timestamped local backup. This never deletes the user's source project repository.",
    inputSchema: schema.object({
      repoId: { type: "string", description: "Registered Planban repo id to delete." },
      confirmRepoId: { type: "string", description: "Must exactly match repoId." },
    }, ["repoId", "confirmRepoId"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_get_board",
    title: "Get Planban Board",
    description: "Load one Planban board state for a repo path or registered repo id.",
    inputSchema: schema.object(commonBoardProperties),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_query_cards",
    title: "Query Planban Work Items",
    description: "Search and compose projection, hierarchy, Group-role, status, blocked, and tag filters without changing roadmap state.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      search: { type: "string", description: "Search id, title, summary, next action, and tags." },
      projection: { type: "string", enum: ["main", "group", "flattened"] },
      groupId: { type: "string", description: "Selected Group for Group projection or selected-Group scope." },
      hierarchyScope: { type: "string", enum: ["projection", "root", "owned", "leaf", "selected-group"] },
      groupRole: { type: "string", enum: ["any", "group", "item-only"] },
      statuses: { type: "array", items: { type: "string", enum: [...PLANBAN_STATUSES] } },
      blocked: { type: "string", enum: ["any", "blocked", "unblocked"] },
      tags: { type: "array", items: { type: "string" } },
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_get_card",
    title: "Get Planban Card",
    description: "Read one Planban roadmap card, including linked document paths and metadata.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
    }, ["cardId"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_export_flat_v1",
    title: "Export Recoverable Flat Version-1 Board",
    description: "Create a deliberate history-backed flat version-1 export without changing the live hierarchy.",
    inputSchema: schema.object({ ...commonBoardProperties, exportId: { type: "string" } }, ["exportId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_reconstruct_hierarchy",
    title: "Reconstruct Planban Hierarchy",
    description: "Atomically attach existing Work Items into explicit ordered Group mappings without recreating cards or documents.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      groups: { type: "array", items: { type: "object", properties: { id: { type: "string" }, childIds: { type: "array", items: { type: "string" } } }, required: ["id", "childIds"], additionalProperties: false } },
      baseRevision: { type: "number" },
    }, ["baseRevision"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_create_card",
    title: "Create Planban Card",
    description: "Create a Planban roadmap card with optional placement, tags, metadata, and initial spec or plan markdown. Follow the installed Planban house style for all owner-facing fields and documents.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      title: { type: "string", description: "Card title." },
      status: { type: "string", enum: [...PLANBAN_STATUSES], description: "Initial status. Defaults to pending." },
      summary: { type: "string", description: "Optional card summary." },
      nextAction: { type: "string", description: "Optional next action." },
      tags: { type: "array", items: { type: "string" }, description: "Tags to attach." },
      metadata: { type: ["object", "null"], description: "Optional metadata object." },
      specMarkdown: { type: "string", description: "Optional initial spec markdown. A default spec is generated when omitted." },
      planMarkdown: { type: "string", description: "Optional initial plan markdown. Creates a plan document when supplied." },
      position: { type: "string", enum: ["top", "bottom"], description: "Insert at top or bottom of the target status column." },
      afterId: { type: "string", description: "Optional card id to insert after in the target status column." },
      parentId: { type: "string", description: "Optional existing Group id. Creates an owned Item." },
      baseRevision: { type: "number", description: "Optional roadmap revision for stale-write protection." },
    }, ["title"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_create_group",
    title: "Create Planban Group",
    description: "Create a distinct Group and place existing root Items inside it without changing their identities or documents. Follow the installed Planban house style. Agents should normally supply a concise objective unless explicitly asked not to.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      title: { type: "string", description: "Group title." },
      summary: { type: "string", description: "Group-level objective uniting its Items. Optional in storage and UI; agents should normally supply it unless explicitly asked not to." },
      nextAction: { type: "string", description: "Optional Group next action." },
      status: { type: "string", enum: [...PLANBAN_STATUSES], description: "Initial Group status." },
      itemIds: { type: "array", items: { type: "string" }, description: "Existing root Items to place inside the new Group." },
      anchorId: { type: "string", description: "Initial Item whose Main Board position the Group takes." },
      specMarkdown: { type: "string", description: "Optional initial Group spec markdown." },
      planMarkdown: { type: "string", description: "Optional initial Group plan markdown." },
      baseRevision: { type: "number", description: "Optional roadmap revision for stale-write protection." },
    }, ["title"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_create_cards",
    title: "Create Multiple Planban Cards",
    description: "Atomically create one or more sibling Work Item skeletons, optionally inside a Group. Follow the installed Planban house style and add current summaries, next actions, or document detail through focused follow-up mutations when the Items require them.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      titles: { type: "array", items: { type: "string" }, description: "One or more Work Item titles." },
      status: { type: "string", enum: [...PLANBAN_STATUSES], description: "Initial status. Defaults to pending." },
      parentId: { type: "string", description: "Optional parent Group id." },
      baseRevision: { type: "number", description: "Optional roadmap revision for stale-write protection." },
    }, ["titles"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_read_doc",
    title: "Read Planban Document",
    description: "Read a card spec or plan document.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      kind: { type: "string", enum: ["spec", "plan"], description: "Document kind to read." },
    }, ["cardId", "kind"]),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "planban_move_card",
    title: "Place Planban Card",
    description:
      "Place an Item in one mutation: change status, move it into or out of an existing Group, and/or set its sibling rank. Groups cannot be placed inside Groups, and Items never become Groups through movement. Use null afterId for first position. Only use status complete when the user explicitly asks, confirms review/testing, or clearly waives user-side verification; set completionConfirmed true in that case.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      status: { type: "string", enum: [...PLANBAN_STATUSES], description: "Optional target status." },
      parentId: { type: ["string", "null"], description: "Optional root Group/destination id, or null for the Main Board." },
      afterId: { type: ["string", "null"], description: "Optional sibling id to insert after, or null for first position." },
      baseRevision: { type: "number", description: "Optional roadmap revision for stale-write protection." },
      completionConfirmed: {
        type: "boolean",
        description: "Required true when moving a card to complete.",
      },
    }, ["cardId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_update_card",
    title: "Update Planban Card",
    description: "Update non-status card fields such as title, summary, next action, tags, blocked-by, or metadata. Follow the installed Planban house style when owner-facing content changes.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      baseRevision: { type: "number", description: "Optional roadmap revision for stale-write protection." },
      title: { type: "string", description: "New non-empty card title." },
      summary: { type: ["string", "null"], description: "New card summary, or null to clear." },
      nextAction: { type: ["string", "null"], description: "New next action, or null to clear." },
      tags: { type: "array", items: { type: "string" }, description: "Replacement tag list." },
      blockedBy: { type: ["string", "null"], description: "Blocking card id or null." },
      metadata: { type: ["object", "null"], description: "Replacement metadata object or null to clear." },
    }, ["cardId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_set_card_parent",
    title: "Set Planban Card Parent",
    description: "Move an Item into an existing Group, or detach it to the Main Board. Groups cannot be attached and Items are never converted.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      parentId: { type: ["string", "null"], description: "Root Group/destination id, or null for the Main Board." },
      baseRevision: { type: "number", description: "Optional roadmap revision for stale-write protection." },
    }, ["cardId", "parentId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_write_doc",
    title: "Write Planban Document",
    description: "Write a card Spec or Plan with optional stale-file protection. Follow the installed Planban house style, preserve the authoritative current section, and retain exact execution or evidence detail in its proper location.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      kind: { type: "string", enum: ["spec", "plan"], description: "Document kind to write." },
      markdown: { type: "string", description: "Full markdown contents." },
      expectedMtimeMs: { type: ["number", "null"], description: "Optional expected document mtime for stale-write protection." },
    }, ["cardId", "kind", "markdown"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_launch_board",
    title: "Launch Planban Board",
    description:
      "Start or discover the local Planban web app and return the verified board URL. Pass demo true to create/reuse the Planban Demo board. Use the Browser plugin/in-app browser to open the returned URL when the user wants the board visible. Every successful user-facing confirmation must still include the exact clickable URL, even when browser opening succeeds.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      demo: { type: "boolean", description: "Create or reuse the Planban Demo board instead of launching a specific repo board." },
      port: { type: "number", description: "Local port to use. Defaults to 4317." },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

async function callTool(name, rawArgs) {
  const args = requireObject(rawArgs ?? {}, "arguments");
  if (name === "planban_status") {
    const status = await getStatus(await cwdFromArgs(args));
    return textResult(
      status.initialized ? `Planban is initialized for ${status.cwd}.` : `Planban is not initialized for ${status.cwd}.`,
      status,
    );
  }

  if (name === "planban_list_boards") {
    const boards = optionalBoolean(args.includeArchived, "includeArchived") ? await listAllBoards() : await listBoards();
    return textResult(`Found ${boards.length} Planban board${boards.length === 1 ? "" : "s"}.`, { boards });
  }

  if (name === "planban_archive_board") {
    const board = await archiveBoard(requireString(args.repoId, "repoId"));
    return textResult(`Archived Planban board ${board.repoId}.`, { board });
  }

  if (name === "planban_restore_board") {
    const board = await restoreBoard(requireString(args.repoId, "repoId"));
    return textResult(`Restored Planban board ${board.repoId}.`, { board });
  }

  if (name === "planban_duplicate_board") {
    const result = await duplicateBoard({
      sourceRepoId: requireString(args.sourceRepoId, "sourceRepoId"),
      repoId: optionalString(args.repoId, "repoId"),
      title: optionalString(args.title, "title"),
    });
    return textResult(`Duplicated Planban board ${result.source.repoId} to ${result.board.repoId}.`, result);
  }

  if (name === "planban_delete_board") {
    const repoId = requireString(args.repoId, "repoId");
    const confirmRepoId = requireString(args.confirmRepoId, "confirmRepoId");
    if (confirmRepoId !== repoId) throw new Error("confirmRepoId must exactly match repoId.");
    const result = await deleteBoard(repoId);
    return textResult(
      result.backupPath
        ? `Deleted Planban board ${repoId}. A local backup was created at ${result.backupPath}.`
        : `Deleted Planban board ${repoId}. No planning root existed to back up.`,
      result,
    );
  }

  if (name === "planban_get_board") {
    const cwd = await cwdFromArgs(args);
    const state = await loadState(cwd);
    return textResult(`Loaded Planban board ${state.manifest.repoId} at revision ${state.roadmap.revision}.`, summarizeBoard(state));
  }

  if (name === "planban_query_cards") {
    const cwd = await cwdFromArgs(args);
    const state = await loadState(cwd);
    const result = queryWorkItems(state.roadmap.roadmapItems, {
      search: optionalString(args.search, "search"),
      projection: optionalString(args.projection, "projection") === "programme" ? "group" : optionalString(args.projection, "projection"),
      groupId: optionalString(args.groupId, "groupId") ?? optionalString(args.programmeId, "programmeId"),
      hierarchyScope: optionalString(args.hierarchyScope, "hierarchyScope") === "selected-programme" ? "selected-group" : optionalString(args.hierarchyScope, "hierarchyScope"),
      groupRole: (() => {
        const role = optionalString(args.groupRole, "groupRole") ?? optionalString(args.programmeRole, "programmeRole");
        return role === "programme" ? "group" : role === "deliverable-only" ? "item-only" : role;
      })(),
      statuses: optionalStringArray(args.statuses, "statuses"),
      blocked: optionalString(args.blocked, "blocked"),
      tags: optionalStringArray(args.tags, "tags"),
    });
    return textResult(`Matched ${result.matches.length} Planban Work Items at revision ${state.roadmap.revision}.`, {
      cwd: state.cwd,
      repoId: state.manifest.repoId,
      revision: state.roadmap.revision,
      ...result,
    });
  }

  if (name === "planban_get_card") {
    const cwd = await cwdFromArgs(args);
    const cardId = requireString(args.cardId, "cardId");
    const state = await loadState(cwd);
    const card = findCard(state, cardId);
    return textResult(`Loaded Planban card ${card.id}.`, {
      cwd: state.cwd,
      repoId: state.manifest.repoId,
      revision: state.roadmap.revision,
      planningRoot: state.planningRoot,
      card,
      ancestry: cardAncestry(state.roadmap, cardId),
    });
  }

  if (name === "planban_export_flat_v1") {
    const result = await exportFlatVersion1({ cwd: await cwdFromArgs(args), exportId: requireString(args.exportId, "exportId"), actor: "agent" });
    return textResult(`Created recoverable flat version-1 export ${result.exportId}.`, result);
  }

  if (name === "planban_reconstruct_hierarchy") {
    const groups = args.groups ?? args.programmes;
    if (!Array.isArray(groups)) throw new Error("groups must be an array.");
    const result = await reconstructHierarchy({
      cwd: await cwdFromArgs(args),
      groups: groups.map((entry, index) => {
        const mapping = requireObject(entry, `groups[${index}]`);
        const childIds = optionalStringArray(mapping.childIds, `groups[${index}].childIds`);
        if (!childIds) throw new Error(`groups[${index}].childIds is required.`);
        return { id: requireString(mapping.id, `groups[${index}].id`), childIds };
      }),
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"), actor: "agent",
    });
    return textResult(`Reconstructed ${groups.length} Group mappings.`, { ...summarizeBoard(result), cards: result.cards });
  }

  if (name === "planban_read_doc") {
    const cwd = await cwdFromArgs(args);
    const payload = await readDoc({
      cwd,
      cardId: requireString(args.cardId, "cardId"),
      kind: requireDocKind(args.kind),
    });
    return textResult(
      payload.exists ? `Read ${payload.kind} document for ${payload.cardId}.` : `No ${payload.kind} document exists for ${payload.cardId}.`,
      payload,
    );
  }

  if (name === "planban_create_card") {
    const metadata = optionalMetadata(args.metadata, "metadata");
    const state = await createCard({
      cwd: await cwdFromArgs(args),
      title: requireString(args.title, "title"),
      status: optionalStatus(args.status, "status"),
      summary: optionalString(args.summary, "summary"),
      nextAction: optionalString(args.nextAction, "nextAction"),
      tags: optionalStringArray(args.tags, "tags"),
      metadata: metadata === null ? undefined : metadata,
      specMarkdown: args.specMarkdown === undefined ? undefined : requireText(args.specMarkdown, "specMarkdown"),
      planMarkdown: args.planMarkdown === undefined ? undefined : requireText(args.planMarkdown, "planMarkdown"),
      position: optionalCreatePosition(args.position, "position"),
      afterId: optionalString(args.afterId, "afterId"),
      parentId: optionalString(args.parentId, "parentId"),
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"),
      actor: "agent",
    });
    return textResult(`Created Planban card ${state.createdCard.id}.`, {
      ...summarizeBoard(state),
      card: state.createdCard,
    });
  }

  if (name === "planban_create_cards") {
    const titles = optionalStringArray(args.titles, "titles");
    if (!titles?.length) throw new Error("titles must contain at least one title");
    const state = await createCards({
      cwd: await cwdFromArgs(args), titles,
      status: optionalStatus(args.status, "status"),
      parentId: optionalString(args.parentId, "parentId"),
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"), actor: "agent",
    });
    return textResult(`Created ${state.createdCards.length} Planban cards.`, { ...summarizeBoard(state), cards: state.createdCards });
  }

  if (name === "planban_create_group" || name === "planban_create_programme") {
    const itemIds = optionalStringArray(args.itemIds, "itemIds")
      ?? optionalStringArray(args.deliverableIds, "deliverableIds")
      ?? [];
    const state = await createGroup({
      cwd: await cwdFromArgs(args),
      title: requireString(args.title, "title"),
      summary: optionalString(args.summary, "summary"),
      nextAction: optionalString(args.nextAction, "nextAction"),
      status: optionalStatus(args.status, "status"),
      itemIds,
      anchorId: optionalString(args.anchorId, "anchorId"),
      specMarkdown: args.specMarkdown === undefined ? undefined : requireText(args.specMarkdown, "specMarkdown"),
      planMarkdown: args.planMarkdown === undefined ? undefined : requireText(args.planMarkdown, "planMarkdown"),
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"),
      actor: "agent",
    });
    return textResult(`Created Group ${state.createdGroup.id} with ${itemIds.length} Items.`, {
      ...summarizeBoard(state),
      group: state.createdGroup,
    });
  }

  if (name === "planban_move_card") {
    const status = optionalStatus(args.status, "status");
    const parentId = optionalNullableString(args.parentId, "parentId");
    const afterId = optionalNullableString(args.afterId, "afterId");
    if (status === undefined && parentId === undefined && afterId === undefined) {
      throw new Error("Provide status, parentId, or afterId.");
    }
    if (status === "complete" && !optionalBoolean(args.completionConfirmed, "completionConfirmed")) {
      throw new Error("completionConfirmed must be true when moving a card to complete.");
    }
    const state = await moveCard({
      cwd: await cwdFromArgs(args),
      cardId: requireString(args.cardId, "cardId"),
      status,
      parentId,
      afterId,
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"),
      actor: "agent",
    });
    const card = findCard(state, requireString(args.cardId, "cardId"));
    return textResult(`Moved Planban card ${card.id} to ${card.status}.`, {
      ...summarizeBoard(state),
      card,
    });
  }

  if (name === "planban_update_card") {
    const state = await updateCard({
      cwd: await cwdFromArgs(args),
      cardId: requireString(args.cardId, "cardId"),
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"),
      title: args.title === undefined ? undefined : requireString(args.title, "title"),
      summary: optionalNullableString(args.summary, "summary"),
      nextAction: optionalNullableString(args.nextAction, "nextAction"),
      tags: optionalStringArray(args.tags, "tags"),
      blockedBy: optionalNullableString(args.blockedBy, "blockedBy"),
      metadata: optionalMetadata(args.metadata, "metadata"),
      actor: "agent",
    });
    const card = findCard(state, requireString(args.cardId, "cardId"));
    return textResult(`Updated Planban card ${card.id}.`, {
      ...summarizeBoard(state),
      card,
    });
  }

  if (name === "planban_set_card_parent") {
    const cardId = requireString(args.cardId, "cardId");
    const parentId = args.parentId === null ? null : requireString(args.parentId, "parentId");
    const state = await setCardParent({
      cwd: await cwdFromArgs(args), cardId, parentId,
      baseRevision: optionalRevision(args.baseRevision, "baseRevision"), actor: "agent",
    });
    const card = findCard(state, cardId);
    return textResult(parentId ? `Moved ${card.id} into ${parentId}.` : `Moved ${card.id} to the main board.`, {
      ...summarizeBoard(state), card, ancestry: cardAncestry(state.roadmap, cardId),
    });
  }

  if (name === "planban_write_doc") {
    const cardId = requireString(args.cardId, "cardId");
    const kind = requireDocKind(args.kind);
    const payload = await writeDoc({
      cwd: await cwdFromArgs(args),
      cardId,
      kind,
      markdown: requireText(args.markdown, "markdown"),
      expectedMtimeMs: args.expectedMtimeMs === undefined ? undefined : optionalNumber(args.expectedMtimeMs, "expectedMtimeMs") ?? null,
      history: {
        actor: "agent",
        operation: "doc.write",
        summary: `Edited ${kind} document`,
        affectedCards: [cardId],
        affectedDocs: [{ cardId, kind, path: `items/${cardId}/${kind}.md` }],
      },
    });
    return textResult(`Wrote ${payload.kind} document for ${payload.cardId}.`, payload);
  }

  if (name === "planban_launch_board") {
    const launched = await launchBoard(args);
    return textResult(
      `Planban board URL: ${launched.url}\nInclude this exact clickable URL in the user-facing confirmation even if the in-app browser opened successfully.`,
      launched,
    );
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions:
        "Use Planban tools for structured local roadmap, card, and document operations. Before creating or materially editing owner-facing content, follow the installed Planban protocol and Planban house style. Complete is user-controlled: move cards to complete only when the user explicitly asks, confirms review/testing, or waives review.",
    });
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools });
    return;
  }

  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments ?? {});
      sendResult(id, result);
    } catch (error) {
      sendError(id, JsonRpcError.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (id !== undefined) {
    sendError(id, JsonRpcError.METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

function startMcpServer() {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  let requestQueue = Promise.resolve();

  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    requestQueue = requestQueue.then(() => handleRequest(message)).catch((error) => {
      if (message.id !== undefined) {
        sendError(message.id, JsonRpcError.INVALID_PARAMS, error instanceof Error ? error.message : String(error));
      }
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startMcpServer();
}
