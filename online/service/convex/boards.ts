// The Online Board authority. Every change runs the shared planning rules from
// src/core/boardOperations.ts inside one Convex mutation, so the revision
// check, roadmap, documents and history version commit together or not at all.
import { v } from "convex/values";
import {
  assertBaseRevision,
  assertCommittable,
  committedRoadmap,
  planCreateCard,
  planCreateCards,
  planCreateGroup,
  planDeleteArchivedCard,
  planMoveCard,
  planReorderCards,
  planUpdateCard,
  planWriteDoc,
  normalizeColumnPriorities,
  type PlannedChange,
} from "../../../src/core/boardOperations";
import type { PlanbanHistoryEntry, PlanbanHistoryPayload, PlanbanRoadmap } from "../../../src/core/types";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { boardAccess, liveConnection, reaches } from "./model/access";
import { packJson, packText, unpackJson, unpackText } from "./model/codec";
import { asServiceError, fail } from "./model/errors";
import { checkCards, checkDocuments } from "./model/indexRules";
import { addStored, chargeWrite, sizeOf } from "./model/limits";
import { historyEntries, historyPage, recordHistory, roadmapAtVersion, type Attribution, type BoardRows } from "./model/history";
import { DOC_KINDS, currentRoadmap, docPayload, docRow, live, retiredIds, stateRow, type DocKind } from "./model/rows";
import { reserveRetiredId } from "./model/retired";

export const BOARD_OPERATIONS = [
  "createCard", "createCards", "createGroup", "updateCard", "moveCard",
  "setCardParent", "reorderCards", "deleteArchivedCard", "writeDoc",
  "restoreBoard", "restoreCard", "restoreDoc",
] as const;
export type BoardOperation = (typeof BOARD_OPERATIONS)[number];

export interface BoardBundle {
  format: "planban-board-bundle";
  version: 1;
  roadmap: PlanbanRoadmap;
  docs: Array<{ cardId: string; kind: DocKind; markdown: string }>;
  history: Array<{ entry: PlanbanHistoryEntry; roadmap: PlanbanRoadmap }>;
  historyDocs?: Array<{ version: number; cardId: string; kind: DocKind; markdown: string }>;
  retiredIds?: string[];
  retention?: unknown;
}

// ---- helpers ------------------------------------------------------------

export function attributionFor(connection: Doc<"connections">, actor: unknown): Attribution {
  return { userId: connection.userId, clientName: connection.clientName, actor: connection.canAdminister && actor === "user" ? "user" : "agent", connectionId: connection._id };
}

/** Writes the roadmap, documents and one history version. Runs inside the caller's mutation. */
async function commit(ctx: MutationCtx, board: Doc<"boards">, previous: PlanbanRoadmap, change: PlannedChange, attribution: Attribution, now: string) {
  assertCommittable(change.roadmap);
  // Planban is an index, not storage (owner decision 18).
  checkCards(change.roadmap, previous);
  checkDocuments(change.docWrites);
  const at = live(board);
  const committed = committedRoadmap(change.roadmap, now);
  // Daily limits for the account, and the board's own size limit (model/limits.ts).
  const before = new Map(previous.roadmapItems.map((item) => [item.id, JSON.stringify(item)]));
  const written = committed.roadmapItems.reduce((sum, item) => sum + (before.get(item.id) === JSON.stringify(item) ? 0 : sizeOf(item)), 0)
    + change.docWrites.reduce((sum, doc) => sum + sizeOf(doc.markdown), 0);
  await chargeWrite(ctx, attribution.userId, written);
  const state = await stateRow(ctx, at);
  const packedRoadmap = packJson(committed);
  await ctx.db.patch(state._id, { roadmap: packedRoadmap });
  await addStored(ctx, at, sizeOf(packedRoadmap) - sizeOf(state.roadmap));
  const remaining = new Set(committed.roadmapItems.map((item) => item.id));
  for (const item of previous.roadmapItems) {
    if (remaining.has(item.id)) continue;
    // Deleted ids are never reused, so history keeps one meaning per id.
    await reserveRetiredId(ctx, at, item.id);
    for (const kind of ["spec", "plan"] as const) {
      const row = await docRow(ctx, at, item.id, kind);
      if (row) {
        await ctx.db.delete(row._id);
        await addStored(ctx, at, -sizeOf(row.markdown));
      }
    }
  }
  for (const doc of change.docWrites) {
    const row = await docRow(ctx, at, doc.cardId, doc.kind);
    const stamp = Math.max(Date.now(), (row?.stamp ?? 0) + 1);
    const fields = { markdown: packText(doc.markdown), stamp, updatedAt: now, updatedBy: attribution.userId };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("docs", { ...at, cardId: doc.cardId, kind: doc.kind, ...fields });
    await addStored(ctx, at, sizeOf(fields.markdown) - (row ? sizeOf(row.markdown) : 0));
  }
  const listed = change.history.affectedDocs ?? [];
  const affectedDocs = [
    ...listed,
    ...change.docWrites
      .filter((doc) => !listed.some((ref) => ref.cardId === doc.cardId && ref.kind === doc.kind))
      .map((doc) => ({ cardId: doc.cardId, kind: doc.kind, path: doc.path })),
  ];
  await ctx.db.patch(board._id, { revision: committed.revision, updatedAt: now });
  const version = await recordHistory(ctx, {
    board: { ...board, revision: committed.revision },
    previous,
    committed,
    history: { ...change.history, affectedDocs },
    docs: change.docWrites.map(({ cardId, kind, markdown }) => ({ cardId, kind, markdown })),
    attribution,
    now,
  });
  return { committed, version };
}

