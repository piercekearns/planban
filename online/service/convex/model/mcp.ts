// Remote Planban MCP over Streamable HTTP, served by a Convex HTTP action.
// Stateless and dual-era: modern clients (2026-07-28, per-request `_meta`)
// and legacy clients (an `initialize` handshake) are both served from the
// same endpoint. Tool names and arguments mirror the local Planban MCP
// server, with `boardId` in place of a local repository path. Every tool call
// goes through the same internal functions as the REST API, so the same
// access rules, base versions and idempotency apply.
import { ConvexError } from "convex/values";
import { PLANBAN_STATUSES, type PlanbanDocPayload, type PlanbanHistoryPayload, type PlanbanRoadmap } from "../../../../src/core/types";
import { cardAncestry } from "../../../../src/core/boardOperations";
import { queryWorkItems, type WorkItemQuery } from "../../../../src/core/workItemQuery";
import { internal } from "../_generated/api";
import { HOW_TO_REFER } from "../../../../src/core/contentRules";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { sha256Hex } from "./auth";
import type { ServiceErrorData } from "./errors";

const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SUPPORTED_VERSIONS = [MODERN_VERSION, ...LEGACY_VERSIONS];
const SERVER_INFO = { name: "Planban Online", version: "0.2.0" };
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

const INSTRUCTIONS = [
  "These tools read and edit Planban Online Boards shared across devices and people.",
  "Call planban_list_boards first to find the boardId.",
  "Every edit must pass baseRevision, the board revision you last read; document edits pass expectedMtimeMs from planban_read_doc (null for a new document). On a conflict, reread and retry.",
  "Pass a fresh idempotencyKey with each edit and reuse it if you retry the same edit, so it is never applied twice.",
  "Serialize writes: one mutation at a time per board.",
  "Complete is person-controlled: move a card to complete only when a person on the board explicitly asks, and set completionConfirmed true. What you may do also depends on what that person lets their agents do.",
  "Deleting cards and taking a board back to Local Mode are not available to agents.",
  `Planban is an index, not storage: boards hold text only (cards, Specs, Plans and history). Never put files, images or encoded data in a card or document. ${HOW_TO_REFER} Edits that embed files are refused.`,
].join(" ");

type JsonSchema = Record<string, unknown>;

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

