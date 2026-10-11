// The Online Board authority. Every change runs the shared planning rules from
// src/core/boardOperations.ts inside one Convex mutation, so the revision
// check, roadmap, documents and history version commit together or not at all.
import { v } from "convex/values";
import {
  assertBaseRevision,
  assertCommittable,
  committedRoadmap,
  normalizeRoadmap,
  planCreateCard,
  planCreateCards,
  planCreateGroup,
  planDeleteArchivedCard,
  planMoveCard,
  planReorderCards,
  planUpdateCard,
  planWriteDoc,
  type PlannedChange,
} from "../../../src/core/boardOperations";
import type { PlanbanDocPayload, PlanbanHistoryEntry, PlanbanHistoryPayload, PlanbanRoadmap } from "../../../src/core/types";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { BOARD_ID_PATTERN, boardAccess, liveConnection, reaches } from "./model/access";
import { packJson, packText, unpackJson, unpackText } from "./model/codec";
import { asServiceError, fail } from "./model/errors";
import { importHistoryVersion, recordHistory, roadmapAtVersion, type Attribution } from "./model/history";

export const BOARD_OPERATIONS = [
  "createCard", "createCards", "createGroup", "updateCard", "moveCard",
  "setCardParent", "reorderCards", "deleteArchivedCard", "writeDoc",
] as const;
export type BoardOperation = (typeof BOARD_OPERATIONS)[number];

type DocKind = "spec" | "plan";
const DOC_KINDS = new Set<string>(["spec", "plan"]);

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

async function stateRow(ctx: QueryCtx, boardId: string) {
  const row = await ctx.db.query("boardState").withIndex("by_boardId", (q) => q.eq("boardId", boardId)).unique();
  if (!row) fail("not_found", `Online Board not found: ${boardId}`);
  return row!;
}

async function currentRoadmap(ctx: QueryCtx, boardId: string): Promise<PlanbanRoadmap> {
  return unpackJson<PlanbanRoadmap>((await stateRow(ctx, boardId)).roadmap);
}

async function docRow(ctx: QueryCtx, boardId: string, cardId: string, kind: DocKind) {
  return ctx.db.query("docs").withIndex("by_board_card_kind", (q) => q.eq("boardId", boardId).eq("cardId", cardId).eq("kind", kind)).unique();
}

function docPayload(row: Doc<"docs"> | null, cardId: string, kind: DocKind, path: string | null): PlanbanDocPayload {
  if (!row) return { cardId, kind, path, exists: false, markdown: "", mtimeMs: null };
  return { cardId, kind, path, exists: true, markdown: unpackText(row.markdown), mtimeMs: row.stamp };
}

function attributionFor(connection: Doc<"connections">, actor: unknown): Attribution {
  return { userId: connection.userId, clientName: connection.clientName, actor: actor === "user" ? "user" : "agent", connectionId: connection._id };
}

