// The public address's Worker requests (Planban 2.0 plan, phase 5): read
// hourly from Cloudflare on production only, with one warning per level per
// UTC day at 70% and 90% of the Free plan's 100,000 a day.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { memoryService } from "./hosted-harness";
import * as providerUsage from "../online/service/convex/providerUsage";
import { USAGE_CLOUD, USAGE_POLICY, USAGE_SITE } from "../online/service/convex/model/providerUsage";
import { emptyWorkerUsage, noteWorkerWarning, observeWorkerUsage, parseWorkerRequests, workerUsageConfigured, workerUsageRequest, workerWarningPayload, WORKER_DAILY_INCLUDED, WORKER_SCRIPT } from "../online/service/convex/model/workerUsage";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const production = {
  PLANBAN_USAGE_ENABLED: "1", PLANBAN_USAGE_POLICY: USAGE_POLICY, CONVEX_CLOUD_URL: USAGE_CLOUD, CONVEX_SITE_URL: USAGE_SITE,
  PLANBAN_WORKER_USAGE_TOKEN: "synthetic-analytics-read", PLANBAN_WORKER_USAGE_ACCOUNT: ACCOUNT,
  PLANBAN_USAGE_EMAIL_ENABLED: "1", PLANBAN_USAGE_EMAIL_KEY: "synthetic-mail",
};
const NOON = Date.parse("2026-10-14T12:00:00Z");
const answer = (...requests: number[]) => ({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: requests.map((value) => ({ sum: { requests: value } })) }] } } });

test("only production, with an analytics key and its account, reads the Worker's requests", () => {
  assert.equal(workerUsageConfigured(production), true);
  assert.equal(workerUsageConfigured({ ...production, PLANBAN_WORKER_USAGE_TOKEN: "" }), false);
  assert.equal(workerUsageConfigured({ ...production, PLANBAN_WORKER_USAGE_ACCOUNT: "not-an-account" }), false);
  assert.equal(workerUsageConfigured({ ...production, CONVEX_CLOUD_URL: "https://staging.convex.cloud" }), false, "staging stays off");
});

test("the request asks for this Worker's requests over today's UTC day", () => {
  const body = JSON.parse(workerUsageRequest(ACCOUNT, NOON));
  assert.deepEqual(body.variables, { account: ACCOUNT, script: WORKER_SCRIPT, start: "2026-10-14T00:00:00Z", end: "2026-10-15T00:00:00Z" });
  assert.match(body.query, /workersInvocationsAdaptive/u);
});

test("an answer is summed, and anything unexpected is an error, never zero", () => {
  assert.equal(parseWorkerRequests(answer(40_000, 2_500)), 42_500);
  assert.equal(parseWorkerRequests(answer()), 0, "no requests yet today");
  for (const bad of [{ errors: [{ message: "x" }] }, {}, { data: { viewer: { accounts: [] } } }, answer(-1), answer(1.5), { data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: {} }] }] } } }]) {
    assert.throws(() => parseWorkerRequests(bad), /worker_usage_/u, JSON.stringify(bad));
  }
});

test("warns at 70% and again at 90%, once each per UTC day", () => {
  const state = emptyWorkerUsage();
  assert.equal(observeWorkerUsage(state, WORKER_DAILY_INCLUDED * 0.69, "complete", NOON), null);
  assert.equal(observeWorkerUsage(state, WORKER_DAILY_INCLUDED * 0.7, "complete", NOON), 70);
  assert.equal(observeWorkerUsage(state, WORKER_DAILY_INCLUDED * 0.75, "complete", NOON), 70, "until the email is accepted it is tried again");
  noteWorkerWarning(state, "2026-10-14", 70);
  assert.equal(observeWorkerUsage(state, WORKER_DAILY_INCLUDED * 0.8, "complete", NOON), null);
  assert.equal(observeWorkerUsage(state, WORKER_DAILY_INCLUDED * 0.95, "complete", NOON), 90);
  noteWorkerWarning(state, "2026-10-14", 90);
  assert.equal(observeWorkerUsage(state, WORKER_DAILY_INCLUDED, "complete", NOON), null);
  const tomorrow = NOON + 86_400_000;
  assert.equal(observeWorkerUsage(state, WORKER_DAILY_INCLUDED * 0.7, "complete", tomorrow), 70, "a new day warns again");
  observeWorkerUsage(state, 0, "complete", tomorrow + 2 * 86_400_000);
  assert.deepEqual(Object.keys(state.warned), [], "old days are forgotten");
  assert.equal(observeWorkerUsage(state, null, "timeout", NOON), null);
  assert.equal(state.status, "timeout");
  const fresh = emptyWorkerUsage();
  noteWorkerWarning(fresh, "2026-10-14", 90);
  assert.equal(observeWorkerUsage(fresh, WORKER_DAILY_INCLUDED * 0.72, "complete", NOON), null, "90 covers 70");
});

test("the warning names the count, the level and the free daily amount", () => {
  const payload = JSON.parse(workerWarningPayload(71_234, 70, NOON));
  assert.deepEqual(payload.to, ["hello@planban.ai"]);
  assert.match(payload.subject, /Worker requests at 70%/u);
  assert.match(payload.text, /71,234 Worker requests today \(2026-10-14, UTC\)/u);
  assert.match(payload.text, /100,000 a day/u);
});

test("the hourly check reads Cloudflare, warns once, and stays quiet afterwards", async () => {
  const prior = Object.fromEntries(Object.keys(production).map((name) => [name, process.env[name]]));
  Object.assign(process.env, production);
  const original = globalThis.fetch;
  const sent: Array<{ url: string; key: string | null; body: string }> = [];
  let requests = 72_000;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    sent.push({ url, key: headers.get("Idempotency-Key"), body: String(init?.body ?? "") });
    if (url === "https://api.cloudflare.com/client/v4/graphql") {
      assert.equal(headers.get("Authorization"), "Bearer synthetic-analytics-read");
      return new Response(JSON.stringify(answer(requests)), { status: 200 });
    }
    if (url === "https://api.resend.com/emails") return new Response(JSON.stringify({ id: "email-1" }), { status: 200 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const { ctx } = memoryService();
    const byName: Record<string, any> = { "providerUsage:observeWorker": providerUsage.observeWorker, "providerUsage:noteWorker": providerUsage.noteWorker };
    const actionCtx = { runMutation: async (ref: any, args: any) => byName[getFunctionName(ref)]._handler(ctx, args) };
    assert.equal(await providerUsage.runWorkerUsagePoll(actionCtx as any, NOON), "sent");
    const mails = sent.filter((entry) => entry.url.includes("resend"));
    assert.equal(mails.length, 1);
    assert.equal(mails[0]!.key, "planban-worker-requests-2026-10-14-70");
    assert.equal(await providerUsage.runWorkerUsagePoll(actionCtx as any, NOON + 3_600_000), "complete", "already warned today");
    requests = 91_000;
    assert.equal(await providerUsage.runWorkerUsagePoll(actionCtx as any, NOON + 7_200_000), "sent");
    assert.equal(sent.filter((entry) => entry.url.includes("resend")).length, 2);
    process.env.PLANBAN_WORKER_USAGE_TOKEN = "";
    assert.equal(await providerUsage.runWorkerUsagePoll(actionCtx as any, NOON), "disabled");
  } finally {
    globalThis.fetch = original;
    for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});