/**
 * Completing and deleting cards stay with the owner. Judged on the operation's
 * effect (current versus candidate roadmap), so every route is covered.
 */
function checkOwnerControlled(before: PlanbanRoadmap, after: PlanbanRoadmap, access: { canAdminister: boolean; canComplete: boolean }, completionConfirmed?: boolean) {
  const previous = new Map(before.roadmapItems.map((item) => [item.id, item]));
  const remaining = new Set(after.roadmapItems.map((item) => item.id));
  const completes = after.roadmapItems.some((item) => item.status === "complete" && previous.get(item.id)?.status !== "complete");
  const deletes = before.roadmapItems.some((item) => !remaining.has(item.id));
  if (deletes && !access.canAdminister) fail("forbidden", "Deleting a card is kept for the board owner's own connection. Ask the owner to do it.");
  if (completes && !access.canComplete) fail("forbidden", "This connection may not mark cards complete on this board. Ask someone who can, or change what your agents may do.");
  if (completes && completionConfirmed === false) {
    fail("validation", "completionConfirmed must be true when this would move a card to complete. Only do this when the owner explicitly asks.");
  }
}

/** Every hosted edit states the revision it was based on (owner decision 10). */
function requireBaseRevision(current: PlanbanRoadmap, input: Record<string, unknown>) {
  if (typeof input.baseRevision !== "number" || !Number.isInteger(input.baseRevision)) {
    fail("validation", `Online Board edits must state the board revision they were based on (baseRevision). The current revision is ${current.revision}; reread the board before editing.`, { currentRevision: current.revision });
  }
  assertBaseRevision(current, input.baseRevision as number);
}

// ---- reads --------------------------------------------------------------

export const me = internalQuery({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await liveConnection(ctx, connectionId);
    return {
      userId: connection.userId,
      connectionId: connection._id,
      kind: connection.kind,
      name: connection.name,
      clientName: connection.clientName,
      boards: connection.boards,
      level: connection.level,
      canAdminister: connection.canAdminister,
    };
  },
});

export const listBoards = internalQuery({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await liveConnection(ctx, connectionId);
    const memberships = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", connection.userId)).collect();
    const boards = [];
    for (const member of memberships) {
      if (!reaches(connection, member.boardId)) continue;
      const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", member.boardId)).unique();
      if (board && board.authority !== "importing") {
        boards.push({ boardId: board.boardId, title: board.title, role: member.role, authority: board.authority, revision: board.revision });
      }
    }
    return boards;
  },
});