/** Writes the roadmap, documents and one history version. Runs inside the caller's mutation. */
async function commit(ctx: MutationCtx, board: Doc<"boards">, previous: PlanbanRoadmap, change: PlannedChange, attribution: Attribution, now: string) {
  assertCommittable(change.roadmap);
  const committed = committedRoadmap(change.roadmap, now);
  const state = await stateRow(ctx, board.boardId);
  await ctx.db.patch(state._id, { roadmap: packJson(committed) });
  const remaining = new Set(committed.roadmapItems.map((item) => item.id));
  for (const item of previous.roadmapItems) {
    if (remaining.has(item.id)) continue;
    // Deleted ids are never reused, so history keeps one meaning per id.
    await ctx.db.insert("retiredIds", { boardId: board.boardId, cardId: item.id });
    for (const kind of ["spec", "plan"] as const) {
      const row = await docRow(ctx, board.boardId, item.id, kind);
      if (row) await ctx.db.delete(row._id);
    }
  }
  for (const doc of change.docWrites) {
    const row = await docRow(ctx, board.boardId, doc.cardId, doc.kind);
    const stamp = Math.max(Date.now(), (row?.stamp ?? 0) + 1);
    const fields = { markdown: packText(doc.markdown), stamp, updatedAt: now, updatedBy: attribution.userId };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("docs", { boardId: board.boardId, cardId: doc.cardId, kind: doc.kind, ...fields });
  }
  const listed = change.history.affectedDocs ?? [];
  const affectedDocs = [
    ...listed,
    ...change.docWrites
      .filter((doc) => !listed.some((ref) => ref.cardId === doc.cardId && ref.kind === doc.kind))
      .map((doc) => ({ cardId: doc.cardId, kind: doc.kind, path: doc.path })),
  ];
  await ctx.db.patch(board._id, { revision: committed.revision, updatedAt: now });
  await recordHistory(ctx, {
    board: { ...board, revision: committed.revision },
    previous,
    committed,
    history: { ...change.history, affectedDocs },
    docs: change.docWrites.map(({ cardId, kind, markdown }) => ({ cardId, kind, markdown })),
    attribution,
    now,
  });
  return committed;
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
  if (completes && !access.canComplete) fail("forbidden", "Completing a card is kept for the board owner. Ask the owner to do it.");
  if (completes && completionConfirmed === false) {
    fail("validation", "completionConfirmed must be true when this would move a card to complete. Only do this when the owner explicitly asks.");
  }
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

/** The board. With `since` equal to the current revision, returns only the revision: no roadmap is read. */
export const getBoard = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), since: v.optional(v.number()) },
  handler: async (ctx, { connectionId, boardId, since }) => {
    const { board } = await boardAccess(ctx, connectionId, boardId);
    if (board.authority === "importing") fail("not_found", `Online Board not found: ${boardId}`);
    if (since !== undefined && since === board.revision) return { unchanged: true as const, revision: board.revision, authority: board.authority };
    return { roadmap: await currentRoadmap(ctx, boardId), authority: board.authority };
  },
});

/** A single small row: what live updates subscribe to. */
export const revision = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }) => {
    const { board } = await boardAccess(ctx, connectionId, boardId);
    return { revision: board.revision, authority: board.authority };
  },
});

export const readDoc = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string(), cardId: v.string(), kind: v.union(v.literal("spec"), v.literal("plan")) },
  handler: async (ctx, { connectionId, boardId, cardId, kind }) => {
    await boardAccess(ctx, connectionId, boardId);
    const roadmap = await currentRoadmap(ctx, boardId);
    const item = roadmap.roadmapItems.find((entry) => entry.id === cardId);
    if (!item) fail("not_found", `Card not found: ${cardId}`);
    return docPayload(await docRow(ctx, boardId, cardId, kind), cardId, kind, (kind === "spec" ? item!.specDoc : item!.planDoc) ?? null);
  },
});

export const history = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }): Promise<PlanbanHistoryPayload> => {
    const { board } = await boardAccess(ctx, connectionId, boardId);
    const entries: PlanbanHistoryEntry[] = [];
    for await (const row of ctx.db.query("history").withIndex("by_board_version", (q) => q.eq("boardId", boardId)).order("desc")) {
      entries.push(row.entry as PlanbanHistoryEntry);
    }
    return {
      currentVersion: board.historyVersion,
      retention: { boardVersions: 1000, cardVersions: 1000, documentVersions: 1000, hourlyDays: 0, maxAgeDays: 0 },
      entries,
    } as PlanbanHistoryPayload;
  },
});

