import { Sha256 } from "./sha256";

// Provisioning evidence binds this policy to one nondefault development target.
export const USAGE_POLICY = "planban-547105-3200106-hardy-tortoise-315-v1";
export const USAGE_CLOUD = "https://hardy-tortoise-315.eu-west-1.convex.cloud";
export const USAGE_SITE = "https://hardy-tortoise-315.eu-west-1.convex.site";
export const USAGE_DASHBOARD = "https://dashboard.convex.dev/t/pierce-kearns-73417/usage";
export const HOUR = 3600000;
export const LEASE = 60000;
export const RETRY_WINDOW = 23 * HOUR; // Provider idempotency lasts 24 hours.
const MAX_BATCHES = 104;
const DEFINITIONS = {
  calls: { label: "Function calls", unit: "calls", included: 1000000 },
  actions: { label: "Action compute", unit: "GB-hours", included: 20 },
  io: { label: "Database I/O", unit: "GB", included: 1 },
  egress: { label: "Data egress", unit: "GB", included: 1 },
} as const;
export type Metric = keyof typeof DEFINITIONS;
export type Reading = { month: string; at: number; values: Record<Metric, number> };
export type Event = { metric: Metric; level: 70 | 90 };
export type Batch = {
  id: string; month: string; events: Event[]; payload: string; hash: string;
  firstAttemptAt: number; retryUntil: number; attempts: number; fence: number; leaseUntil: number;
  status: "sending" | "retry" | "sent" | "held";
};
export type MonitorState = {
  lastAttemptAt?: number; lastSuccess?: Reading; status?: string;
  covered: Record<string, true>; batches: Batch[];
};
export const emptyMonitor = (): MonitorState => ({ covered: {}, batches: [] });
export const utcMonth = (now: number) => new Date(now).toISOString().slice(0, 7);

type Settings = Record<string, string | undefined>;
export function usageEnabled(env: Settings): boolean {
  return env.PLANBAN_USAGE_ENABLED === "1" && env.PLANBAN_USAGE_POLICY === USAGE_POLICY
    && env.CONVEX_CLOUD_URL === USAGE_CLOUD && env.CONVEX_SITE_URL === USAGE_SITE;
}
export function collectionConfigured(env: Settings, now: number): boolean {
  const expiry = Number(env.PLANBAN_USAGE_KEY_EXPIRES_AT);
  return usageEnabled(env) && !!env.PLANBAN_USAGE_READ_KEY && Number.isFinite(expiry) && expiry > now;
}
export function mailEnabled(env: Settings): boolean {
  return usageEnabled(env) && env.PLANBAN_USAGE_EMAIL_ENABLED === "1" && !!env.PLANBAN_USAGE_EMAIL_KEY;
}

