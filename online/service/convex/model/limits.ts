// Size and volume caps (owner decision 18). The text check (contentRules)
// is the first line against files in boards; these caps are the guarantee
// behind it: however content is written, one board can hold only so much,
// and one account can write only so much a day, so splitting a file across
// many cards or many writes runs out quickly.
import type { MutationCtx } from "../_generated/server";
import { fail } from "./errors";
import type { BoardRows } from "./history";

/**
 * Stored text per board, history included, as the service stores it
 * (compressed). The largest real board (Revival's) would take at most about
 * 35 MB: 2.3 MB of live text and under 33 MB of history.
 */
export const BOARD_STORED_LIMIT = 256 * 1024 * 1024;
/** Per account per day (UTC): changes, the text they write, and Take Online imports. */
export const DAILY_WRITES = 5_000;
export const DAILY_WRITE_BYTES = 64 * 1024 * 1024;
export const DAILY_IMPORT_BYTES = 1024 * 1024 * 1024;

/** A test backend may set lower limits (PLANBAN_TEST_LIMITS="board,writes,writeBytes,importBytes"); never higher. */
function limit(index: number, fallback: number) {
  const value = Number((process.env.PLANBAN_TEST_LIMITS ?? "").split(",")[index]);
  return Number.isFinite(value) && value > 0 ? Math.min(value, fallback) : fallback;
}

const MB = (bytes: number) => bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`;

/** Size in bytes of something stored: packed bytes as kept, or text as sent. */
export function sizeOf(value: ArrayBuffer | Uint8Array | string | unknown): number {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return (value as ArrayBuffer).byteLength;
  if (typeof value === "string") return new TextEncoder().encode(value).length;
  return new TextEncoder().encode(JSON.stringify(value) ?? "").length;
}

/** Adds (or, when negative, removes) stored bytes for one board generation; refuses growth past the board limit. */
export async function addStored(ctx: MutationCtx, at: BoardRows, delta: number, options: { allowOverLimit?: boolean } = {}) {
  if (delta === 0) return;
  const row = await ctx.db.query("boardSizes").withIndex("by_board_generation", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).unique();
  const bytes = Math.max(0, (row?.bytes ?? 0) + delta);
  if (delta > 0 && !options.allowOverLimit && bytes > limit(0, BOARD_STORED_LIMIT)) {
    fail("validation", `Not saved: this board would hold more than ${MB(limit(0, BOARD_STORED_LIMIT))} of text, history included. Planban is an index, not storage: keep long material where it lives and link to it, or move finished work to another board.`);
  }
  if (row) await ctx.db.patch(row._id, { bytes });
  else await ctx.db.insert("boardSizes", { ...at, bytes });
}

async function usageRow(ctx: MutationCtx, userId: string) {
  const day = new Date().toISOString().slice(0, 10);
  const row = await ctx.db.query("usage").withIndex("by_user_day", (q) => q.eq("userId", userId).eq("day", day)).unique();
  if (row) return row;
  const id = await ctx.db.insert("usage", { userId, day, writes: 0, bytes: 0, importBytes: 0 });
  return (await ctx.db.get(id))!;
}

/** One change by an account (any connection of the person: their own sign-in, agents and keys alike). */
export async function chargeWrite(ctx: MutationCtx, userId: string, bytes: number) {
  const row = await usageRow(ctx, userId);
  if (row.writes + 1 > limit(1, DAILY_WRITES) || row.bytes + bytes > limit(2, DAILY_WRITE_BYTES)) {
    fail("rate_limited", `This account has reached today's limit of ${limit(1, DAILY_WRITES).toLocaleString("en-GB")} changes or ${MB(limit(2, DAILY_WRITE_BYTES))} of written text on Planban Online. It resets at midnight UTC.`);
  }
  await ctx.db.patch(row._id, { writes: row.writes + 1, bytes: row.bytes + bytes });
}

/** Text arriving through Take Online. */
export async function chargeImport(ctx: MutationCtx, userId: string, bytes: number) {
  const row = await usageRow(ctx, userId);
  if (row.importBytes + bytes > limit(3, DAILY_IMPORT_BYTES)) {
    fail("rate_limited", `This account has reached today's limit of ${MB(limit(3, DAILY_IMPORT_BYTES))} taken online. It resets at midnight UTC.`);
  }
  await ctx.db.patch(row._id, { importBytes: row.importBytes + bytes });
}