const statusEnum = { type: "string", enum: [...PLANBAN_STATUSES] };
const boardId = { type: "string", description: "Online Board id from planban_list_boards." };
const baseRevision = { type: "number", description: "Board revision you last read. Required: an edit based on an older revision is refused." };
const idempotencyKey = { type: "string", description: "A fresh random id for this edit (8 to 100 letters, digits, dashes or underscores). Reuse it only to retry the same edit." };
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function object(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export const TOOLS: ToolDefinition[] = [
  {
    name: "planban_list_boards",
    title: "List Planban Online Boards",
    description: "List the Online Boards this connection can reach.",
    inputSchema: object({}),
    annotations: read,
  },
  {
    name: "planban_get_board",
    title: "Get Planban Board",
    description: "Load one Online Board, including its revision and every Work Item.",
    inputSchema: object({ boardId }, ["boardId"]),
    annotations: read,
  },
  {
    name: "planban_query_cards",
    title: "Query Planban Work Items",
    description: "Search and filter Work Items without changing the board.",
    inputSchema: object({
      boardId,
      search: { type: "string", description: "Search id, title, summary, next action, and tags." },
      projection: { type: "string", enum: ["main", "group", "flattened"] },
      groupId: { type: "string" },
      hierarchyScope: { type: "string", enum: ["projection", "root", "owned", "leaf", "selected-group"] },
      groupRole: { type: "string", enum: ["any", "group", "item-only"] },
      statuses: { type: "array", items: statusEnum },
      blocked: { type: "string", enum: ["any", "blocked", "unblocked"] },
      tags: { type: "array", items: { type: "string" } },
    }, ["boardId"]),
    annotations: read,
  },
  {
    name: "planban_get_card",
    title: "Get Planban Card",
    description: "Read one Work Item with its Group ancestry.",
    inputSchema: object({ boardId, cardId: { type: "string" } }, ["boardId", "cardId"]),
    annotations: read,
  },
  {
    name: "planban_read_doc",
    title: "Read Planban Document",
    description: "Read a card's Spec or Plan.",
    inputSchema: object({ boardId, cardId: { type: "string" }, kind: { type: "string", enum: ["spec", "plan"] } }, ["boardId", "cardId", "kind"]),
    annotations: read,
  },
  {
    name: "planban_history",
    title: "Planban Board History",
    description: "List recent changes to a board, with who made each one and from which app.",
    inputSchema: object({ boardId, limit: { type: "number", description: "Most recent entries to return. Defaults to 20." } }, ["boardId"]),
    annotations: read,
  },
  {
    name: "planban_create_card",
    title: "Create Planban Card",
    description: "Create a Work Item with optional placement, tags, metadata, and initial Spec or Plan markdown. Follow the Planban house style for owner-facing text. Text only: refer to files by link or labelled local path, never embed them.",
    inputSchema: object({
      boardId,
      title: { type: "string" },
      status: statusEnum,
      summary: { type: "string" },
      nextAction: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      metadata: { type: ["object", "null"] },
      specMarkdown: { type: "string" },
      planMarkdown: { type: "string" },
      position: { type: "string", enum: ["top", "bottom"] },
      afterId: { type: "string" },
      parentId: { type: "string", description: "Existing Group id; creates an owned Item." },
      baseRevision,
      idempotencyKey,
      completionConfirmed: { type: "boolean", description: "Required true when this would put a card in complete. Only when the owner explicitly asks." },
    }, ["boardId", "title", "baseRevision"]),
    annotations: write,
  },
  {
    name: "planban_create_cards",
    title: "Create Multiple Planban Cards",
    description: "Atomically create sibling Work Item skeletons, optionally inside a Group.",
    inputSchema: object({
      boardId,
      titles: { type: "array", items: { type: "string" } },
      status: statusEnum,
      parentId: { type: "string" },
      baseRevision,
      idempotencyKey,
      completionConfirmed: { type: "boolean", description: "Required true when this would put a card in complete. Only when the owner explicitly asks." },
    }, ["boardId", "titles", "baseRevision"]),
    annotations: write,
  },
  {
    name: "planban_create_group",
    title: "Create Planban Group",
    description: "Create a Group and place existing root Items inside it.",
    inputSchema: object({
      boardId,
      title: { type: "string" },
      summary: { type: "string" },
      nextAction: { type: "string" },
      status: statusEnum,
      itemIds: { type: "array", items: { type: "string" } },
      anchorId: { type: "string" },
      specMarkdown: { type: "string" },
      planMarkdown: { type: "string" },
      baseRevision,
      idempotencyKey,
      completionConfirmed: { type: "boolean", description: "Required true when this would put a card in complete. Only when the owner explicitly asks." },
    }, ["boardId", "title", "baseRevision"]),
    annotations: write,
  },
  {
    name: "planban_update_card",
    title: "Update Planban Card",
    description: "Update non-status card fields such as title, summary, next action, tags, blocked-by, or metadata. Text only: refer to files by link or labelled local path, never embed them.",
    inputSchema: object({
      boardId,
      cardId: { type: "string" },
      title: { type: "string" },
      summary: { type: ["string", "null"] },
      nextAction: { type: ["string", "null"] },
      tags: { type: "array", items: { type: "string" } },
      blockedBy: { type: ["string", "null"] },
      metadata: { type: ["object", "null"] },
      baseRevision,
      idempotencyKey,
    }, ["boardId", "cardId", "baseRevision"]),
    annotations: write,
  },
  {
    name: "planban_move_card",
    title: "Place Planban Card",
    description: "Change an Item's status, Group, and/or sibling rank in one mutation. Use null afterId for first position. Only use status complete when the owner explicitly asks; set completionConfirmed true.",
    inputSchema: object({
      boardId,
      cardId: { type: "string" },
      status: statusEnum,
      parentId: { type: ["string", "null"] },
      afterId: { type: ["string", "null"] },
      completionConfirmed: { type: "boolean" },
      baseRevision,
      idempotencyKey,
    }, ["boardId", "cardId", "baseRevision"]),
    annotations: write,
  },
  {
    name: "planban_write_doc",
    title: "Write Planban Document",
    description: "Write a card's Spec or Plan. Pass expectedMtimeMs from planban_read_doc so someone else's edit is never overwritten. Text only, up to 1 MB: refer to images and other files by GitHub link, web address or a local path labelled with its machine; embedded images and encoded data are refused.",
    inputSchema: object({
      boardId,
      cardId: { type: "string" },
      kind: { type: "string", enum: ["spec", "plan"] },
      markdown: { type: "string" },
      expectedMtimeMs: { type: ["number", "null"], description: "From planban_read_doc; null for a new document. Required." },
      idempotencyKey,
    }, ["boardId", "cardId", "kind", "markdown", "expectedMtimeMs"]),
    annotations: write,
  },
  // ChatGPT's company-knowledge and deep-research surfaces look for these two read-only tools.
  {
    name: "search",
    title: "Search Planban",
    description: "Search Work Items across every Online Board this connection can reach.",
    inputSchema: object({ query: { type: "string" } }, ["query"]),
    annotations: read,
  },
  {
    name: "fetch",
    title: "Fetch Planban Work Item",
    description: "Fetch one Work Item and its Spec by the id returned from search.",
    inputSchema: object({ id: { type: "string" } }, ["id"]),
    annotations: read,
  },
];

class ToolError extends Error {}

/** The board operations a tool call may use, bound to the caller's connection. */
export class McpService {
  constructor(private ctx: ActionCtx, private connectionId: Id<"connections">) {}

  private async call<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      const data = error.data as ServiceErrorData;
      const revision = data.currentRevision !== undefined ? ` Current revision: ${data.currentRevision}.` : "";
      throw new ToolError(`${data.code}: ${data.message}${revision}`);
    }
  }

  listBoards() {
    return this.call(() => this.ctx.runQuery(internal.boards.listBoards, { connectionId: this.connectionId }));
  }

  async getBoard(boardId: string): Promise<PlanbanRoadmap> {
    const board = await this.call(() => this.ctx.runQuery(internal.boards.getBoard, { connectionId: this.connectionId, boardId }));
    return (board as { roadmap: PlanbanRoadmap }).roadmap;
  }

  readDoc(boardId: string, cardId: string, kind: "spec" | "plan"): Promise<PlanbanDocPayload> {
    return this.call(() => this.ctx.runQuery(internal.boards.readDoc, { connectionId: this.connectionId, boardId, cardId, kind }));
  }


  history(boardId: string): Promise<PlanbanHistoryPayload> {
    return this.call(() => this.ctx.runQuery(internal.boards.history, { connectionId: this.connectionId, boardId }));
  }

  async run(boardId: string, op: string, input: Record<string, unknown>, completionConfirmed: boolean, idempotencyKey?: string) {
    const requestHash = idempotencyKey ? await sha256Hex(`${boardId}\n${op}\n${JSON.stringify(input)}\n${completionConfirmed}`) : undefined;
    return this.call(() => this.ctx.runMutation(internal.boards.run, {
      connectionId: this.connectionId, boardId, op, input, completionConfirmed,
      ...(idempotencyKey ? { idempotencyKey, requestHash } : {}),
    })) as Promise<{ roadmap: PlanbanRoadmap; result: unknown; replayed?: boolean; originalRevision?: number }>;
  }
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new ToolError(`${key} is required.`);
  return value;
}

