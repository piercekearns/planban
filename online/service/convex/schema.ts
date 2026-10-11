// One Convex deployment holds every Online Board. Each board change is one
// mutation, so the revision check, the roadmap, its documents and its history
// version commit together or not at all.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const authorityState = v.union(
  v.literal("importing"),
  v.literal("online"),
  v.literal("returning-local"),
  v.literal("returned-local"),
);
export const docKind = v.union(v.literal("spec"), v.literal("plan"));
export const memberRole = v.union(v.literal("owner"), v.literal("editor"), v.literal("viewer"));
export const agentLevel = v.union(v.literal("read"), v.literal("plan"), v.literal("complete"));

export default defineSchema({
  boards: defineTable({
    boardId: v.string(),
    title: v.string(),
    ownerId: v.string(),
    authority: authorityState,
    revision: v.number(),
    /** Latest history version number; versions keep their numbers across transfers. */
    historyVersion: v.number(),
    /** Local history retention settings carried through Take Online so Take Local restores them. */
    retention: v.optional(v.any()),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("by_boardId", ["boardId"]),

  /** The whole roadmap, deflate-compressed: the shared planning rules need all of it. */
  boardState: defineTable({
    boardId: v.string(),
    roadmap: v.bytes(),
  }).index("by_boardId", ["boardId"]),

  docs: defineTable({
    boardId: v.string(),
    cardId: v.string(),
    kind: docKind,
    markdown: v.bytes(),
    /** Increases on every write; the local side's document conflict check uses it as mtimeMs. */
    stamp: v.number(),
    updatedAt: v.string(),
    updatedBy: v.string(),
  }).index("by_board_card_kind", ["boardId", "cardId", "kind"]),

  /**
   * One row per history version. Every SNAPSHOT_EVERY versions (and the first
   * after an import) keeps a full compressed roadmap; the rest keep only what
   * changed since the previous version.
   */
  history: defineTable({
    boardId: v.string(),
    version: v.number(),
    entry: v.any(),
    snapshot: v.optional(v.bytes()),
    delta: v.optional(v.bytes()),
  }).index("by_board_version", ["boardId", "version"]),

  historyDocs: defineTable({
    boardId: v.string(),
    version: v.number(),
    cardId: v.string(),
    kind: docKind,
    markdown: v.bytes(),
  }).index("by_board_version", ["boardId", "version"]),

  /** Ids of deleted cards, never reused, so history keeps one meaning per id. */
  retiredIds: defineTable({
    boardId: v.string(),
    cardId: v.string(),
  }).index("by_board_card", ["boardId", "cardId"]),

  members: defineTable({
    boardId: v.string(),
    userId: v.string(),
    role: memberRole,
  }).index("by_board_user", ["boardId", "userId"]).index("by_user", ["userId"]),

  /**
   * Every credential (a machine sign-in, a remote agent's OAuth grant, a
   * personal access key, a development token) resolves to one row, checked on
   * every request, so revoking it takes effect immediately.
   */
  connections: defineTable({
    userId: v.string(),
    kind: v.union(v.literal("dev"), v.literal("machine"), v.literal("oauth"), v.literal("key")),
    name: v.string(),
    clientName: v.string(),
    /** SHA-256 of the bearer secret, for kinds Planban issues itself. */
    tokenHash: v.optional(v.string()),
    boards: v.union(v.literal("all"), v.array(v.string())),
    level: agentLevel,
    /** The person's own connection: may complete, delete, move authority and invite. */
    canAdminister: v.boolean(),
    createdAt: v.string(),
    lastUsedAt: v.string(),
    expiresAt: v.optional(v.string()),
    revokedAt: v.optional(v.string()),
  }).index("by_tokenHash", ["tokenHash"]).index("by_user", ["userId"]),
});
