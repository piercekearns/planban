import assert from "node:assert/strict";
import { test } from "node:test";
import { Script } from "node:vm";
import { consentPage } from "../online/service/convex/model/oauthConsentPage";

const page = { nonce: "nonce", frontend: "https://fixture.clerk.example", key: "pk_test_fixture", returnTo: "https://planban.example/oauth/consent?request=pbe_fixture", secret: "pbe_fixture", csrf: "pbs_fixture", clientName: "Planban CLI", clientId: "planban-cli", permission: "Use your full access", machine: true, offline: false };

function browser() {
  const elements = new Map<string, any>();
  const events = new Map<string, () => Promise<void>>();
  const mounts: Array<{ mode: string; props: any }> = [];
  const unmounts: string[] = [];
  let listener = () => {};
  let now = 0, validity: any = true;
  const timers: Array<() => void> = [], requests: string[] = [];
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, textContent: "", callbacks: new Map(), addEventListener(name: string, callback: any) { this.callbacks.set(name, callback); } });
    return elements.get(id);
  };
  const document: any = { hidden: false, getElementById: element, addEventListener: (name: string, cb: any) => events.set(name, cb) };
  const Clerk: any = {
    session: null, user: null, load: async () => {}, addListener: (callback: () => void) => { listener = callback; },
    mountSignIn: (_el: any, props: any) => mounts.push({ mode: "signin", props }),
    mountSignUp: (_el: any, props: any) => mounts.push({ mode: "signup", props }),
    unmountSignIn: () => unmounts.push("signin"), unmountSignUp: () => unmounts.push("signup"),
  };
  const html = consentPage(page);
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)![1]!;
  new Script(script).runInNewContext({ document, window: { addEventListener: (name: string, cb: any) => events.set(name, cb), location: { assign: () => assert.fail("unexpected redirect") } }, Clerk, URLSearchParams, AbortSignal, performance: { now: () => now }, setTimeout: () => 0, setInterval: (fn: any) => { timers.push(fn); return 0; }, fetch: async (url: string) => {
    requests.push(url);
    if(url === '/oauth/validity') { if(validity instanceof Error) throw validity; return new Response(JSON.stringify(validity === true ? { valid: true, serverNow: 1000 + now, expiresAt: 301000 } : validity)); }
    return new Response("{}", { status: 403 });
  } });
  return { element, Clerk, mounts, unmounts, requests, document, validity: (value: any) => validity = value, advance: (ms: number) => { now += ms; timers.forEach(fn => fn()); }, event: (name: string) => events.get(name)!(), load: () => events.get("load")!(), change: () => listener() };
}

test("account choice uses pinned Clerk components and the same frozen return URL; active identity removes auth without consent", async () => {
  const b = browser();
  await b.load();
  assert.equal(b.mounts[0]!.mode, "signin");
  assert.equal(b.mounts[0]!.props.routing, "hash");
  assert.equal(b.mounts[0]!.props.forceRedirectUrl, page.returnTo);
  assert.equal(b.mounts[0]!.props.signUpForceRedirectUrl, page.returnTo);
  b.element("account-choice").callbacks.get("click")();
  assert.equal(b.mounts[1]!.mode, "signup");
  assert.equal(b.mounts[1]!.props.forceRedirectUrl, page.returnTo);
  assert.equal(b.mounts[1]!.props.signInForceRedirectUrl, page.returnTo);
  b.Clerk.session = { status: "active", getToken: async () => "fixture" };
  b.Clerk.user = { primaryEmailAddress: { emailAddress: "person@example.com" } };
  b.change();
  assert.deepEqual(b.unmounts, ["signin", "signup"]);
  assert.equal(b.element("auth").hidden, true);
  assert.equal(b.element("review").hidden, false);
  assert.equal(b.element("email").textContent, "person@example.com");
});

test("the browser can cancel before signing in, without acquiring a human token", async () => {
  const b = browser(); await b.load();
  assert.equal(b.element("cancel-auth").disabled, false);
  await b.element("cancel-auth").callbacks.get("click")();
  assert.ok(b.requests.includes("/oauth/approve"));
  assert.equal(b.Clerk.session, null);
});

test("failed approval makes Allow unavailable while preserving the human session across Clerk events", async () => {
  const b = browser();
  b.Clerk.session = { status: "active", getToken: async () => "fixture" };
  await b.load();
  await b.element("allow").callbacks.get("click")();
  assert.equal(b.element("ended").hidden, false);
  assert.equal(b.element("allow").disabled, true);
  assert.equal(b.element("deny").disabled, true);
  assert.equal(b.element("identity").hidden, false);
  assert.equal(b.Clerk.session.status, "active");
  b.change();
  assert.equal(b.element("allow").disabled, true, "session update cannot revive the ended request");
});

test("natural expiry and late session callbacks cannot restore Allow, and expiry during token acquisition sends no approval", async () => {
  const b = browser(); b.Clerk.session = { status: "active", getToken: async () => { b.advance(300000); return "fixture"; } };
  await b.load();
  assert.equal(b.element("allow").disabled, false);
  await b.element("allow").callbacks.get("click")();
  assert.equal(b.requests.includes("/oauth/approve"), false);
  assert.equal(b.element("ended").hidden, false);
  b.change();
  assert.equal(b.element("allow").disabled, true);
  assert.equal(b.Clerk.session.status, "active");
});

test("hidden and restored pages fail closed on network error, while an authoritative ended reply stays terminal", async () => {
  const b = browser(); b.Clerk.session = { status: "active" }; await b.load();
  b.document.hidden = true; b.event("visibilitychange");
  assert.equal(b.element("allow").disabled, true);
  b.validity(new Error("offline")); b.document.hidden = false; b.event("visibilitychange");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.element("allow").disabled, true);
  assert.equal(b.element("ended").hidden, true, "network failure is unverified, not a claim of terminal expiry");
  b.validity({ valid: false }); b.event("focus");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.element("ended").hidden, false);
  b.validity(true); b.event("pageshow"); b.change();
  assert.equal(b.element("allow").disabled, true);
});

test("authoritative ended state during deferred token acquisition sends no approval, even before the time deadline", async () => {
  const b = browser(); let release!: (token: string) => void;
  b.Clerk.session = { status: "active", getToken: () => new Promise<string>(resolve => { release = resolve; }) };
  await b.load();
  const decision = b.element("allow").callbacks.get("click")();
  while(!release) await new Promise(resolve => setImmediate(resolve));
  b.validity({ valid: false }); b.event("focus");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(b.element("ended").hidden, false);
  release("fixture"); await decision;
  assert.equal(b.requests.includes("/oauth/approve"), false);
  assert.equal(b.Clerk.session.status, "active");
});