/** One current snapshot for permission-dependent MCP discovery, never cached. */
export const mcpPermissions = internalQuery({
  args: { connectionId: v.id("connections") },
  handler: async (ctx, { connectionId }) => {
    const connection = await liveConnection(ctx, connectionId);
    const memberships = await ctx.db.query("members").withIndex("by_user", (q) => q.eq("userId", connection.userId)).collect();
    const permissions = [];
    for (const member of memberships) {
      if (!reaches(connection, member.boardId)) continue;
      const board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", member.boardId)).unique();
      if (!board || board.authority === "importing") continue;
      const access = await boardAccess(ctx, connectionId, member.boardId);
      permissions.push({ boardId: board.boardId, level: access.level,
        canWrite: board.authority === "online" && access.canWrite,
        canComplete: board.authority === "online" && access.canComplete });
    }
    return permissions;
  },
});

async function readableBoard(ctx: Parameters<typeof boardAccess>[0], connectionId: Parameters<typeof boardAccess>[1], boardId: string) {
  const access = await boardAccess(ctx, connectionId, boardId);
  if (access.board.authority === "importing") fail("not_found", `Online Board not found: ${boardId}`);
  return access;
}

/** The board. With `since` equal to the current revision, returns only the revision: no roadmap is read. */
export const getBoard = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), since: v.optional(v.number()) },
  handler: async (ctx, { connectionId, boardId, since }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    if (since !== undefined && since === board.revision) return { unchanged: true as const, revision: board.revision, authority: board.authority };
    return { roadmap: await currentRoadmap(ctx, live(board)), authority: board.authority };
  },
});

/** A single small row: what live updates subscribe to. */
export const revision = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    return { revision: board.revision, authority: board.authority };
  },
});

export const readDoc = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), cardId: v.string(), kind: v.union(v.literal("spec"), v.literal("plan")) },
  handler: async (ctx, { connectionId, boardId, cardId, kind }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    const roadmap = await currentRoadmap(ctx, live(board));
    const item = roadmap.roadmapItems.find((entry) => entry.id === cardId);
    if (!item) fail("not_found", `Card not found: ${cardId}`);
    return docPayload(await docRow(ctx, live(board), cardId, kind), cardId, kind, (kind === "spec" ? item!.specDoc : item!.planDoc) ?? null);
  },
});

export const history = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), after: v.optional(v.number()) },
  handler: async (ctx, { connectionId, boardId, after }): Promise<PlanbanHistoryPayload> => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    const entries = await historyEntries(ctx, live(board), after ?? 0);
    return {
      currentVersion: board.historyVersion,
      retention: { boardVersions: 1000, cardVersions: 1000, documentVersions: 1000, hourlyDays: 0, maxAgeDays: 0 },
      entries,
    } as PlanbanHistoryPayload;
  },
});

/**
 * A restored card keeps a reference to every document it still has: restoring
 * card details never drops a document, so the roadmap and stored documents
 * stay consistent for export and Take Local.
 */
async function keepLiveDocRefs(ctx: MutationCtx, at: BoardRows, current: PlanbanRoadmap, items: PlanbanRoadmap["roadmapItems"]) {
  const now = new Map(current.roadmapItems.map((item) => [item.id, item]));
  const out = [];
  for (const item of items) {
    let next = item;
    for (const [kind, field] of [["spec", "specDoc"], ["plan", "planDoc"]] as const) {
      if (next[field] || !(await docRow(ctx, at, item.id, kind))) continue;
      next = { ...next, [field]: now.get(item.id)?.[field] ?? `items/${item.id}/${kind}.md` };
    }
    out.push(next);
  }
  return out;
}

function historyVersionArg(input: Record<string, unknown>): number {
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) fail("validation", "version must be a history version number.");
  return version;
}

/** A document as it stood at a history version: its latest recorded body at or before it. */
async function historyDocAt(ctx: Parameters<typeof currentRoadmap>[0], at: BoardRows, version: number, cardId: string, kind: DocKind) {
  const row = await ctx.db.query("historyDocs").withIndex("by_board_doc_version", (q) =>
    q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", cardId).eq("kind", kind).lte("version", version)).order("desc").first();
  return row ? unpackText(row.markdown) : null;
}

/** The board as it stood at a history version, for reading. */
export const historyVersion = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), version: v.number() },
  handler: async (ctx, { connectionId, boardId, version }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    const roadmap = await roadmapAtVersion(ctx, live(board), version);
    if (!roadmap) fail("not_found", `History version not found: v${version}`);
    return { roadmap };
  },
});

