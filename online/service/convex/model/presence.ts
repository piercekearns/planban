// Working on a card (Spec point 20): a heads-up, not a lock. When an agent
// reads or edits a card it is marked as working on it, until 15 minutes after
// its last activity. Other agents see "Claude (Sam) is working on this card,
// started 4 minutes ago"; people see a small, quiet sign on the card. Nothing
// is checked out or claimed.
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { BoardRows } from "./history";

export const PRESENCE_MS = 15 * 60 * 1000;

/** An app name as people say it, from what an MCP client calls itself ("claude-code" is "Claude"). */
export function appName(raw: string | undefined | null) {
  const name = (raw ?? "").trim();
  if (/claude/i.test(name)) return "Claude";
  if (/codex/i.test(name)) return "Codex";
  if (/chatgpt|openai/i.test(name)) return "ChatGPT";
  return name.slice(0, 40) || "An agent";
}

/** Within this long, another touch by the same agent writes nothing: reads stay cheap and don't contend. */
const TOUCH_EVERY_MS = 60 * 1000;

/**
 * One row per agent (its sign-in and app) per card: two apps on one
 * computer's sign-in are two agents. Only the agent's own row is read and
 * written, and at most once a minute.
 */
export async function touchPresence(ctx: MutationCtx, at: BoardRows, entry: { cardId: string; connectionId: Id<"connections">; userId: string; app: string }, now = Date.now()) {
  const mine = (await ctx.db.query("presence").withIndex("by_agent", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", entry.cardId).eq("connectionId", entry.connectionId)).collect())
    .find((row) => row.app === entry.app);
  if (!mine) {
    await ctx.db.insert("presence", { ...at, ...entry, startedAt: now, lastActiveAt: now });
    return;
  }
  if (now - mine.lastActiveAt < TOUCH_EVERY_MS) return;
  // A gap longer than the heads-up lasts starts a new stretch of work.
  const fresh = now - mine.lastActiveAt > PRESENCE_MS;
  await ctx.db.patch(mine._id, { lastActiveAt: now, ...(fresh ? { startedAt: now } : {}) });
}

export interface Working {
  userId: string;
  app: string;
  startedAt: string;
  lastActiveAt: string;
  connectionId: string;
}

/** Who is working on each card now (or on one card), leaving out `except` (the asker). */
export async function workingOn(ctx: QueryCtx, at: BoardRows, options: { cardId?: string; except?: { connectionId: string; app: string } } = {}, now = Date.now()) {
  const rows = options.cardId
    ? await ctx.db.query("presence").withIndex("by_board_card", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", options.cardId!)).collect()
    : await ctx.db.query("presence").withIndex("by_board_card", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).collect();
  const byCard: Record<string, Working[]> = {};
  for (const row of rows) {
    if (now - row.lastActiveAt > PRESENCE_MS || (row.connectionId === options.except?.connectionId && row.app === options.except.app)) continue;
    (byCard[row.cardId] ??= []).push({ userId: row.userId, app: row.app, startedAt: new Date(row.startedAt).toISOString(), lastActiveAt: new Date(row.lastActiveAt).toISOString(), connectionId: row.connectionId });
  }
  return byCard;
}

/** "Claude (Sam) is working on this card, started 4 minutes ago." */
export function workingSentence(who: string, startedAt: string, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - Date.parse(startedAt)) / 60000));
  const ago = minutes === 0 ? "just now" : minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  return `${who} is working on this card, started ${ago}.`;
}