function compactBoard(roadmap: PlanbanRoadmap) {
  return {
    boardId: roadmap.project.id,
    title: roadmap.project.title,
    revision: roadmap.revision,
    updatedAt: roadmap.updatedAt,
    cards: roadmap.roadmapItems,
  };
}

function cardUrl(origin: string, boardId: string, cardId: string) {
  return `${origin}/boards/${encodeURIComponent(boardId)}#${encodeURIComponent(cardId)}`;
}

function operationInput(args: Record<string, unknown>) {
  const { boardId: _boardId, completionConfirmed: _confirmed, idempotencyKey: _key, ...input } = args;
  return { ...input, actor: "agent" };
}

async function callTool(service: McpService, origin: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "planban_list_boards":
      return { boards: await service.listBoards() };
    case "planban_get_board":
      return compactBoard(await service.getBoard(stringArg(args, "boardId")));
    case "planban_query_cards": {
      const { boardId: _id, ...query } = args;
      const roadmap = await service.getBoard(stringArg(args, "boardId"));
      return { revision: roadmap.revision, results: queryWorkItems(roadmap.roadmapItems, query as WorkItemQuery) };
    }
    case "planban_get_card": {
      const roadmap = await service.getBoard(stringArg(args, "boardId"));
      const cardId = stringArg(args, "cardId");
      const card = roadmap.roadmapItems.find((item) => item.id === cardId);
      if (!card) throw new ToolError(`not_found: Card not found: ${cardId}`);
      return { revision: roadmap.revision, card, ancestry: cardAncestry(roadmap, cardId) };
    }
    case "planban_read_doc":
      return await service.readDoc(stringArg(args, "boardId"), stringArg(args, "cardId"), args.kind === "plan" ? "plan" : "spec");
    case "planban_history": {
      const history = await service.history(stringArg(args, "boardId"));
      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 200) : 20;
      return { currentVersion: history.currentVersion, entries: history.entries.slice(0, limit) };
    }
    case "planban_move_card":
    case "planban_create_card":
    case "planban_create_cards":
    case "planban_create_group":
    case "planban_update_card":
    case "planban_write_doc": {
      const op = {
        planban_create_card: "createCard",
        planban_create_cards: "createCards",
        planban_create_group: "createGroup",
        planban_update_card: "updateCard",
        planban_move_card: "moveCard",
        planban_write_doc: "writeDoc",
      }[name]!;
      // Any tool whose effect completes a card needs explicit confirmation; the
      // board judges the effect, including status inherited by a new Group.
      const key = typeof args.idempotencyKey === "string" ? args.idempotencyKey : undefined;
      const outcome = await service.run(stringArg(args, "boardId"), op, operationInput(args), args.completionConfirmed === true, key);
      // A retried edit says so, and which revision it originally produced.
      return {
        revision: outcome.roadmap.revision, ...(outcome.result as Record<string, unknown>),
        ...(outcome.replayed ? { replayed: true, ...(outcome.originalRevision === undefined ? {} : { originalRevision: outcome.originalRevision }) } : {}),
      };
    }
    case "search": {
      const query = stringArg(args, "query");
      const results: Array<{ id: string; title: string; url: string }> = [];
      for (const board of await service.listBoards()) {
        const roadmap = await service.getBoard(board.boardId);
        const matches = queryWorkItems(roadmap.roadmapItems, { search: query, projection: "flattened" }).matches.slice(0, 10);
        for (const { item } of matches) {
          results.push({ id: `${board.boardId}/${item.id}`, title: `${item.title} (${board.title})`, url: cardUrl(origin, board.boardId, item.id) });
        }
      }
      return { results };
    }
    case "fetch": {
      const [id, cardId] = stringArg(args, "id").split("/");
      if (!id || !cardId) throw new ToolError("validation: id must look like board/card.");
      const roadmap = await service.getBoard(id);
      const card = roadmap.roadmapItems.find((item) => item.id === cardId);
      if (!card) throw new ToolError(`not_found: Card not found: ${cardId}`);
      const spec = await service.readDoc(id, cardId, "spec");
      const text = [
        `# ${card.title}`,
        `Status: ${card.status}`,
        card.summary ? `Summary: ${card.summary}` : null,
        card.nextAction ? `Next action: ${card.nextAction}` : null,
        "",
        spec.markdown,
      ].filter((line) => line !== null).join("\n");
      return { id: `${id}/${cardId}`, title: card.title, text, url: cardUrl(origin, id, cardId), metadata: { boardId: id, status: card.status } };
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: JsonRpcRequest["id"], result: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    result: { resultType: "complete", ...result, _meta: { [META_SERVER_INFO]: SERVER_INFO } },
  };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

