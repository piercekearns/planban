import { v } from "convex/values";
import { makeFunctionReference } from "convex/server";
import { internalAction, internalMutation, internalQuery, type ActionCtx } from "./_generated/server";
import { USAGE_POLICY, USAGE_CLOUD, collectionFailure, usageEnabled, mailEnabled, parseUsage, emptyMonitor, observeUsage, expiryNoticeDue, expiryNoticePayload, finishUsage, canSend, monitorStale, type MonitorState, type Reading, type Batch } from "./model/providerUsage";

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

const expiryStateRef = makeFunctionReference<"query">("providerUsage:monitorState");
const expiryNotedRef = makeFunctionReference<"mutation">("providerUsage:noteExpiryNotice");

export const monitorState = internalQuery({ args: {}, handler: async (ctx): Promise<MonitorState> => {
  const row = await ctx.db.query("providerUsageMonitors").withIndex("by_policy", q => q.eq("policy", USAGE_POLICY)).unique();
  return row?.state ?? emptyMonitor();
} });

export const noteExpiryNotice = internalMutation({
  args: { expiry: v.number() },
  handler: async (ctx, { expiry }) => {
    if (!usageEnabled(process.env)) return;
    const row = await ctx.db.query("providerUsageMonitors").withIndex("by_policy", q => q.eq("policy", USAGE_POLICY)).unique();
    const state: MonitorState = row?.state ?? emptyMonitor();
    state.expiryNoticeFor = expiry;
    if (row) await ctx.db.patch(row._id, { state }); else await ctx.db.insert("providerUsageMonitors", { policy: USAGE_POLICY, state });
  },
});

/** Reminds hello@planban.ai once, a week before the usage key expires. The key is the idempotency key, so a retry is never a second email. */
async function remindBeforeExpiry(ctx: Pick<ActionCtx, "runMutation" | "runQuery">) {
  if (!mailEnabled(process.env)) return;
  const state = await ctx.runQuery(expiryStateRef, {}) as MonitorState;
  const expiry = expiryNoticeDue(process.env, state, Date.now());
  if (expiry === null) return;
  const response = await fetch("https://api.resend.com/emails", { method: "POST", redirect: "error",
    headers: { Authorization: `Bearer ${process.env.PLANBAN_USAGE_EMAIL_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `planban-usage-key-expiry-${expiry}` },
    body: expiryNoticePayload(expiry), signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (response?.ok) await ctx.runMutation(expiryNotedRef, { expiry });
  else await response?.body?.cancel();
}

/** Internal operational inspection; no dashboard, public tool or credential. */
export const status = internalQuery({ args: {}, handler: async ctx => {
  if (!usageEnabled(process.env)) return { enabled: false };
  const row = await ctx.db.query("providerUsageMonitors").withIndex("by_policy", q => q.eq("policy", USAGE_POLICY)).unique();
  const state: MonitorState = row?.state ?? emptyMonitor();
  return { enabled: true, reason: state.status ?? "not_observed", stale: monitorStale(state, Date.now()),
    lastAttemptAt: state.lastAttemptAt ?? null, observedAt: state.lastSuccess?.at ?? null,
    month: state.lastSuccess?.month ?? null, heldBatches: state.batches.filter(b => b.status === "held").length };
} });

export async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try { part = await reader.read(); } catch (error) {
        if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw error;
        throw new Error("body_failure");
      }
      const { done, value } = part; if (done) break;
      size += value.length; if (size > 16384) throw new Error("oversized_response"); chunks.push(value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function runUsagePoll(ctx: Pick<ActionCtx, "runMutation"> & Partial<Pick<ActionCtx, "runQuery">>): Promise<string> {
  if (!usageEnabled(process.env)) return "disabled";
  const credentialFailure = collectionFailure(process.env, Date.now());
  if (credentialFailure) {
    await ctx.runMutation(observeRef, { reading: null, status: credentialFailure, now: Date.now() });
    return credentialFailure;
  }
  if (ctx.runQuery) await remindBeforeExpiry(ctx as Pick<ActionCtx, "runMutation" | "runQuery">).catch(() => undefined);
  const started = Date.now(); let reading: Reading | null = null; let status = "unavailable";
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`${USAGE_CLOUD}/api/v1/get_current_usage`, { headers: { Authorization: `Convex ${process.env.PLANBAN_USAGE_READ_KEY}` }, redirect: "error", signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); throw new Error([401, 403].includes(response.status) ? "usage_unauthorized" : "usage_unavailable"); }
    reading = parseUsage(await boundedJson(response), started, Date.now()); status = "complete";
  } catch (error) {
    const reasons = ["incomplete_reading", "invalid_metrics", "unknown_metric", "invalid_measurement", "month_changed", "invalid_response", "oversized_response", "body_failure", "usage_unauthorized", "usage_unavailable"];
    if (error instanceof Error && reasons.includes(error.message)) status = error.message;
    else if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) status = "timeout";
    else if (error instanceof SyntaxError) status = "invalid_json";
  } finally { clearTimeout(timer); }
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
