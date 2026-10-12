import assert from "node:assert/strict";
import { test } from "node:test";
import { USAGE_POLICY, USAGE_CLOUD, USAGE_SITE, HOUR, LEASE, RETRY_WINDOW, collectionConfigured, usageEnabled, mailEnabled, parseUsage, utcMonth, emptyMonitor, observeUsage, finishUsage, canSend, monitorStale, type Reading } from "../online/service/convex/model/providerUsage";
import { boundedJson, runUsagePoll } from "../online/service/convex/providerUsage";

const now = Date.UTC(2026, 9, 12, 12);
const env = () => ({ PLANBAN_USAGE_ENABLED: "1", PLANBAN_USAGE_POLICY: USAGE_POLICY, CONVEX_CLOUD_URL: USAGE_CLOUD, CONVEX_SITE_URL: USAGE_SITE, PLANBAN_USAGE_READ_KEY: "synthetic-usage-only", PLANBAN_USAGE_KEY_EXPIRES_AT: String(now + 30 * 24 * HOUR), PLANBAN_USAGE_EMAIL_ENABLED: "1", PLANBAN_USAGE_EMAIL_KEY: "synthetic-alert-only" });
const body = () => ({ seedStatus: "complete", metrics: {
  functionCalls: { unit: "calls", usage: { current_month: 700000 } },
  actionComputeConvexGbHours: { unit: "GB-hours", usage: { current_month: 5 } },
  actionComputeNodeJsGbHours: { unit: "GB-hours", usage: { current_month: 1 } },
  databaseIoGb: { unit: "GB", usage: { current_month: .1 } },
  dataEgressGb: { unit: "GB", usage: { current_month: .1 } },
  actionComputeCpuGbHours: { unit: "GB-hours", usage: { current_month: 500 } },
} });
const reading = (calls = 700000, at = now): Reading => ({ month: utcMonth(at), at, values: { calls, actions: 6, io: .1, egress: .1 } });

test("complete provider readings validate constituent units, known exclusions and calendar boundaries without coercion", () => {
  assert.equal(parseUsage(body(), now, now + 5).values.actions, 6, "CPU compute is excluded");
  for (const seedStatus of [undefined, "pending", "partial", "failed"]) assert.throws(() => parseUsage({ ...body(), seedStatus }, now, now));
  for (const value of [undefined, "700000", -1, Infinity, NaN, .5, Number.MAX_SAFE_INTEGER + 1]) {
    const b: any = body(); b.metrics.functionCalls.usage.current_month = value; assert.throws(() => parseUsage(b, now, now));
  }
  for (const name of ["functionCalls", "actionComputeConvexGbHours", "actionComputeNodeJsGbHours", "databaseIoGb", "dataEgressGb"]) {
    const b: any = body(); delete b.metrics[name]; assert.throws(() => parseUsage(b, now, now));
    const c: any = body(); c.metrics[name].unit = "bytes"; assert.throws(() => parseUsage(c, now, now));
  }
  const b: any = body(); b.metrics.newMetric = { unit: "calls", usage: { current_month: 0 } }; assert.throws(() => parseUsage(b, now, now), /unknown_metric/);
  const c = body(); c.metrics.actionComputeConvexGbHours.usage.current_month = Number.MAX_VALUE; c.metrics.actionComputeNodeJsGbHours.usage.current_month = Number.MAX_VALUE;
  assert.throws(() => parseUsage(c, now, now));
  assert.throws(() => parseUsage(body(), Date.UTC(2026, 9, 31, 23, 59, 59), Date.UTC(2026, 10, 1)), /month_changed/);
});

test("monitor and mail require explicit opt-in, exact executing deployment and an unexpired separate usage credential", async () => {
  assert.equal(usageEnabled({}), false); assert.equal(mailEnabled({}), false);
  assert.equal(collectionConfigured(env(), now), true);
  for (const patch of [{ CONVEX_CLOUD_URL: "http://127.0.0.1:3410" }, { CONVEX_SITE_URL: "https://unrelated.convex.site" }, { PLANBAN_USAGE_POLICY: "production" }, { PLANBAN_USAGE_ENABLED: "0" }]) {
    assert.equal(usageEnabled({ ...env(), ...patch }), false);
  }
  assert.equal(collectionConfigured({ ...env(), PLANBAN_USAGE_KEY_EXPIRES_AT: String(now) }, now), false);
  assert.equal(collectionConfigured({ ...env(), PLANBAN_USAGE_READ_KEY: "" }, now), false);
  assert.equal(mailEnabled({ ...env(), PLANBAN_USAGE_EMAIL_ENABLED: "0" }), false);
});

test("actual cron export leaves the monitor absent by default and requires a coordinated bound deployment", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.PLANBAN_USAGE_ENABLED;
    const disabled = await import("../online/service/convex/crons.ts?usage-default");
    assert.ok(!disabled.default.export().includes("Planban included usage warnings"));
    Object.assign(process.env, env());
    const enabled = await import("../online/service/convex/crons.ts?usage-bound");
    assert.ok(enabled.default.export().includes("Planban included usage warnings"));
    process.env.CONVEX_CLOUD_URL = "http://127.0.0.1:3410";
    const copied = await import("../online/service/convex/crons.ts?usage-copied");
    assert.ok(!copied.default.export().includes("Planban included usage warnings"));
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved);
  }
});

