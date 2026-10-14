// The web's own screens (Planban 2.0 plan, phase 4) against the service's real
// handlers: waiting invitations, joining by email and by link, the states an
// invitation can be in, one-tap approval, access keys and sign-in settings.
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryService, PUBLIC, withServiceEnv } from "./hosted-harness";
import { boardPath } from "../src/web/apiPaths";
import { deviceAuthorizationResponse } from "../online/service/convex/model/deviceFlow";
import { webConfigResponse } from "../online/service/convex/model/oauthConsent";
import { safeNext } from "../src/web/webAccount";

type Json = Record<string, any>;

async function page(adapter: { fetch(path: string, init?: RequestInit): Promise<Response> }, path: string, body?: unknown) {
  const response = await adapter.fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", "X-Planban-Client": "web" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as Json };
}

/** Clerk's user lookup, answered here: each person's verified addresses. */
async function withClerkEmails<T>(emails: Record<string, string[]>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  const prior = process.env.CLERK_SECRET_KEY;
  process.env.CLERK_SECRET_KEY = "sk_test_synthetic";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const match = /^https:\/\/api\.clerk\.com\/v1\/users\/([^/]+)$/.exec(url);
    if (!match) return original(input, init);
    const addresses = (emails[match[1]!] ?? []).map((email_address) => ({ email_address, verification: { status: "verified" } }));
    return new Response(JSON.stringify({ email_addresses: addresses }), { status: 200 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
    if (prior === undefined) delete process.env.CLERK_SECRET_KEY; else process.env.CLERK_SECRET_KEY = prior;
  }
}

async function ownerWithBoard() {
  const service = memoryService();
  const owner = await service.signIn("user_sam", "Sam Reid");
  const adapter = service.adapterFor(owner.token);
  const created = await page(adapter, "/api/boards", { title: "Northfold" });
  return { service, owner, adapter, boardId: created.body.board.repoId as string };
}

const tokenOf = (link: string) => link.slice(link.lastIndexOf("/") + 1);

test("an email invitation waits on the invited person's board list, names who sent it, and joins by id", async () => {
  await withServiceEnv(() => withClerkEmails({ user_nia: ["nia@example.com"], user_omar: ["omar@example.com"] }, async () => {
    const { service, adapter, boardId } = await ownerWithBoard();
    const invited = await page(adapter, boardPath(boardId, "/online/invites"), { email: "nia@example.com", role: "editor" });
    assert.equal(invited.status, 200, JSON.stringify(invited.body));
    const nia = service.adapterFor((await service.signIn("user_nia", "Nia")).token);
    const waiting = await page(nia, "/api/online/invites");
    assert.equal(waiting.status, 200, JSON.stringify(waiting.body));
    assert.equal(waiting.body.invitations.length, 1);
    assert.deepEqual({ ...waiting.body.invitations[0], id: undefined, expiresAt: undefined }, { id: undefined, expiresAt: undefined, boardTitle: "Northfold", role: "editor", inviterName: "Sam Reid" });
    const omar = service.adapterFor((await service.signIn("user_omar", "Omar")).token);
    assert.deepEqual((await page(omar, "/api/online/invites")).body.invitations, [], "only the verified address sees it");

    const joined = await page(nia, `/api/online/invites/${waiting.body.invitations[0].id}/accept`, {});
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.boardId, boardId);
    const list = await page(nia, "/api/boards");
    assert.equal(list.body.boards[0].online.role, "editor");
    assert.equal(list.body.boards[0].online.ownerName, "Sam Reid");
    assert.deepEqual((await page(nia, "/api/online/invites")).body.invitations, [], "joined: no longer waiting");
  }));
});