export const historyDoc = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), version: v.number(), cardId: v.string(), kind: v.union(v.literal("spec"), v.literal("plan")) },
  handler: async (ctx, { connectionId, boardId, version, cardId, kind }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    const markdown = await historyDocAt(ctx, live(board), version, cardId, kind);
    return { cardId, kind, path: null, exists: markdown !== null, markdown: markdown ?? "", mtimeMs: null };
  },
});

async function allDocs(ctx: Parameters<typeof currentRoadmap>[0], at: BoardRows, roadmap: PlanbanRoadmap) {
  const docs: BoardBundle["docs"] = [];
  for (const item of roadmap.roadmapItems) {
    for (const kind of ["spec", "plan"] as const) {
      const row = await docRow(ctx, at, item.id, kind);
      if (row) docs.push({ cardId: item.id, kind, markdown: unpackText(row.markdown) });
    }
  }
  return docs;
}

/** The whole board as one bundle. Large boards use the paged export below. */
export const exportBoard = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }): Promise<BoardBundle> => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    const at = live(board);
    const roadmap = await currentRoadmap(ctx, at);
    const history = await historyPage(ctx, at, 0, 100_000);
    const historyDocs: NonNullable<BoardBundle["historyDocs"]> = [];
    for await (const row of ctx.db.query("historyDocs").withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", board.generation))) {
      historyDocs.push({ version: row.version, cardId: row.cardId, kind: row.kind, markdown: unpackText(row.markdown) });
    }
    return {
      format: "planban-board-bundle", version: 1, roadmap, docs: await allDocs(ctx, at, roadmap), history, historyDocs,
      retiredIds: [...await retiredIds(ctx, at)],
      ...(board.retention === undefined ? {} : { retention: board.retention }),
    };
  },
});

/** Paged export, first page: the roadmap, retention, retired ids and the list of history versions. */
export const exportMeta = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), transferId: v.optional(v.string()) },
  handler: async (ctx, { connectionId, boardId, transferId }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    requireLocalTransfer(board, transferId);
    const at = live(board);
    const versions: number[] = [];
    for await (const row of ctx.db.query("history").withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", board.generation))) versions.push(row.version);
    return {
      format: "planban-board-bundle" as const, version: 1 as const, authority: board.authority,
      roadmap: await currentRoadmap(ctx, at), retiredIds: [...await retiredIds(ctx, at)], historyVersions: versions,
      ...(board.retention === undefined ? {} : { retention: board.retention }),
      ...(board.uid ? { uid: board.uid } : {}),
    };
  },
});

/**
 * Pages stay well under Convex's 16 MiB limit on a function's result: a page
 * stops once it holds PAGE_BYTES of content, and always holds at least one
 * item so a single large one still gets through.
 */
const PAGE_BYTES = 6 * 1024 * 1024;

/** Paged export: current documents, a page of cards at a time. */
export const exportDocs = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), offset: v.number(), limit: v.number(), transferId: v.optional(v.string()), revision: v.optional(v.number()) },
  handler: async (ctx, { connectionId, boardId, offset, limit, transferId, revision }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    requireLocalTransfer(board, transferId);
    // Pages are positions in the roadmap, so all pages must come from one revision.
    if (revision !== undefined && revision !== board.revision) fail("conflict", "The board changed while it was being read. Start again.", { currentRevision: board.revision });
    const at = live(board);
    const roadmap = await currentRoadmap(ctx, at);
    const docs: BoardBundle["docs"] = [];
    let index = offset;
    let bytes = 0;
    const end = Math.min(roadmap.roadmapItems.length, offset + Math.min(Math.max(limit, 1), 200));
    for (; index < end && (bytes < PAGE_BYTES || index === offset); index += 1) {
      const item = roadmap.roadmapItems[index]!;
      for (const kind of ["spec", "plan"] as const) {
        const row = await docRow(ctx, at, item.id, kind);
        if (!row) continue;
        const markdown = unpackText(row.markdown);
        bytes += markdown.length;
        docs.push({ cardId: item.id, kind, markdown });
      }
    }
    return { docs, nextOffset: index < roadmap.roadmapItems.length ? index : null };
  },
});