const CAPABILITIES = { tools: { listChanged: false } };

async function handleMessage(message: JsonRpcRequest, service: McpService, origin: string, headerVersion: string | null) {
  const meta = (message.params?._meta ?? {}) as Record<string, unknown>;
  const requested = (meta[META_VERSION] as string | undefined) ?? headerVersion ?? undefined;
  if (message.method !== "initialize" && requested && !SUPPORTED_VERSIONS.includes(requested)) {
    return rpcError(message.id, -32022, "Unsupported protocol version", { supported: SUPPORTED_VERSIONS, requested });
  }

  switch (message.method) {
    case "initialize": {
      const asked = String(message.params?.protocolVersion ?? "");
      const protocolVersion = LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0];
      return rpcResult(message.id, { protocolVersion, capabilities: CAPABILITIES, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    }
    case "server/discover":
      return rpcResult(message.id, {
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: CAPABILITIES,
        instructions: INSTRUCTIONS,
        ttlMs: 3_600_000,
        cacheScope: "public",
      });
    case "ping":
      return rpcResult(message.id, {});
    case "tools/list":
      return rpcResult(message.id, { tools: TOOLS, ttlMs: 3_600_000, cacheScope: "public" });
    case "tools/call": {
      const name = String(message.params?.name ?? "");
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const structured = await callTool(service, origin, name, args);
        return rpcResult(message.id, {
          content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
          isError: false,
        });
      } catch (error) {
        if (!(error instanceof ToolError)) throw error;
        return rpcResult(message.id, { content: [{ type: "text", text: error.message }], isError: true });
      }
    }
    default:
      return rpcError(message.id, -32601, `Method not found: ${message.method}`);
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export async function handleMcp(request: Request, service: McpService, origin: string): Promise<Response> {
  if (request.method !== "POST") {
    // Modern clients never GET; legacy clients may try to open a stream. This server sends none.
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error"), 400);
  }
  const headerVersion = request.headers.get("MCP-Protocol-Version");
  const messages = Array.isArray(payload) ? payload as JsonRpcRequest[] : [payload as JsonRpcRequest];
  const responses = [];
  for (const message of messages) {
    if (!message || typeof message.method !== "string") {
      responses.push(rpcError(null, -32600, "Invalid request"));
      continue;
    }
    if (message.id === undefined || message.id === null) continue; // notifications need no reply
    responses.push(await handleMessage(message, service, origin, headerVersion));
  }
  if (responses.length === 0) return new Response(null, { status: 202 });
  return jsonResponse(Array.isArray(payload) ? responses : responses[0]);
}
