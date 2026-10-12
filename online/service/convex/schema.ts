// One Convex deployment holds every Online Board. Each board change is one
// mutation, so the revision check, the roadmap, its documents and its history
// version commit together or not at all.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const authorityState = v.union(
  v.literal("importing"),
  v.literal("online"),
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
    /**
     * Which copy of the board's rows is live. Take Online uploads into the next
     * generation, invisible until its commit flips this pointer, so a failed
     * or abandoned upload never changes the live board.
     */
    generation: v.number(),
    /** Latest history version number; versions keep their numbers across transfers. */
    historyVersion: v.number(),
    /**
     * A Take Local in progress: the board is frozen for this transfer, and
     * its downloads read exactly this generation. Cleared when it finishes.
     */
    localTransfer: v.optional(v.object({ transferId: v.string(), generation: v.number(), userId: v.string(), at: v.string() })),
    /** The board's durable identity, carried by every local copy of it. */
    uid: v.optional(v.string()),
    /** Files of this earlier generation are still moving to the live one; the board cannot be frozen meanwhile. */
    carryFrom: v.optional(v.number()),
    /** When the board last became editable online (Take Online commit). */
    onlineSince: v.optional(v.string()),
    /** Local history retention settings carried through Take Online so Take Local restores them. */
    retention: v.optional(v.any()),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("by_boardId", ["boardId"]).index("by_uid", ["uid"]),

  /**
   * Fingerprints ("version|createdAt|operation") of every history entry a
   * board arrived with, kept even after that history is trimmed, so an old
   * local copy can still be recognised.
   */
  boardFingerprints: defineTable({
    boardId: v.string(),
    generation: v.number(),
    key: v.string(),
  }).index("by_key", ["key"]).index("by_board_generation", ["boardId", "generation"]),

  /** The whole roadmap, deflate-compressed: the shared planning rules need all of it. */
  boardState: defineTable({
    boardId: v.string(),
    generation: v.number(),
    roadmap: v.bytes(),
  }).index("by_board_generation", ["boardId", "generation"]),

  docs: defineTable({
    boardId: v.string(),
    generation: v.number(),
    cardId: v.string(),
    kind: docKind,
    markdown: v.bytes(),
    /** Increases on every write; the local side's document conflict check uses it as mtimeMs. */
    stamp: v.number(),
    updatedAt: v.string(),
    updatedBy: v.string(),
  }).index("by_board_card_kind", ["boardId", "generation", "cardId", "kind"]),

  /**
   * One small row per history version: what happened, who and when. Its
   * roadmap lives in historyPayloads, so listing history stays cheap.
   */
  history: defineTable({
    boardId: v.string(),
    generation: v.number(),
    version: v.number(),
    entry: v.any(),
    /** True when the payload is a full roadmap rather than the changes since the previous version. */
    snapshot: v.boolean(),
  }).index("by_board_version", ["boardId", "generation", "version"]),

  historyPayloads: defineTable({
    boardId: v.string(),
    generation: v.number(),
    version: v.number(),
    snapshot: v.optional(v.bytes()),
    delta: v.optional(v.bytes()),
  }).index("by_board_version", ["boardId", "generation", "version"]),

  historyDocs: defineTable({
    boardId: v.string(),
    generation: v.number(),
    version: v.number(),
    cardId: v.string(),
    kind: docKind,
    markdown: v.bytes(),
  }).index("by_board_version", ["boardId", "generation", "version"])
    .index("by_board_doc_version", ["boardId", "generation", "cardId", "kind", "version"]),

  /** Ids of deleted cards, never reused, so history keeps one meaning per id. */
  retiredIds: defineTable({
    boardId: v.string(),
    generation: v.number(),
    cardId: v.string(),
  }).index("by_board_card", ["boardId", "generation", "cardId"]),

  members: defineTable({
    boardId: v.string(),
    userId: v.string(),
    role: memberRole,
    /** What this person lets their agents do on this board; see memberAgentLevel for the default. Everyone on the board can see it. */
    agentLevel: v.optional(agentLevel),
  }).index("by_board_user", ["boardId", "userId"]).index("by_user", ["userId"]),

  /** Invites to a board: a link anyone may use for 7 days, or an email invite for one person. Only the hash of the link's secret is kept. */
  invites: defineTable({
    boardId: v.string(),
    tokenHash: v.string(),
    role: v.union(v.literal("editor"), v.literal("viewer")),
    email: v.optional(v.string()),
    createdBy: v.string(),
    createdAt: v.string(),
    expiresAt: v.string(),
    joinedBy: v.array(v.string()),
    revokedAt: v.optional(v.string()),
  }).index("by_tokenHash", ["tokenHash"]).index("by_board", ["boardId"]),

  /** How a person appears to others on shared boards (name and picture from the sign-in account). */
  people: defineTable({
    userId: v.string(),
    name: v.string(),
    imageUrl: v.optional(v.string()),
    email: v.optional(v.string()),
    updatedAt: v.string(),
  }).index("by_userId", ["userId"]),

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
    /** For an AI app's connection: the OAuth client it was authorised for. */
    oauthClientId: v.optional(v.string()),
  }).index("by_tokenHash", ["tokenHash"]).index("by_user", ["userId"]).index("by_user_client", ["userId", "oauthClientId"]),

  /** Clerk's signing key set (JSON), and when it was last fetched and last attempted. */
  signingKeys: defineTable({
    name: v.string(),
    keys: v.string(),
    fetchedAt: v.number(),
    attemptedAt: v.number(),
  }).index("by_name", ["name"]),

  /**
   * Sign-in tokens the command line has already exchanged for a machine
   * sign-in. Each one works once, so a copied token cannot make another
   * sign-in, even after this one is signed out. Kept until it would be too
   * old to exchange anyway.
   */
  machineExchanges: defineTable({
    tokenHash: v.string(),
    expiresAt: v.string(),
  }).index("by_tokenHash", ["tokenHash"]).index("by_expiresAt", ["expiresAt"]),

  /** Take Online uploads, sent in parts under one transfer id. */
  transfers: defineTable({
    transferId: v.string(),
    userId: v.string(),
    boardId: v.string(),
    generation: v.number(),
    state: v.union(v.literal("open"), v.literal("committed"), v.literal("aborted")),
    /** Board revision before the upload, for boards taken online again. */
    previousRevision: v.number(),
    /** Highest history version uploaded so far. */
    maxVersion: v.number(),
    retention: v.optional(v.any()),
    uid: v.optional(v.string()),
    createdAt: v.string(),
    updatedAt: v.string(),
  }).index("by_transferId", ["transferId"]).index("by_board_state", ["boardId", "state"]).index("by_state_updated", ["state", "updatedAt"]),

  transferParts: defineTable({
    transferId: v.string(),
    seq: v.number(),
  }).index("by_transfer_seq", ["transferId", "seq"]),

  /**
   * Idempotency records: a retried edit with the same key returns the
   * original result instead of applying twice. Kept for seven days.
   */
  operations: defineTable({
    userId: v.string(),
    key: v.string(),
    requestHash: v.string(),
    boardId: v.string(),
    /** The operation's result and the history version it created. */
    outcome: v.bytes(),
    createdAt: v.string(),
  }).index("by_user_key", ["userId", "key"]).index("by_createdAt", ["createdAt"]),

  /** Counters shared across boards. Generations are numbered globally so rows of a deleted and re-created board never collide. */
  counters: defineTable({
    name: v.string(),
    value: v.number(),
  }).index("by_name", ["name"]),

  /**
   * Files attached to cards (images, models, exports): one row per file path
   * in a card's folder, pointing at a stored blob by content hash.
   */
  attachments: defineTable({
    boardId: v.string(),
    generation: v.number(),
    cardId: v.string(),
    /** Path inside the card's folder, with forward slashes. */
    path: v.string(),
    /** The path as a case-insensitive file system sees it, so two paths can never land on one file. */
    pathKey: v.string(),
    sha256: v.string(),
    size: v.number(),
    contentType: v.string(),
    uploadedBy: v.string(),
    uploadedAt: v.string(),
  }).index("by_board_card_path", ["boardId", "generation", "cardId", "path"])
    .index("by_board_card_pathKey", ["boardId", "generation", "cardId", "pathKey"])
    .index("by_board_sha", ["boardId", "sha256"])
    .index("by_board_generation", ["boardId", "generation"]),

  /** Stored file contents, once per board per content hash, in whichever blob store holds them. */
  blobs: defineTable({
    boardId: v.string(),
    sha256: v.string(),
    size: v.number(),
    store: v.union(v.literal("convex"), v.literal("r2")),
    storageKey: v.string(),
    createdAt: v.string(),
  }).index("by_board_sha", ["boardId", "sha256"]).index("by_storageKey", ["storageKey"]),

  /**
   * An upload in progress: issued by `begin` to one person's connection for
   * one board, card, path and content. `finish` only accepts stored bytes
   * for an upload issued this way, so nobody can claim someone else's upload.
   */
  uploads: defineTable({
    boardId: v.string(),
    userId: v.string(),
    connectionId: v.string(),
    cardId: v.string(),
    path: v.string(),
    sha256: v.string(),
    size: v.number(),
    contentType: v.string(),
    state: v.union(v.literal("open"), v.literal("finished"), v.literal("rejected")),
    createdAt: v.string(),
    attachmentId: v.optional(v.string()),
  }).index("by_state_created", ["state", "createdAt"]),

  /**
   * The bytes of an upload, in parts stored by Planban's own upload endpoint
   * for that upload only. A finished upload's parts become its blob (the
   * blob's storageKey is the upload's id).
   */
  uploadParts: defineTable({
    uploadId: v.string(),
    index: v.number(),
    storageId: v.id("_storage"),
    size: v.number(),
  }).index("by_upload_index", ["uploadId", "index"]).index("by_storageId", ["storageId"]),
});