/** Paged export: history versions after `after`, each with its roadmap and document bodies. */
export const exportHistory = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), after: v.number(), limit: v.number(), transferId: v.optional(v.string()) },
  handler: async (ctx, { connectionId, boardId, after, limit, transferId }) => {
    const { board } = await readableBoard(ctx, connectionId, boardId);
    requireLocalTransfer(board, transferId);
    const at = live(board);
    const candidates = await historyPage(ctx, at, after, Math.min(Math.max(limit, 1), 20));
    const history: typeof candidates = [];
    const historyDocs: NonNullable<BoardBundle["historyDocs"]> = [];
    let bytes = 0;
    for (const version of candidates) {
      const docs = [];
      let size = JSON.stringify(version.roadmap).length;
      for (const row of await ctx.db.query("historyDocs").withIndex("by_board_version", (q) => q.eq("boardId", boardId).eq("generation", board.generation).eq("version", version.entry.version)).collect()) {
        const markdown = unpackText(row.markdown);
        size += markdown.length;
        docs.push({ version: row.version, cardId: row.cardId, kind: row.kind, markdown });
      }
      if (history.length > 0 && bytes + size > PAGE_BYTES) break;
      history.push(version);
      historyDocs.push(...docs);
      bytes += size;
    }
    return { history, historyDocs };
  },
});

// ---- writes -------------------------------------------------------------

/** Take Local downloads stay frozen to one generation; anything else is a conflict. */
function requireLocalTransfer(board: Doc<"boards">, transferId: string | undefined) {
  if (transferId === undefined) return;
  if (board.localTransfer?.transferId !== transferId || board.localTransfer.generation !== board.generation) {
    fail("conflict", "This board changed since this Take Local started. Run Take Local again.");
  }
}

/**
 * Take Local, first step: freeze the board for one transfer. Retrying with
 * the same transfer id is safe; a different transfer, or a board that has
 * changed generation since, is refused, so a retry can never freeze a
 * board someone else has since taken online again.
 */