export const exportBoard = internalQuery({
  args: { connectionId: v.id("connections"), boardId: v.string() },
  handler: async (ctx, { connectionId, boardId }): Promise<BoardBundle> => {
    const { board } = await boardAccess(ctx, connectionId, boardId);
    const roadmap = await currentRoadmap(ctx, boardId);
    const docs: BoardBundle["docs"] = [];
    for (const item of roadmap.roadmapItems) {
      for (const kind of ["spec", "plan"] as const) {
        const row = await docRow(ctx, boardId, item.id, kind);
        if (row) docs.push({ cardId: item.id, kind, markdown: unpackText(row.markdown) });
      }
    }
    const history: BoardBundle["history"] = [];
    for await (const row of ctx.db.query("history").withIndex("by_board_version", (q) => q.eq("boardId", boardId))) {
      history.push({ entry: row.entry as PlanbanHistoryEntry, roadmap: (await roadmapAtVersion(ctx, boardId, row.version))! });
    }
    const historyDocs: NonNullable<BoardBundle["historyDocs"]> = [];
    for await (const row of ctx.db.query("historyDocs").withIndex("by_board_version", (q) => q.eq("boardId", boardId))) {
      historyDocs.push({ version: row.version, cardId: row.cardId, kind: row.kind, markdown: unpackText(row.markdown) });
    }
    const retiredIds = (await ctx.db.query("retiredIds").withIndex("by_board_card", (q) => q.eq("boardId", boardId)).collect()).map((row) => row.cardId);
    return {
      format: "planban-board-bundle", version: 1, roadmap, docs, history, historyDocs, retiredIds,
      ...(board.retention === undefined ? {} : { retention: board.retention }),
    };
  },
});

// ---- writes -------------------------------------------------------------

/**
 * Take Online: create a board from a bundle, or take a board that was
 * returned to Local Mode online again with the same identity. Its revision
 * keeps increasing so no client's stale revision can match by accident.
 */