/** Unknown and missing measures are never silently interpreted as zero. */
export function parseUsage(body: unknown, started: number, ended: number): Reading {
  if (utcMonth(started) !== utcMonth(ended) || ended < started) throw new Error("month_changed");
  const data = body as { seedStatus?: unknown; metrics?: Record<string, any> };
  if (!data || data.seedStatus !== "complete") throw new Error("incomplete_reading");
  if (!data.metrics || typeof data.metrics !== "object" || Array.isArray(data.metrics)) throw new Error("invalid_metrics");
  const excluded = new Set(["actionComputeCpuGbHours", "aiGatewayCostDollars", "queryMutationComputeGbHours", "searchQueryGb"]);
  const required: Record<string, string> = { functionCalls: "calls", actionComputeConvexGbHours: "GB-hours", actionComputeNodeJsGbHours: "GB-hours", databaseIoGb: "GB", dataEgressGb: "GB" };
  if (Object.keys(data.metrics).some(k => !Object.hasOwn(required, k) && !excluded.has(k))) throw new Error("unknown_metric");
  const value = (name: string) => {
    const item = data.metrics![name], n = item?.usage?.current_month;
    if (item?.unit !== required[name] || typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error("invalid_measurement");
    return n;
  };
  const calls = value("functionCalls"), actions = value("actionComputeConvexGbHours") + value("actionComputeNodeJsGbHours");
  if (!Number.isSafeInteger(calls) || !Number.isFinite(actions)) throw new Error("invalid_measurement");
  return { month: utcMonth(ended), at: ended, values: { calls, actions, io: value("databaseIoGb"), egress: value("dataEgressGb") } };
}

const key = (month: string, event: Event) => `${month}/${event.metric}/${event.level}`;
const qualifies = (reading: Reading, e: Event) => reading.values[e.metric] >= DEFINITIONS[e.metric].included * e.level / 100;
const hash = (text: string) => { const sha = new Sha256(); sha.update(new TextEncoder().encode(text)); return sha.hex(); };
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Immutable bytes contain only validated provider amounts and fixed policy copy. */
export function warningPayload(reading: Reading, events: Event[]): string {
  const rows = events.map(e => `${DEFINITIONS[e.metric].label}: ${reading.values[e.metric]} ${DEFINITIONS[e.metric].unit} (${e.level}% warning; shared team inclusion ${DEFINITIONS[e.metric].included} ${DEFINITIONS[e.metric].unit}).`);
  const [year, month] = reading.month.split("-").map(Number);
  const resets = new Date(Date.UTC(year!, month!, 1)).toISOString();
  const text = ["Planban staging included-usage warning", "", ...rows, "", "These are this development deployment's contributions against shared team inclusions. Team coverage is incomplete; this is not a team total or remaining balance.", "Starter use beyond included amounts can incur charges. Resource warnings do not stop service. Native $10 spending warning and $20 usage disable remain separate; seat fees are excluded.", `Observed: ${new Date(reading.at).toISOString()}. Calendar month: ${reading.month}; resets ${resets}.`, "Storage, search and AI Gateway are not covered.", USAGE_DASHBOARD].join("\n");
  const html = `<html lang="en"><body style="font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;color:#0d0d0d"><h1 style="font-size:22px">Planban usage warning</h1><div style="white-space:pre-wrap;line-height:1.6">${escape(text)}</div></body></html>`;
  return JSON.stringify({ from: "Planban <alerts@planban.ai>", to: ["hello@planban.ai"], subject: "[Planban staging] Included-usage warning", text, html });
}

/** Transactional state transition; caller persists it before any external send. */
export function observeUsage(state: MonitorState, reading: Reading | null, status: string, now: number, email: boolean): Batch | null {
  state.lastAttemptAt = now; state.status = status;
  if (!reading || reading.month !== utcMonth(now) || reading.at > now || now - reading.at > 60000) return null;
  state.lastSuccess = reading;
  // Keep sent suppression throughout its month; never discard ambiguous work.
  const cutoff = new Date(now); cutoff.setUTCMonth(cutoff.getUTCMonth() - 13);
  const oldest = utcMonth(cutoff.getTime());
  state.batches = state.batches.filter(b => b.status !== "sent" || b.month >= oldest);
  for (const k of Object.keys(state.covered)) if (k.slice(0, 7) < oldest) delete state.covered[k];
  for (const b of state.batches) {
    if (b.status === "sent" || b.status === "held") continue;
    if (b.status === "sending" && b.leaseUntil > now) continue;
    if (b.month !== reading.month || now >= b.retryUntil || b.attempts >= 3) { b.status = "held"; continue; }
    if (!email || !b.events.every(e => qualifies(reading, e))) continue;
    b.fence++; b.attempts++; b.leaseUntil = now + LEASE; b.status = "sending";
    return structuredClone(b);
  }
  if (!email) { state.status = "delivery_disabled"; return null; }
  if (state.batches.length >= MAX_BATCHES) { state.status = "retention_review_required"; return null; }
  const events: Event[] = [];
  for (const metric of Object.keys(DEFINITIONS) as Metric[]) {
    const level = reading.values[metric] >= DEFINITIONS[metric].included * .9 ? 90 : reading.values[metric] >= DEFINITIONS[metric].included * .7 ? 70 : null;
    if (level === null) continue;
    const e = { metric, level } as Event;
    if (state.covered[key(reading.month, e)] || state.batches.some(b => b.month === reading.month && b.events.some(x => x.metric === metric && x.level === level))) continue;
    events.push(e);
  }
  if (!events.length) return null;
  const payload = warningPayload(reading, events), digest = hash(payload);
  const b: Batch = { id: `${USAGE_POLICY}/${reading.month}/${hash(JSON.stringify(events))}`, month: reading.month, events, payload, hash: digest, firstAttemptAt: now, retryUntil: now + RETRY_WINDOW, attempts: 1, fence: 1, leaseUntil: now + LEASE, status: "sending" };
  for (const e of events) if (e.level === 90) state.covered[key(reading.month, { metric: e.metric, level: 70 })] = true;
  state.batches.push(b); return structuredClone(b);
}

export function finishUsage(state: MonitorState, id: string, fence: number, outcome: "sent" | "retry" | "held", now: number): void {
  const b = state.batches.find(b => b.id === id);
  if (!b || b.fence !== fence || b.status !== "sending") return;
  b.status = outcome === "retry" && (now >= b.retryUntil || b.attempts >= 3) ? "held" : outcome;
  b.leaseUntil = 0;
  if (b.status === "sent") for (const e of b.events) state.covered[key(b.month, e)] = true;
}

export function canSend(batch: Batch, env: Settings, now: number): boolean {
  return mailEnabled(env) && batch.month === utcMonth(now) && now < batch.retryUntil && now < batch.leaseUntil && hash(batch.payload) === batch.hash;
}
export const monitorStale = (state: MonitorState, now: number) => !state.lastSuccess || now - state.lastSuccess.at >= 3 * HOUR;