export const fence = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), transferId: v.string(), expectedGeneration: v.optional(v.number()), acknowledgedOthers: v.optional(v.array(v.string())) },
  handler: async (ctx, { connectionId, boardId, transferId, expectedGeneration, acknowledgedOthers }) => {
    const access = await readableBoard(ctx, connectionId, boardId);
    if (!access.canAdminister) fail("forbidden", "Moving a board between Online and Local Mode is kept for the board owner's own connection.");
    const board = access.board;
    if (board.localTransfer?.transferId === transferId) {
      // Resuming. If the freeze lapsed and someone has started taking the
      // board online again since, this Take Local has been superseded;
      // otherwise the freeze is renewed.
      const successor = await ctx.db.query("transfers").withIndex("by_board_state", (q) => q.eq("boardId", boardId).eq("state", "open")).first();
      if (successor || board.localTransfer.generation !== board.generation) {
        fail("conflict", "This board is being taken online again elsewhere, so this Take Local was superseded. Run Take Local again later.");
      }
      if (expectedGeneration !== undefined && expectedGeneration !== board.generation) fail("conflict", "This board was taken online again since this Take Local started. Run Take Local again.");
      await ctx.db.patch(board._id, { localTransfer: { ...board.localTransfer, at: new Date().toISOString() } });
      return { generation: board.localTransfer.generation, revision: board.revision, removedPeople: [] as string[] };
    }
    if (!/^[A-Za-z0-9-]{8,80}$/.test(transferId)) fail("validation", "transferId must be 8 to 80 letters, digits or dashes.");
    if (expectedGeneration !== undefined && expectedGeneration !== board.generation) fail("conflict", "This board was taken online again since this Take Local started. Run Take Local again.");
    if (board.authority !== "online") fail("conflict", "This board is already being taken local, or is local already.");
    // Owner decision 15: everyone else loses access, so the person must have
    // confirmed exactly who that is. Checked here, in the same step.
    const members = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId)).collect();
    const others = members.filter((member) => member.userId !== access.connection.userId);
    const acknowledged = new Set(acknowledgedOthers ?? []);
    if (acknowledged.size !== others.length || others.some((member) => !acknowledged.has(member.userId))) {
      fail("conflict", "The people on this board changed since you confirmed. Confirm again who loses access.");
    }
    const now = new Date().toISOString();
    const previous = await currentRoadmap(ctx, live(board));
    const committed = committedRoadmap(previous, now);
    const state = await stateRow(ctx, live(board));
    const packedRoadmap = packJson(committed);
    await ctx.db.patch(state._id, { roadmap: packedRoadmap });
    await addStored(ctx, live(board), sizeOf(packedRoadmap) - sizeOf(state.roadmap));
    // Bumping the revision tells every watching client the board changed.
    await ctx.db.patch(board._id, {
      authority: "returned-local", revision: committed.revision, updatedAt: now,
      localTransfer: { transferId, generation: board.generation, userId: access.connection.userId, at: now },
    });
    await recordHistory(ctx, {
      board, previous, committed,
      history: { actor: "user", operation: "board.take-local", summary: "Took the board back to Local Mode", affectedCards: [] },
      docs: [], attribution: attributionFor(access.connection, "user"), now,
    });
    // Owner decision 15: everyone else, and their agents, lose access now.
    // The online copy stays, read-only, for the person taking it local.
    const removedPeople: string[] = [];
    for (const member of others) {
      removedPeople.push(member.userId);
      await ctx.db.delete(member._id);
    }
    return { generation: board.generation, revision: committed.revision, removedPeople };
  },
});

/** Take Local, last step: the local copy is in place, so the board may be taken online again. */
export const finishTakeLocal = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), transferId: v.string() },
  handler: async (ctx, { connectionId, boardId, transferId }) => {
    const access = await readableBoard(ctx, connectionId, boardId);
    if (!access.canAdminister) fail("forbidden", "Moving a board between Online and Local Mode is kept for the board owner's own connection.");
    const frozen = access.board.localTransfer;
    if (frozen?.transferId === transferId) {
      if (frozen.userId !== access.connection.userId) fail("forbidden", "Only the person who started this Take Local can finish it.");
      await ctx.db.patch(access.board._id, { localTransfer: undefined });
    }
    // Finishing again, or after the freeze lapsed, is harmless.
    return { finished: true };
  },
});

interface Outcome {
  result: unknown;
  version: number;
  revision: number;
  generation?: number;
}

