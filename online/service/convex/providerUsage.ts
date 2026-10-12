import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalAction, internalMutation, type ActionCtx } from "./_generated/server";
import { USAGE_POLICY, USAGE_CLOUD, collectionConfigured, usageEnabled, mailEnabled, parseUsage, emptyMonitor, observeUsage, finishUsage, canSend, type MonitorState, type Reading, type Batch } from "./model/providerUsage";

const observeRef = makeFunctionReference<"mutation">("providerUsage:observe");
const finishRef = makeFunctionReference<"mutation">("providerUsage:finish");

export const observe = internalMutation({
  args: { reading: v.any(), status: v.string(), now: v.number() },
  handler: async (ctx, args): Promise<Batch | null> => {
    if (!usageEnabled(process.env)) return null;
    const row = await ctx.db.query("providerUsageMonitors").withIndex("by_policy", q => q.eq("policy", USAGE_POLICY)).unique();
    const state: MonitorState = row?.state ?? emptyMonitor();
    const batch = observeUsage(state, args.reading as Reading | null, args.status, args.now, mailEnabled(process.env));
    if (row) await ctx.db.patch(row._id, { state }); else await ctx.db.insert("providerUsageMonitors", { policy: USAGE_POLICY, state });
    return batch;
  },
});
export const finish = internalMutation({
  args: { id: v.string(), fence: v.number(), outcome: v.union(v.literal("sent"), v.literal("retry"), v.literal("held")), now: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("providerUsageMonitors").withIndex("by_policy", q => q.eq("policy", USAGE_POLICY)).unique();
    if (!row) return;
    finishUsage(row.state as MonitorState, args.id, args.fence, args.outcome, args.now);
    await ctx.db.patch(row._id, { state: row.state });
  },
});

export async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 16384) throw new Error("oversized_response"); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function runUsagePoll(ctx: Pick<ActionCtx, "runMutation">): Promise<string> {
  if (!collectionConfigured(process.env, Date.now())) return "disabled";
  const started = Date.now(); let reading: Reading | null = null; let status = "unavailable";
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${USAGE_CLOUD}/api/v1/get_current_usage`, { headers: { Authorization: `Convex ${process.env.PLANBAN_USAGE_READ_KEY}` }, redirect: "error", signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error("usage_unavailable"); }
    reading = parseUsage(await boundedJson(response), started, Date.now()); status = "complete";
  } catch { status = "unavailable"; } finally { clearTimeout(timer); }
  if (!usageEnabled(process.env)) return "disabled";
  const batch = await ctx.runMutation(observeRef, { reading, status, now: Date.now() }) as Batch | null;
  if (!batch || !canSend(batch, process.env, Date.now())) return status;
  let outcome: "sent" | "retry" | "held" = "retry";
  try {
    const response = await fetch("https://api.resend.com/emails", { method: "POST", redirect: "error", headers: { Authorization: `Bearer ${process.env.PLANBAN_USAGE_EMAIL_KEY}`, "Content-Type": "application/json", "Idempotency-Key": batch.id }, body: batch.payload, signal: AbortSignal.timeout(10000) });
    if (response.ok) {
      const data = await boundedJson(response) as { id?: unknown };
      outcome = typeof data.id === "string" && data.id ? "sent" : "retry";
    } else {
      await response.body?.cancel();
      if (response.status < 500 && response.status !== 429) outcome = "held";
    }
  } catch { /* Ambiguous response: immutable batch and key remain for bounded retry. */ }
  await ctx.runMutation(finishRef, { id: batch.id, fence: batch.fence, outcome, now: Date.now() });
  return outcome;
}
export const poll = internalAction({ args: {}, handler: runUsagePoll });