test("opening an invitation link: wrong email shows only a masked address, already a member, expired and cancelled", async () => {
  await withServiceEnv(() => withClerkEmails({ user_nia: ["nia@example.com"], user_omar: ["omar@example.com"] }, async () => {
    const { service, adapter, boardId } = await ownerWithBoard();
    const forNia = await page(adapter, boardPath(boardId, "/online/invites"), { email: "nia@example.com", role: "viewer" });
    const omar = service.adapterFor((await service.signIn("user_omar", "Omar")).token);
    const wrong = await page(omar, "/api/online/invites/accept", { token: tokenOf(forNia.body.link) });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.reason, "wrong_email");
    assert.equal(wrong.body.sentTo, "n•••@example.com");
    assert.doesNotMatch(JSON.stringify(wrong.body), /nia@example\.com/, "the full address isn't shown to someone else");

    const link = await page(adapter, boardPath(boardId, "/online/invites"), { role: "editor" });
    const first = await page(omar, "/api/online/invites/accept", { token: tokenOf(link.body.link) });
    assert.equal(first.body.alreadyMember, false);
    const again = await page(omar, "/api/online/invites/accept", { token: tokenOf(link.body.link) });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyMember, true, "You're already on this board");

    const later = await page(adapter, boardPath(boardId, "/online/invites"), { role: "viewer" });
    const row = service.rows.find((entry) => entry._table === "invites" && entry._id === later.body.invite.id);
    row.expiresAt = new Date(Date.now() - 1000).toISOString();
    const lateJoiner = service.adapterFor((await service.signIn("user_late", "Late")).token);
    const expired = await page(lateJoiner, "/api/online/invites/accept", { token: tokenOf(later.body.link) });
    assert.equal(expired.status, 404);
    assert.equal(expired.body.reason, "expired");

    const cancelledLink = await page(adapter, boardPath(boardId, "/online/invites"), { role: "viewer" });
    await page(adapter, boardPath(boardId, `/online/invites/${cancelledLink.body.invite.id}/revoke`), {});
    const cancelled = await page(lateJoiner, "/api/online/invites/accept", { token: tokenOf(cancelledLink.body.link) });
    assert.equal(cancelled.body.reason, "cancelled");

    const signedOut = await page(service.adapterFor("pbw_" + "S".repeat(43)), "/api/online/invites/accept", { token: tokenOf(link.body.link) });
    assert.equal(signedOut.status, 401);
    assert.equal(signedOut.body.signInNeeded, PUBLIC);
  }));
});

test("one-tap approval: the signed-in person sees who is asking and the code, then answers once", async () => {
  await withServiceEnv(async () => {
    const prior = process.env.PLANBAN_SIGNIN_NOTE_KEY;
    process.env.PLANBAN_SIGNIN_NOTE_KEY = "synthetic-sign-in-note-key-for-tests-only";
    try {
      const service = memoryService();
      const asked = await (await deviceAuthorizationResponse(service.actionCtx, new Request(`${PUBLIC}/oauth/device`, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: "planban-cli", scope: "planban:machine", resource: PUBLIC }),
      }))).json() as Json;
      assert.ok(asked.verification_uri_complete.startsWith(`${PUBLIC}/approve#request=`), JSON.stringify(asked));
      const note = new URL(asked.verification_uri_complete).hash.replace(/^#request=/, "");

      const signedOut = await page(service.adapterFor("pbw_" + "T".repeat(43)), "/api/online/device/preview", { request: note });
      assert.equal(signedOut.status, 401, "signed out: the page asks to log in first");

      const person = service.adapterFor((await service.signIn("user_sam", "Sam Reid")).token);
      const shown = await page(person, "/api/online/device/preview", { request: note });
      assert.equal(shown.status, 200, JSON.stringify(shown.body));
      assert.equal(shown.body.state, "waiting");
      assert.equal(shown.body.userCode, asked.user_code);
      assert.equal(typeof shown.body.clientName, "string");
      const allowed = await page(person, "/api/online/device/decide", { request: note, decision: "allow" });
      assert.equal(allowed.body.state, "allowed");
      assert.equal((await page(person, "/api/online/device/preview", { request: note })).body.state, "ended", "answered once");
      assert.equal((await page(person, "/api/online/device/teleport", { request: note })).status, 404);
    } finally {
      if (prior === undefined) delete process.env.PLANBAN_SIGNIN_NOTE_KEY; else process.env.PLANBAN_SIGNIN_NOTE_KEY = prior;
    }
  });
});