export const run = internalMutation({
  args: {
    connectionId: v.id("connections"),
    boardId: v.string(),
    op: v.string(),
    input: v.any(),
    completionConfirmed: v.optional(v.boolean()),
    idempotencyKey: v.optional(v.string()),
    requestHash: v.optional(v.string()),
  },
  handler: async (ctx, { connectionId, boardId, op, input: rawInput, completionConfirmed, idempotencyKey, requestHash }) => {
    const access = await readableBoard(ctx, connectionId, boardId);
    const at = live(access.board);
    // A retry of an edit that already happened returns its original result.
    if (idempotencyKey) {
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey) || !requestHash) fail("validation", "Idempotency keys are 8 to 100 letters, digits, dashes or underscores.");
      const seen = await ctx.db.query("operations").withIndex("by_user_key", (q) => q.eq("userId", access.connection.userId).eq("key", idempotencyKey)).unique();
      if (seen) {
        if (seen.requestHash !== requestHash || seen.boardId !== boardId) fail("validation", "This idempotency key was already used for a different request.");
        // The original result is returned exactly. The roadmap as it was right
        // after the edit is rebuilt from history; if that version is gone (the
        // board was taken online again, or history was trimmed), the current
        // roadmap is returned and says which revision the edit produced.
        const outcome = unpackJson<Outcome>(seen.outcome);
        const original = outcome.generation === at.generation ? await roadmapAtVersion(ctx, at, outcome.version) : null;
        if (original) return { roadmap: original, result: outcome.result, replayed: true };
        return { roadmap: await currentRoadmap(ctx, at), result: outcome.result, replayed: true, originalRevision: outcome.revision };
      }
    }
    if (!BOARD_OPERATIONS.includes(op as BoardOperation)) fail("not_found", `Unknown operation: ${op}`);
    if (access.board.authority !== "online") fail("conflict", "This board was taken back to Local Mode, so it is read-only online.");
    if (!access.canWrite) fail("forbidden", "This connection can only read this board.");
    let input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
    const current = await currentRoadmap(ctx, at);
    const now = new Date().toISOString();
    const attribution = attributionFor(access.connection, input.actor);
    let outcome: { committed: PlanbanRoadmap; version: number; result: unknown };
    try {
      if (op === "writeDoc") {
        outcome = await writeDoc(ctx, access.board, current, input, now, attribution);
      } else if (op === "restoreBoard" || op === "restoreCard" || op === "restoreDoc") {
        // Restores state the revision they were based on, like any edit, and
        // pass the same completion and ownership checks.
        requireBaseRevision(current, input);
        const version = historyVersionArg(input);
        let change: PlannedChange;
        if (op === "restoreDoc") {
          const cardId = String(input.cardId ?? "");
          const kind = input.kind as DocKind;
          if (!DOC_KINDS.has(kind)) fail("validation", "kind must be spec or plan.");
          const markdown = await historyDocAt(ctx, at, version, cardId, kind);
          if (markdown === null) fail("not_found", `${kind} document not found in v${version}`);
          const planned = planWriteDoc(current, { cardId, kind }, { now });
          change = {
            roadmap: planned.roadmap ?? current,
            history: { actor: attribution.actor, operation: "history.restore.doc", summary: `Restored ${kind} document from v${version}`, affectedCards: [cardId], affectedDocs: [{ cardId, kind, path: planned.path }] },
            docWrites: [{ cardId, kind, path: planned.path, markdown: markdown! }],
          };
        } else {
          const snapshot = await roadmapAtVersion(ctx, at, version);
          if (!snapshot) fail("not_found", `History version not found: v${version}`);
          if (op === "restoreBoard") {
            // The whole board can change at once, so only the person's own sign-in may do it.
            if (!access.connection.canAdminister) fail("forbidden", "Only your own sign-in can restore the whole board.");
            change = {
              roadmap: { ...snapshot!, revision: current.revision, roadmapItems: await keepLiveDocRefs(ctx, at, current, snapshot!.roadmapItems) },
              history: { actor: attribution.actor, operation: "history.restore.board", summary: `Restored board from v${version}`, affectedCards: snapshot!.roadmapItems.map((item) => item.id) },
              docWrites: [],
            };
          } else {
            const cardId = String(input.cardId ?? "");
            const found = snapshot!.roadmapItems.find((item) => item.id === cardId);
            if (!found) fail("not_found", `Card ${cardId} does not exist in v${version}`);
            const [restored] = await keepLiveDocRefs(ctx, at, current, [found!]);
            const exists = current.roadmapItems.some((item) => item.id === cardId);
            const items = exists ? current.roadmapItems.map((item) => (item.id === cardId ? restored! : item)) : [...current.roadmapItems, restored!];
            change = {
              roadmap: { ...current, roadmapItems: normalizeColumnPriorities(items) },
              history: { actor: attribution.actor, operation: "history.restore.card", summary: `Restored ${restored!.title} from v${version}`, affectedCards: [cardId] },
              docWrites: [],
            };
          }
        }
        checkOwnerControlled(current, change.roadmap, access, completionConfirmed);
        const { committed, version: written } = await commit(ctx, access.board, current, change, attribution, now);
        outcome = { committed, version: written, result: {} };
      } else {
        if (op === "setCardParent") {
          // Only re-parenting: status and other move fields are not accepted here.
          input = { cardId: input.cardId, parentId: input.parentId, baseRevision: input.baseRevision };
        }
        requireBaseRevision(current, input);
        const plannerInput = { ...input, actor: attribution.actor } as never;
        const retired = await retiredIds(ctx, at);
        const reserve = { now, isIdReserved: (id: string) => retired.has(id) };
        let change: PlannedChange;
        let result: (roadmap: PlanbanRoadmap) => unknown = () => ({});
        switch (op as BoardOperation) {
          case "moveCard":
          case "setCardParent":
            change = planMoveCard(current, plannerInput, { now });
            break;
          case "updateCard":
            change = planUpdateCard(current, plannerInput, { now });
            break;
          case "reorderCards":
            change = planReorderCards(current, plannerInput, { now });
            break;
          case "deleteArchivedCard":
            change = planDeleteArchivedCard(current, plannerInput);
            break;
          case "createCard": {
            const planned = planCreateCard(current, plannerInput, reserve);
            change = planned;
            result = (roadmap) => ({ createdCard: roadmap.roadmapItems.find((item) => item.id === planned.cardId) });
            break;
          }
          case "createGroup": {
            const planned = planCreateGroup(current, plannerInput, reserve);
            change = planned;
            result = (roadmap) => ({ createdGroup: roadmap.roadmapItems.find((item) => item.id === planned.groupId) });
            break;
          }
          case "createCards": {
            const planned = planCreateCards(current, plannerInput, reserve);
            change = planned;
            const ids = new Set(planned.cardIds);
            result = (roadmap) => ({ createdCards: roadmap.roadmapItems.filter((item) => ids.has(item.id)) });
            break;
          }
          default:
            fail("not_found", `Unknown operation: ${op}`);
        }
        checkOwnerControlled(current, change.roadmap, access, completionConfirmed);
        const { committed, version } = await commit(ctx, access.board, current, change, attribution, now);
        outcome = { committed, version, result: result(committed) };
      }
    } catch (error) {
      throw asServiceError(error, current.revision);
    }
    if (idempotencyKey) {
      await ctx.db.insert("operations", {
        userId: access.connection.userId, key: idempotencyKey, requestHash: requestHash!, boardId,
        outcome: packJson({ result: outcome.result, version: outcome.version, revision: outcome.committed.revision, generation: at.generation } satisfies Outcome),
        createdAt: now,
      });
    }
    return { roadmap: outcome.committed, result: outcome.result };
  },
});

