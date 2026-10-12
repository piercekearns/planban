// Who last changed each card, kept beside the board so a card that has been
// quiet for a long time still shows its face after older history is trimmed
// (owner decision 15: on shared boards every card shows who last changed it).
import type { MutationCtx } from "../_generated/server";
import type { PlanbanRoadmap } from "../../../../src/core/types";
import type { BoardRows } from "./history";

export interface CardChange {
  userId: string;
  /** True when the person's agent made the change. */
  agent: boolean;
  clientName: string | null;
  at: string;
  summary: string;
}

/** Records a change to these cards. */
export async function noteCardChanges(ctx: MutationCtx, at: BoardRows, cardIds: Iterable<string>, change: CardChange) {
  for (const cardId of new Set(cardIds)) {
    const row = await ctx.db.query("cardChanges").withIndex("by_board_generation_card", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation).eq("cardId", cardId)).unique();
    if (row) await ctx.db.patch(row._id, change);
    else await ctx.db.insert("cardChanges", { ...at, cardId, ...change });
  }
}

/**
 * After Take Online: each card's latest change from the history it arrived
 * with. Versions made in Local Mode carry no account, so they are the
 * owner's (or the owner's agents'); cards with no history are the owner's.
 */
export async function seedCardChanges(ctx: MutationCtx, at: BoardRows, roadmap: PlanbanRoadmap, ownerId: string, now: string) {
  const pending = new Set(roadmap.roadmapItems.map((item) => item.id));
  for await (const row of ctx.db.query("history").withIndex("by_board_version", (q) => q.eq("boardId", at.boardId).eq("generation", at.generation)).order("desc")) {
    if (pending.size === 0) break;
    const entry = row.entry as { createdAt: string; actor: string; summary: string; affectedCards?: string[]; affectedDocs?: Array<{ cardId: string }>; attribution?: { userId: string; clientName: string; actor: string } };
    const change: CardChange = entry.attribution
      ? { userId: entry.attribution.userId, agent: entry.attribution.actor === "agent", clientName: entry.attribution.actor === "agent" ? entry.attribution.clientName : null, at: entry.createdAt, summary: entry.summary }
      : { userId: ownerId, agent: entry.actor === "agent", clientName: null, at: entry.createdAt, summary: entry.summary };
    const touched = [...(entry.affectedCards ?? []), ...(entry.affectedDocs ?? []).map((doc) => doc.cardId)].filter((cardId) => pending.delete(cardId));
    if (touched.length) await noteCardChanges(ctx, at, touched, change);
  }
  if (pending.size) await noteCardChanges(ctx, at, pending, { userId: ownerId, agent: false, clientName: null, at: now, summary: "Took the board online" });
}