test("an access key made on the web is shown once and then listed without its secret", async () => {
  await withServiceEnv(async () => {
    const { adapter, boardId } = await ownerWithBoard();
    const made = await page(adapter, "/api/online/keys", { name: "Cloud agent", boardId, level: "plan", expiresInDays: 30 });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.match(made.body.key, /^pbk_/);
    const listed = await page(adapter, "/api/online/connections");
    const key = listed.body.connections.find((connection: Json) => connection.kind === "key");
    assert.equal(key.name, "Cloud agent");
    assert.doesNotMatch(JSON.stringify(listed.body), /pbk_/, "the secret is never listed");
    assert.equal((await page(adapter, "/api/online/keys", { name: "Bad", boardId, level: "everything" })).status, 422);
  });
});

test("sign-in settings are public and only offered when sign-in is set up", async () => {
  await withServiceEnv(async () => {
    const names = ["CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "CLERK_ISSUER", "PLANBAN_SIGNIN_NOTE_KEY"] as const;
    const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) delete process.env[name];
      assert.deepEqual(await webConfigResponse().json(), { signIn: null });
      const domain = "clerk.planban.example";
      process.env.CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from(`${domain}$`).toString("base64").replace(/=+$/, "")}`;
      process.env.CLERK_ISSUER = `https://${domain}`;
      process.env.CLERK_SECRET_KEY = "sk_test_synthetic";
      process.env.PLANBAN_SIGNIN_NOTE_KEY = "synthetic-sign-in-note-key-for-tests-only";
      const body = await webConfigResponse().json() as Json;
      assert.deepEqual(body, { signIn: { publishableKey: process.env.CLERK_PUBLISHABLE_KEY, frontendApi: `https://${domain}` } });
      assert.doesNotMatch(JSON.stringify(body), /sk_test|note-key/, "no secret goes to the page");
    } finally {
      for (const name of names) { if (prior[name] === undefined) delete process.env[name]; else process.env[name] = prior[name]; }
    }
  });
});

test("after signing in, the page only ever goes to a path on its own site", () => {
  assert.equal(safeNext("/boards/northfold"), "/boards/northfold");
  assert.equal(safeNext("/invite/pending?x=1"), "/invite/pending?x=1");
  for (const bad of [null, "", "https://evil.example/", "//evil.example/x", "/\\evil.example", "javascript:alert(1)", "boards/x"]) assert.equal(safeNext(bad), "/", String(bad));
});

test("an invitation token or a sign-in request leaves the address at once and waits in this tab only", async () => {
  const { captureAddressSecrets, pendingInvite, pendingApproval } = await import("../src/web/webAccount");
  const store = new Map<string, string>();
  const previous = (globalThis as any).sessionStorage;
  (globalThis as any).sessionStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) };
  try {
    const replaced: string[] = [];
    const history = { replaceState: (_state: unknown, _title: string, url: string) => replaced.push(url) } as unknown as History;
    captureAddressSecrets({ pathname: "/invite/pbi_secret-token", hash: "" } as Location, history);
    assert.equal(pendingInvite(), "pbi_secret-token");
    assert.deepEqual(replaced, ["/invite/pending"], "the visible address no longer has the token");
    captureAddressSecrets({ pathname: "/approve", hash: "#request=pbn_signed.note" } as Location, history);
    assert.equal(pendingApproval(), "pbn_signed.note");
    assert.deepEqual(replaced, ["/invite/pending", "/approve"]);
    captureAddressSecrets({ pathname: "/invite/pending", hash: "" } as Location, history);
    assert.equal(pendingInvite(), "pbi_secret-token", "reloading the cleaned address keeps the invitation");
    assert.equal(replaced.length, 2);
  } finally {
    (globalThis as any).sessionStorage = previous;
  }
});