async function writeDoc(ctx: MutationCtx, board: Doc<"boards">, current: PlanbanRoadmap, input: Record<string, unknown>, now: string, attribution: Attribution) {
  const cardId = String(input.cardId ?? "");
  const kind = input.kind as DocKind;
  if (!DOC_KINDS.has(kind)) fail("validation", "kind must be spec or plan.");
  if (typeof input.markdown !== "string") fail("validation", "markdown must be a string.");
  // A document edit's base version is the document's own stamp (below); the
  // board revision is checked too when the caller states it.
  if (input.baseRevision !== undefined) requireBaseRevision(current, input);
  const planned = planWriteDoc(current, { cardId, kind }, { now });
  const existing = await docRow(ctx, live(board), cardId, kind);
  // Documents also state the version they were based on: their stamp, or null for a new document.
  if (input.expectedMtimeMs === undefined) {
    fail("validation", "Online document edits must state the document version they were based on (expectedMtimeMs, or null for a new document).", { currentRevision: current.revision });
  }
  if (existing && existing.stamp !== input.expectedMtimeMs) fail("conflict", "Document changed online. Reload before saving.", { currentRevision: current.revision });
  if (!existing && input.expectedMtimeMs !== null) fail("conflict", "Document was removed online. Reload before saving.", { currentRevision: current.revision });
  const change: PlannedChange = {
    roadmap: planned.roadmap ?? current,
    history: { ...planned.history, actor: attribution.actor },
    docWrites: [{ cardId, kind, path: planned.path, markdown: input.markdown as string }],
  };
  // A document edit is a board change too: it bumps the revision so every
  // client watching for changes sees it, matching local document events.
  const { committed, version } = await commit(ctx, board, current, change, attribution, now);
  return { committed, version, result: { doc: docPayload(await docRow(ctx, live(board), cardId, kind), cardId, kind, planned.path) } };
}