export const importBoard = internalMutation({
  args: { connectionId: v.id("connections"), bundle: v.any() },
  handler: async (ctx, { connectionId, bundle: input }) => {
    const connection = await liveConnection(ctx, connectionId);
    if (connection.boards !== "all" || !connection.canAdminister) {
      fail("forbidden", "Taking a board online needs the owner's own connection, not a per-board grant.");
    }
    const bundle = input as BoardBundle;
    if (bundle?.format !== "planban-board-bundle" || bundle.version !== 1) fail("validation", "Expected a planban-board-bundle, version 1.");
    const boardId = bundle.roadmap?.project?.id;
    if (typeof boardId !== "string" || !BOARD_ID_PATTERN.test(boardId)) fail("validation", "The bundle's project id must be a lowercase slug.");
    let roadmap: PlanbanRoadmap;
    try {
      roadmap = normalizeRoadmap(bundle.roadmap);
      assertCommittable(roadmap);
    } catch (error) {
      throw asServiceError(error);
    }
    const now = new Date().toISOString();
    let board = await ctx.db.query("boards").withIndex("by_boardId", (q) => q.eq("boardId", boardId)).unique();
    let previousRevision = -1;
    if (board) {
      const member = await ctx.db.query("members").withIndex("by_board_user", (q) => q.eq("boardId", boardId).eq("userId", connection.userId)).unique();
      if (member?.role !== "owner") fail("conflict", `An Online Board called ${boardId} already exists.`);
      if (board.authority !== "returned-local") fail("conflict", "This board is already online. Take it local first, or edit it online.");
      previousRevision = board.revision;
      // Re-import replaces the live state and documents; history and retired ids accumulate.
      for (const row of await ctx.db.query("docs").withIndex("by_board_card_kind", (q) => q.eq("boardId", boardId)).collect()) await ctx.db.delete(row._id);
      const state = await ctx.db.query("boardState").withIndex("by_boardId", (q) => q.eq("boardId", boardId)).unique();
      if (state) await ctx.db.delete(state._id);
    } else {
      const id = await ctx.db.insert("boards", {
        boardId, title: roadmap.project.title, ownerId: connection.userId, authority: "importing",
        revision: roadmap.revision, historyVersion: 0, createdAt: now, updatedAt: now,
      });
      board = (await ctx.db.get(id))!;
      await ctx.db.insert("members", { boardId, userId: connection.userId, role: "owner" });
    }
    const live = new Set(roadmap.roadmapItems.map((item) => item.id));
    let stamp = Date.now();
    const docKeys = new Set<string>();
    for (const doc of bundle.docs ?? []) {
      if (!DOC_KINDS.has(doc.kind) || typeof doc.markdown !== "string") fail("validation", `Document ${doc.cardId}/${doc.kind} is invalid.`);
      if (!live.has(doc.cardId)) fail("validation", `Bundle contains a document for an unknown card: ${doc.cardId}`);
      const key = `${doc.cardId}/${doc.kind}`;
      if (docKeys.has(key)) fail("validation", `Bundle contains a duplicate document: ${key}`);
      docKeys.add(key);
      await ctx.db.insert("docs", { boardId, cardId: doc.cardId, kind: doc.kind, markdown: packText(doc.markdown), stamp: stamp++, updatedAt: now, updatedBy: connection.userId });
    }
    let latestVersion = board.historyVersion;
    const versions = new Set<number>();
    for (const version of bundle.history ?? []) {
      const number = version?.entry?.version;
      if (!Number.isInteger(number) || versions.has(number)) fail("validation", "History versions must be unique integers.");
      // Taking a board online again: versions it already holds online are kept as they are.
      if (number <= board.historyVersion) continue;
      versions.add(number);
      await importHistoryVersion(ctx, boardId, version.entry, normalizeRoadmap(version.roadmap));
      latestVersion = Math.max(latestVersion, number);
    }
    for (const doc of bundle.historyDocs ?? []) {
      if (!versions.has(doc.version) || !DOC_KINDS.has(doc.kind) || typeof doc.markdown !== "string") continue;
      await ctx.db.insert("historyDocs", { boardId, version: doc.version, cardId: doc.cardId, kind: doc.kind, markdown: packText(doc.markdown) });
    }
    // Retire every id the board has ever used that is not live now.
    const known = new Set((await ctx.db.query("retiredIds").withIndex("by_board_card", (q) => q.eq("boardId", boardId)).collect()).map((row) => row.cardId));
    const retire = new Set(bundle.retiredIds ?? []);
    for (const version of bundle.history ?? []) for (const item of version.roadmap?.roadmapItems ?? []) if (!live.has(item.id)) retire.add(item.id);
    for (const id of retire) if (!known.has(id) && !live.has(id)) await ctx.db.insert("retiredIds", { boardId, cardId: id });

    // Taking a board online is itself a change: it bumps the revision once and
    // adds a history version, keeping earlier version numbers intact.
    const base = { ...roadmap, revision: Math.max(roadmap.revision, previousRevision) };
    const committed = committedRoadmap(base, now);
    await ctx.db.insert("boardState", { boardId, roadmap: packJson(committed) });
    await ctx.db.patch(board._id, {
      title: roadmap.project.title, authority: "online", revision: committed.revision, historyVersion: latestVersion, updatedAt: now,
      ...(bundle.retention === undefined ? {} : { retention: bundle.retention }),
    });
    await recordHistory(ctx, {
      board: { ...board, historyVersion: latestVersion },
      previous: null,
      committed,
      history: { actor: "user", operation: "board.take-online", summary: "Took the board online", affectedCards: [] },
      docs: [],
      attribution: attributionFor(connection, "user"),
      now,
    });
    return { boardId, roadmap: committed };
  },
});

