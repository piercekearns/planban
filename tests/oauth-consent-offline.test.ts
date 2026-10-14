import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { consentPage } from "../online/service/convex/model/oauthConsentPage";

/** Runs the consent page's own script against a minimal browser: elements, events, Clerk and fetch. */
function browser() {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { id, hidden: false, disabled: false, textContent: "", listeners: {} as Record<string, Function>, addEventListener(type: string, fn: Function) { this.listeners[type] = fn; } });
    return elements.get(id);
  };
  const windowListeners: Record<string, Function[]> = {};
  const validityCalls: number[] = [];
  let now = 1_000;
  const context: any = {
    document: { hidden: false, getElementById: element, addEventListener() {} },
    window: { addEventListener: (type: string, fn: Function) => (windowListeners[type] ??= []).push(fn), location: { assign() {} }, __internal_ClerkUICtor: {} },
    navigator: { onLine: true },
    performance: { now: () => now },
    setTimeout: () => 0, setInterval: () => 0,
    AbortSignal: { timeout: () => undefined },
    URLSearchParams, Error, Number, Math, JSON, Infinity,
    Clerk: {
      session: { status: "active", getToken: async () => "token" }, user: { primaryEmailAddress: { emailAddress: "a@example.com" } },
      load: async () => {}, addListener() {}, mountSignIn() {}, unmountSignIn() {}, mountSignUp() {}, unmountSignUp() {},
    },
    fetch: async (path: string) => {
      if (path === "/oauth/validity") {
        validityCalls.push(now);
        if (!context.navigator.onLine) throw new TypeError("Failed to fetch");
        return { ok: true, json: async () => ({ valid: true, serverNow: 0, expiresAt: 300_000 }) };
      }
      throw new Error(`unexpected fetch ${path}`);
    },
  };
  const fire = async (type: string) => { for (const fn of windowListeners[type] ?? []) await fn(); await new Promise((resolve) => setImmediate(resolve)); };
  return { context, element, fire, validityCalls, tick: (ms: number) => { now += ms; } };
}

const html = consentPage({ nonce: "n", frontend: "https://clerk.example", key: "pk_test_x", returnTo: "/oauth/consent?request=r", secret: "pbe_x", csrf: "pbs_x", clientName: "Planban CLI", clientId: "planban-cli", permission: "Plan and complete", machine: true, offline: false });
const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)![1]!;

test("Allow is unavailable the moment the browser goes offline, and returns only after a fresh check online", async () => {
  const page = browser();
  createContext(page.context);
  runInContext(script, page.context);
  await page.fire("load");
  const allow = page.element("allow"), deny = page.element("deny"), status = page.element("status");
  assert.equal(allow.disabled, false, "a verified request can be allowed");
  const checksBefore = page.validityCalls.length;

  page.context.navigator.onLine = false;
  await page.fire("offline");
  assert.equal(allow.disabled, true, "offline: Allow is unavailable at once");
  assert.equal(deny.disabled, true);
  assert.match(status.textContent, /You’re offline\. Allow comes back when you reconnect\./);
  // Focus or a timed check while offline doesn't bring it back or call the service.
  await page.fire("focus");
  assert.equal(allow.disabled, true);
  assert.equal(page.validityCalls.length, checksBefore);
  // Clicking Allow while offline does nothing.
  await allow.listeners.click();
  assert.equal(allow.disabled, true);

  page.context.navigator.onLine = true;
  await page.fire("online");
  assert.equal(page.validityCalls.length, checksBefore + 1, "reconnecting checks the request again");
  assert.equal(allow.disabled, false, "and Allow returns once that check passes");
  assert.equal(status.textContent, "");
});

test("a page that opens while offline starts with Allow unavailable", async () => {
  const page = browser();
  page.context.navigator.onLine = false;
  createContext(page.context);
  runInContext(script, page.context);
  await page.fire("load");
  assert.equal(page.element("allow").disabled, true);
  assert.match(page.element("status").textContent, /You’re offline/);
});
