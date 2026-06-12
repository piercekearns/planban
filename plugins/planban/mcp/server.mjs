import { spawn } from "node:child_process";
import readline from "node:readline";
import { existsSync, readFileSync } from "node:fs";
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
const demoModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/demo.ts")).href);
const versionModule = await import(pathToFileURL(resolve(PLANBAN_RUNTIME_ROOT, "src/core/version.ts")).href);

const { getStatus, loadState, moveCard, readDoc, updateCard, writeDoc } = storageModule;
const { archiveBoard, deleteBoard, listAllBoards, listBoards, resolveBoardCwd, restoreBoard } = registryModule;
const { PLANBAN_STATUSES } = typesModule;
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

async function boardUrl(baseUrl, status, cwd) {
  const targetRepoId = repoIdFromCwd(cwd);
  const statusRepoId = status.currentRepoId ?? status.repoId;
  if (targetRepoId && statusRepoId && targetRepoId !== statusRepoId) {
    const boards = await boardsFor(baseUrl).catch(() => null);
    const hasTargetBoard = Array.isArray(boards?.boards) && boards.boards.some((board) => board.repoId === targetRepoId);
    if (!hasTargetBoard) {
      throw new Error(
        `Planban is already running on ${baseUrl}, but it is not serving repo "${targetRepoId}". Use another port.`,
      );
    }
  }
  const repoId = targetRepoId ?? statusRepoId;
  return repoId ? `${baseUrl}/boards/${encodeURIComponent(repoId)}` : baseUrl;
}

async function launchBoard(args) {
  const cwd = optionalBoolean(args.demo, "demo") ? (await ensureDemoBoard()).cwd : await cwdFromArgs(args);
  const port = optionalNumber(args.port, "port") ?? 4317;
  if (!Number.isInteger(port) || port <= 0) throw new Error("port must be a positive integer.");
  const baseUrl = `http://localhost:${port}`;
  const existingStatus = await statusFor(baseUrl).catch(() => null);
  if (existingStatus) {
    return {
      cwd,
      port,
      started: false,
      url: await boardUrl(baseUrl, existingStatus, cwd),
    };
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
  return {
    cwd,
    port,
    started: true,
    url: await boardUrl(baseUrl, status, cwd),
  };
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
    inputSchema: schema.object({
      cwd: { type: "string", description: "Absolute repository path." },
    }, ["cwd"]),
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
    title: "Move Planban Card",
    description:
      "Move a card to another Planban status. Only use status complete when the user explicitly asks, confirms review/testing, or clearly waives user-side verification; set completionConfirmed true in that case.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      status: { type: "string", enum: [...PLANBAN_STATUSES], description: "Target status." },
      afterId: { type: "string", description: "Optional card id to insert after." },
      baseRevision: { type: "number", description: "Optional roadmap revision for stale-write protection." },
      completionConfirmed: {
        type: "boolean",
        description: "Required true when moving a card to complete.",
      },
    }, ["cardId", "status"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_update_card",
    title: "Update Planban Card",
    description: "Update non-status card fields such as summary, next action, tags, blocked-by, or metadata.",
    inputSchema: schema.object({
      ...commonBoardProperties,
      cardId: { type: "string", description: "Planban card id." },
      baseRevision: { type: "number", description: "Optional roadmap revision for stale-write protection." },
      summary: { type: ["string", "null"], description: "New card summary, or null to clear." },
      nextAction: { type: ["string", "null"], description: "New next action, or null to clear." },
      tags: { type: "array", items: { type: "string" }, description: "Replacement tag list." },
      blockedBy: { type: ["string", "null"], description: "Blocking card id or null." },
      metadata: { type: ["object", "null"], description: "Replacement metadata object or null to clear." },
    }, ["cardId"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "planban_write_doc",
    title: "Write Planban Document",
    description: "Write a card spec or plan document with optional stale-file protection.",
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
      "Start or discover the local Planban web app and return the board URL. Pass demo true to create/reuse the Planban Demo board. Use the Browser plugin/in-app browser to open the returned URL when the user wants the board visible.",
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
    const status = await getStatus(requireString(args.cwd, "cwd"));
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
    });
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

  if (name === "planban_move_card") {
    const status = requireStatus(args.status);
    if (status === "complete" && !optionalBoolean(args.completionConfirmed, "completionConfirmed")) {
      throw new Error("completionConfirmed must be true when moving a card to complete.");
    }
    const state = await moveCard({
      cwd: await cwdFromArgs(args),
      cardId: requireString(args.cardId, "cardId"),
      status,
      afterId: optionalString(args.afterId, "afterId"),
      baseRevision: optionalNumber(args.baseRevision, "baseRevision"),
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
      baseRevision: optionalNumber(args.baseRevision, "baseRevision"),
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
    return textResult(`Planban board URL: ${launched.url}`, launched);
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
        "Use Planban tools for structured local roadmap, card, and document operations. Complete is user-controlled: move cards to complete only when the user explicitly asks, confirms review/testing, or waives review.",
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