export const setAuthority = internalMutation({
  args: { connectionId: v.id("connections"), boardId: v.string(), state: v.union(v.literal("online"), v.literal("returned-local")) },
  handler: async (ctx, { connectionId, boardId, state }) => {
    const access = await boardAccess(ctx, connectionId, boardId);
    if (!access.canAdminister) fail("forbidden", "Moving a board between Online and Local Mode is kept for the board owner's own connection.");
    const now = new Date().toISOString();
    const previous = await currentRoadmap(ctx, boardId);
    const committed = committedRoadmap(previous, now);
    const row = await stateRow(ctx, boardId);
    await ctx.db.patch(row._id, { roadmap: packJson(committed) });
    // Bumping the revision tells every watching client the board changed.
    await ctx.db.patch(access.board._id, { authority: state, revision: committed.revision, updatedAt: now });
    await recordHistory(ctx, {
      board: access.board,
      previous,
      committed,
      history: {
        actor: "user",
        operation: state === "online" ? "board.take-online" : "board.take-local",
        summary: state === "online" ? "Made the board editable online again" : "Took the board back to Local Mode",
        affectedCards: [],
      },
      docs: [],
      attribution: attributionFor(access.connection, "user"),
      now,
    });
    return { authority: state };
  },
});

export const run = internalMutation({
  args: {
    connectionId: v.id("connections"),
    boardId: v.string(),
    op: v.string(),
    input: v.any(),
    completionConfirmed: v.optional(v.boolean()),
  },
  handler: async (ctx, { connectionId, boardId, op, input: rawInput, completionConfirmed }) => {
    const access = await boardAccess(ctx, connectionId, boardId);
    if (!BOARD_OPERATIONS.includes(op as BoardOperation)) fail("not_found", `Unknown operation: ${op}`);
    if (access.board.authority !== "online") fail("conflict", "This board was taken back to Local Mode, so it is read-only online.");
    if (!access.canWrite) fail("forbidden", "This connection can only read this board.");
    let input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
    const current = await currentRoadmap(ctx, boardId);
    const now = new Date().toISOString();
    const attribution = attributionFor(access.connection, input.actor);
    try {
      if (op === "writeDoc") return await writeDoc(ctx, access.board, current, input, now, attribution);
      if (op === "setCardParent") {
        // Only re-parenting: status and other move fields are not accepted here.
        input = { cardId: input.cardId, parentId: input.parentId, baseRevision: input.baseRevision };
      }
      assertBaseRevision(current, input.baseRevision as number | undefined);
      const plannerInput = { ...input, actor: attribution.actor } as never;
      const retired = new Set((await ctx.db.query("retiredIds").withIndex("by_board_card", (q) => q.eq("boardId", boardId)).collect()).map((row) => row.cardId));
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
      const committed = await commit(ctx, access.board, current, change, attribution, now);
      return { roadmap: committed, result: result(committed) };
    } catch (error) {
      throw asServiceError(error, current.revision);
    }
  },
});

async function writeDoc(ctx: MutationCtx, board: Doc<"boards">, current: PlanbanRoadmap, input: Record<string, unknown>, now: string, attribution: Attribution) {
  const cardId = String(input.cardId ?? "");
  const kind = input.kind as DocKind;
  if (!DOC_KINDS.has(kind)) fail("validation", "kind must be spec or plan.");
  if (typeof input.markdown !== "string") fail("validation", "markdown must be a string.");
  assertBaseRevision(current, input.baseRevision as number | undefined);
  const planned = planWriteDoc(current, { cardId, kind }, { now });
  const existing = await docRow(ctx, board.boardId, cardId, kind);
  if (input.expectedMtimeMs !== undefined) {
    if (existing && existing.stamp !== input.expectedMtimeMs) fail("conflict", "Document changed online. Reload before saving.", { currentRevision: current.revision });
    if (!existing && input.expectedMtimeMs !== null) fail("conflict", "Document was removed online. Reload before saving.", { currentRevision: current.revision });
  }
  const change: PlannedChange = {
    roadmap: planned.roadmap ?? current,
    history: { ...planned.history, actor: attribution.actor },
    docWrites: [{ cardId, kind, path: planned.path, markdown: input.markdown as string }],
  };
  // A document edit is a board change too: it bumps the revision so every
  // client watching for changes sees it, matching local document events.
  const committed = await commit(ctx, board, current, change, attribution, now);
  return { roadmap: committed, result: { doc: docPayload(await docRow(ctx, board.boardId, cardId, kind), cardId, kind, planned.path) } };
}