test("disabled-mail observations never flush stale or old-month warnings; enabling uses fresh highest qualifying levels", () => {
  const s = emptyMonitor(); assert.equal(observeUsage(s, reading(), "complete", now, false), null);
  assert.equal(s.batches.length, 0);
  assert.equal(observeUsage(s, null, "unavailable", now + HOUR, true), null);
  assert.equal(observeUsage(s, reading(), "complete", now + HOUR, true), null, "cached snapshot cannot trigger mail");
  assert.equal(observeUsage(s, reading(100, now + HOUR), "complete", now + HOUR, true), null);
  const b = observeUsage(s, reading(900000, now + 2 * HOUR), "complete", now + 2 * HOUR, true)!;
  assert.deepEqual(b.events, [{ metric: "calls", level: 90 }]);
  finishUsage(s, b.id, b.fence, "sent", now + 2 * HOUR);
  assert.equal(observeUsage(s, reading(700000, now + 3 * HOUR), "complete", now + 3 * HOUR, true), null);
  const next = Date.UTC(2026, 10, 1);
  assert.ok(observeUsage(s, reading(700000, next), "complete", next, true), "new UTC month re-arms");
  assert.equal(s.lastSuccess?.month, "2026-11");
});

test("lost acknowledgments retry identical immutable bytes/key under a new fence and never expand attempted membership", () => {
  const s = emptyMonitor(), first = observeUsage(s, reading(), "complete", now, true)!;
  assert.equal(observeUsage(s, reading(700000, now + 1), "complete", now + 1, true), null, "serialized concurrent claim cannot duplicate");
  const later = reading(900000, now + LEASE + 1); later.values.io = .9;
  const retry = observeUsage(s, later, "complete", later.at, true)!;
  assert.equal(retry.id, first.id); assert.equal(retry.payload, first.payload); assert.equal(retry.hash, first.hash);
  assert.deepEqual(retry.events, first.events); assert.equal(retry.fence, 2);
  finishUsage(s, first.id, first.fence, "sent", later.at); assert.equal(s.batches[0]?.status, "sending", "old lease cannot commit");
  finishUsage(s, retry.id, retry.fence, "sent", later.at);
  const high = observeUsage(s, later, "complete", later.at, true)!;
  assert.notEqual(high.id, first.id); assert.deepEqual(high.events, [{ metric: "calls", level: 90 }, { metric: "io", level: 90 }]);
});

test("ambiguous batches are held after bounded attempts or idempotency expiry; month rollover preserves in-flight outcomes", () => {
  const s = emptyMonitor(); let b = observeUsage(s, reading(), "complete", now, true)!;
  for (let i = 1; i < 3; i++) { finishUsage(s, b.id, b.fence, "retry", now + i); b = observeUsage(s, reading(700000, now + i * HOUR), "complete", now + i * HOUR, true)!; }
  finishUsage(s, b.id, b.fence, "retry", now + 2 * HOUR);
  assert.equal(s.batches[0]?.status, "held"); assert.equal(observeUsage(s, reading(700000, now + 3 * HOUR), "complete", now + 3 * HOUR, true), null);
  const expired = emptyMonitor(), old = observeUsage(expired, reading(), "complete", now, true)!;
  assert.equal(observeUsage(expired, reading(700000, now + RETRY_WINDOW), "complete", now + RETRY_WINDOW, true), null);
  assert.equal(expired.batches[0]?.status, "held");
  const boundary = Date.UTC(2026, 9, 31, 23, 59, 50), crossing = emptyMonitor(), inflight = observeUsage(crossing, reading(700000, boundary), "complete", boundary, true)!;
  const midnight = Date.UTC(2026, 10, 1); observeUsage(crossing, reading(0, midnight), "complete", midnight, true);
  assert.equal(canSend(inflight, env(), midnight), false);
  finishUsage(crossing, inflight.id, inflight.fence, "sent", midnight); assert.equal(crossing.batches[0]?.month, "2026-10"); assert.equal(crossing.batches[0]?.status, "sent");
  assert.ok(monitorStale(s, now + 6 * HOUR)); assert.equal(old.firstAttemptAt, now);
});

test("streamed provider responses stop at the body cap and release their reader", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(16385)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedJson(new Response(stream)), /oversized_response/); assert.ok(cancelled);
});

test("actual action adapter emits no external call while disabled or copied, and incomplete readings never send", async () => {
  const saved = { env: { ...process.env }, fetch: globalThis.fetch, now: Date.now }; let gets = 0, sends = 0, observed: any;
  try {
    Object.assign(process.env, env()); Date.now = () => now;
    globalThis.fetch = async (url) => { if (String(url).includes("resend")) sends++; else gets++; return new Response(JSON.stringify({ ...body(), seedStatus: "partial" }), { status: 200 }); };
    const ctx: any = { runMutation: async (_ref: unknown, args: any) => { observed = args; return null; } };
    process.env.PLANBAN_USAGE_ENABLED = "0"; assert.equal(await runUsagePoll(ctx), "disabled"); assert.equal(gets + sends, 0);
    process.env.PLANBAN_USAGE_ENABLED = "1"; process.env.CONVEX_SITE_URL = "https://foreign.convex.site"; assert.equal(await runUsagePoll(ctx), "disabled"); assert.equal(gets + sends, 0);
    process.env.CONVEX_SITE_URL = USAGE_SITE; assert.equal(await runUsagePoll(ctx), "unavailable"); assert.equal(gets, 1); assert.equal(sends, 0); assert.equal(observed.reading, null);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k]; Object.assign(process.env, saved.env); globalThis.fetch = saved.fetch; Date.now = saved.now;
  }
});

test("warning bytes are content-free and distinguish shared included usage from native spending controls", () => {
  const b = observeUsage(emptyMonitor(), reading(), "complete", now, true)!; const p = JSON.parse(b.payload);
  assert.deepEqual(p.to, ["hello@planban.ai"]); assert.equal(p.from, "Planban <alerts@planban.ai>");
  assert.match(p.text, /Team coverage is incomplete/); assert.match(p.text, /not a team total/); assert.match(p.text, /can incur charges/); assert.match(p.text, /seat fees are excluded/);
  assert.ok(!p.html.includes("<script")); assert.ok(!p.text.includes("synthetic"));
  assert.equal(canSend({ ...b, payload: b.payload + "tampered" }, env(), now), false);
  assert.equal(canSend(b, { ...env(), PLANBAN_USAGE_EMAIL_ENABLED: "0" }, now), false);
});

test("action crash after mocked acceptance retries immutable provider bytes/key and commits only the owning fence", async () => {
  const saved = { env: { ...process.env }, fetch: globalThis.fetch, now: Date.now };
  let clock = now, loseAck = true; const state = emptyMonitor(); const sent: Array<{ payload: string; key: string }> = [];
  try {
    Object.assign(process.env, env()); Date.now = () => clock;
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("resend")) {
        sent.push({ payload: String(init?.body), key: new Headers(init?.headers).get("Idempotency-Key")! });
        return new Response(JSON.stringify({ id: "mock-provider-accepted" }));
      }
      return new Response(JSON.stringify(body()));
    };
    const ctx: any = { runMutation: async (_ref: unknown, args: any) => {
      if ("reading" in args) return observeUsage(state, args.reading, args.status, args.now, mailEnabled(process.env));
      if (loseAck) { loseAck = false; throw new Error("simulated process loss before durable acknowledgement"); }
      finishUsage(state, args.id, args.fence, args.outcome, args.now); return null;
    } };
    await assert.rejects(runUsagePoll(ctx), /simulated process loss/); assert.equal(state.batches[0]?.status, "sending");
    clock += HOUR; assert.equal(await runUsagePoll(ctx), "sent");
    assert.equal(sent.length, 2); assert.deepEqual(sent[0], sent[1], "provider can deduplicate identical retries");
    assert.equal(state.batches[0]?.status, "sent");
    clock += HOUR; await runUsagePoll(ctx); assert.equal(sent.length, 2, "no new key after durable acceptance");
    process.env.PLANBAN_USAGE_EMAIL_ENABLED = "0"; clock += HOUR; await runUsagePoll(ctx); assert.equal(sent.length, 2);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k]; Object.assign(process.env, saved.env); globalThis.fetch = saved.fetch; Date.now = saved.now;
  }
});

test("runtime mail kill switch between persisted claim and provider send prevents the external effect", async () => {
  const saved = { env: { ...process.env }, fetch: globalThis.fetch, now: Date.now }; let sends = 0;
  try {
    Object.assign(process.env, env()); Date.now = () => now;
    globalThis.fetch = async url => { if (String(url).includes("resend")) sends++; return new Response(JSON.stringify(body())); };
    const ctx: any = { runMutation: async (_ref: unknown, args: any) => {
      const b = observeUsage(emptyMonitor(), args.reading, args.status, args.now, true);
      process.env.PLANBAN_USAGE_EMAIL_ENABLED = "0"; return b;
    } };
    assert.equal(await runUsagePoll(ctx), "complete"); assert.equal(sends, 0);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved.env)) delete process.env[k]; Object.assign(process.env, saved.env); globalThis.fetch = saved.fetch; Date.now = saved.now;
  }
});

test("retention holds ambiguous batches and refuses growth at the bound instead of erasing suppression", () => {
  const s = emptyMonitor(), b = observeUsage(s, reading(), "complete", now, true)!;
  finishUsage(s, b.id, b.fence, "held", now);
  s.batches = Array.from({ length: 104 }, (_, i) => ({ ...structuredClone(b), id: `${b.id}/${i}`, month: "2020-01", status: "held" as const }));
  assert.equal(observeUsage(s, reading(900000), "complete", now, true), null);
  assert.equal(s.batches.length, 104); assert.equal(s.status, "retention_review_required");
});
