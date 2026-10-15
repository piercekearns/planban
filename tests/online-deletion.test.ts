// Deleting for good (owner decisions, 15 October 2026), against the service's
// real handlers: (a) a board's read-only online copy, deleted by its owner;
// (b) a whole account, deleted by the operator within 30 days of a request.
// Each test then looks through every stored row for anything left behind.
import assert from "node:assert/strict";
import { test } from "node:test";
import { internal } from "../online/service/convex/_generated/api";
import { unpackText } from "../online/service/convex/model/codec";
import * as erasure from "../online/service/convex/erasure";
import { memoryService, withServiceEnv } from "./hosted-harness";

type Service = ReturnType<typeof memoryService>;

function as(service: Service, token: string) {
  const send = service.browserSend(token);
  return async (method: string, path: string, body?: unknown) => {
    const response = await send(path, { method, headers: { "X-Planban-Client": "web", "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

async function boardWithCard(api: ReturnType<typeof as>, title: string) {
  const created = await api("POST", "/api/v1/boards", { title });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const boardId = created.body.boardId as string;
  const card = await api("POST", `/api/v1/boards/${boardId}/ops/createCard`, { title: "A card", status: "pending", baseRevision: 1 });
  assert.equal(card.status, 200, JSON.stringify(card.body));
  return boardId;
}

/** A row as text, compressed fields (boards, documents, history) unpacked. */
function readable(row: Record<string, unknown>) {
  return JSON.stringify(row, (_key, value) => value instanceof ArrayBuffer ? unpackText(value) : value);
}

/** Every stored row that still mentions this text (a board id or a user id), by table. */
function leftovers(service: Service, text: string, except: string[] = []) {
  return service.rows.filter((row) => !except.includes(row._table) && readable(row).includes(text)).map((row) => row._table);
}

async function takeLocal(service: Service, connectionId: string, boardId: string, others: string[]) {
  await service.call(internal.boards.fence, { connectionId, boardId, transferId: "take-local-1", acknowledgedOthers: others });
  await service.call(internal.boards.finishTakeLocal, { connectionId, boardId, transferId: "take-local-1" });
}

test("an owner deletes a board's read-only online copy: it's gone at once for everyone, then every stored row goes", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    const owner = await service.signIn("user_owner", "Owen");
    const editor = await service.signIn("user_editor", "Edie");
    const ownerApi = as(service, owner.token);
    const boardId = await boardWithCard(ownerApi, "Copy board");
    await ownerApi("POST", `/api/v1/boards/${boardId}/members`, { userId: "user_editor", role: "editor" });
    await ownerApi("POST", `/api/v1/boards/${boardId}/invites`, { role: "viewer" });
    const key = await ownerApi("POST", "/api/v1/keys", { name: "For this board", boardId, level: "read" });
    assert.equal(key.status, 201, JSON.stringify(key.body));

    // While the board is online there is no read-only copy to delete.
    const tooSoon = await ownerApi("POST", `/api/v1/boards/${boardId}/delete-copy`, { confirmTitle: "Copy board" });
    assert.equal(tooSoon.status, 409);

    await takeLocal(service, owner.connectionId, boardId, ["user_editor"]);
    assert.equal((await ownerApi("GET", `/api/v1/boards/${boardId}`)).status, 200, "the owner can still read the copy");

    const wrongName = await ownerApi("POST", `/api/v1/boards/${boardId}/delete-copy`, { confirmTitle: "Copy" });
    assert.equal(wrongName.status, 400);
    const byOther = await as(service, editor.token)("POST", `/api/v1/boards/${boardId}/delete-copy`, { confirmTitle: "Copy board" });
    assert.equal(byOther.status, 404, "someone no longer on the board can't even see it");

    const deleted = await ownerApi("POST", `/api/v1/boards/${boardId}/delete-copy`, { confirmTitle: "Copy board" });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal((await ownerApi("GET", `/api/v1/boards/${boardId}`)).status, 404);
    assert.deepEqual((await ownerApi("GET", "/api/v1/boards")).body.boards.map((board: { boardId: string }) => board.boardId), []);
    const keyRow = service.rows.find((row) => row._table === "connections" && row.kind === "key");
    assert.ok(keyRow.revokedAt, "a key for only this board stops working");

    // A new board may take the same id before the old rows are gone; it is never touched.
    const again = await boardWithCard(ownerApi, "Copy board");
    assert.equal(again, boardId);
    await service.runJobs();
    assert.equal((await ownerApi("GET", `/api/v1/boards/${again}`)).status, 200, "the new board is intact");
    const newGeneration = service.rows.find((row) => row._table === "boards" && row.boardId === again).generation;
    const stale = service.rows.filter((row) => row.boardId === boardId && "generation" in row && row._table !== "boards" && row.generation !== newGeneration && row._table !== "transfers");
    assert.deepEqual(stale.map((row) => row._table), [], "no row of the deleted copy is left");
    assert.deepEqual(service.rows.filter((row) => row._table === "erasures"), []);
    assert.deepEqual(service.rows.filter((row) => row._table === "invites"), [], "its invitation link went with it");
  });
});

test("deleting an account removes everything of theirs, credits their changes elsewhere to a deleted account, and deletes the sign-in account", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    const leaving = await service.signIn("user_leaving", "Lee Leaving");
    const second = await service.signIn("user_leaving", "Lee Leaving");
    const friend = await service.signIn("user_friend", "Fran");
    const host = await service.signIn("user_host", "Hal");
    const profile = service.rows.find((row) => row._table === "people" && row.userId === "user_leaving");
    profile.email = "Lee@Example.com";

    const leavingApi = as(service, leaving.token), friendApi = as(service, friend.token), hostApi = as(service, host.token);
    // Lee owns a board shared with Fran, and has a key and an access request history.
    const own = await boardWithCard(leavingApi, "Lee's board");
    await leavingApi("POST", `/api/v1/boards/${own}/members`, { userId: "user_friend", role: "editor" });
    await leavingApi("POST", "/api/v1/keys", { name: "Laptop agent", boardId: own, level: "plan" });
    // Lee joined Hal's board by link and changed a card there; an email invitation to Lee waits on another.
    const hosts = await boardWithCard(hostApi, "Hal's board");
    const link = await hostApi("POST", `/api/v1/boards/${hosts}/invites`, { role: "editor" });
    const joined = await leavingApi("POST", "/api/v1/invites/accept", { token: String(link.body.link).split("/invite/")[1] });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const state = await leavingApi("GET", `/api/v1/boards/${hosts}`);
    const edit = await leavingApi("POST", `/api/v1/boards/${hosts}/ops/createCard`, { title: "Lee's idea", status: "pending", baseRevision: state.body.roadmap.revision });
    assert.equal(edit.status, 200, JSON.stringify(edit.body));
    const other = await boardWithCard(hostApi, "Hal's other board");
    await hostApi("POST", `/api/v1/boards/${other}/invites`, { role: "viewer", email: "lee@example.com" });

    // The sign-in service, as the operator's command sees it.
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    process.env.CLERK_SECRET_KEY = "sk_test_operator";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url.replace("https://api.clerk.com/v1", "")}`);
      if (url.includes("/users?email_address=")) return Response.json([{ id: "user_leaving", email_addresses: [{ email_address: "lee@example.com" }, { email_address: "lee.work@example.com" }] }]);
      if (url.endsWith("/users/user_leaving") && init?.method === "DELETE") return Response.json({ deleted: true });
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      const started = await (erasure.requestAccount as any)._handler(service.actionCtx, { email: "LEE@example.com" });
      assert.deepEqual(started, { userId: "user_leaving", boardsDeleted: 1, boardsLeft: 1, invitesRemoved: 1 });

      // At once: every sign-in stops, Fran loses Lee's board, Lee is off Hal's.
      assert.equal((await leavingApi("GET", "/api/v1/boards")).status, 401);
      assert.equal((await as(service, second.token)("GET", "/api/v1/boards")).status, 401);
      assert.equal((await friendApi("GET", `/api/v1/boards/${own}`)).status, 404);
      const hostPeople = await hostApi("GET", `/api/v1/boards/${hosts}/people`);
      assert.deepEqual(hostPeople.body.people.map((person: { userId: string }) => person.userId), ["user_host"]);

      await service.runJobs();

      // The check reads inside compressed fields: Lee's card text is found there.
      assert.ok(leftovers(service, "Lee's idea").includes("boardState"));
      assert.deepEqual(leftovers(service, "user_leaving"), [], "nothing anywhere names the account");
      assert.deepEqual(leftovers(service, own, ["operations"]), [], "nothing of the board they owned is left");
      assert.deepEqual(leftovers(service, "lee@example.com"), []);
      assert.deepEqual(calls.filter((call) => call.startsWith("DELETE")), ["DELETE /users/user_leaving"], "the sign-in account is deleted, once");
      // Hal's board keeps Lee's card, credited to a deleted account.
      const hostBoard = await hostApi("GET", `/api/v1/boards/${hosts}`);
      assert.ok(hostBoard.body.roadmap.roadmapItems.some((item: { title: string }) => item.title === "Lee's idea"));
      const credited = service.rows.filter((row) => row._table === "history" && row.boardId === hosts && row.entry.attribution.userId === erasure.DELETED_ACCOUNT);
      assert.equal(credited.length, 1);
      assert.ok(service.rows.some((row) => row._table === "cardChanges" && row.boardId === hosts && row.userId === erasure.DELETED_ACCOUNT));
      const status = await service.call(internal.erasure.accountStatus, { userId: "user_leaving" });
      assert.equal(status.finished, true, JSON.stringify(status));
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.CLERK_SECRET_KEY;
    }
  });
});

test("an account deletion that can't reach the sign-in service waits, and the daily sweep finishes it", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    await service.signIn("user_gone", "Gwen");
    const realFetch = globalThis.fetch;
    let reachable = false;
    process.env.CLERK_SECRET_KEY = "sk_test_operator";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return reachable ? Response.json({ deleted: true }) : new Response("unavailable", { status: 503 });
      return Response.json([]);
    }) as typeof fetch;
    try {
      await service.call(internal.erasure.eraseAccount, { userId: "user_gone", emails: [] });
      await service.runJobs();
      let status = await service.call(internal.erasure.accountStatus, { userId: "user_gone" });
      assert.equal(status.finished, false);
      assert.equal(status.stage, "clerk");
      assert.deepEqual(leftovers(service, "user_gone", ["erasures"]), [], "everything else is already gone");
      reachable = true;
      await service.call(internal.erasure.sweep, {});
      await service.runJobs();
      status = await service.call(internal.erasure.accountStatus, { userId: "user_gone" });
      assert.equal(status.finished, true);
      assert.deepEqual(leftovers(service, "user_gone"), []);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.CLERK_SECRET_KEY;
    }
  });
});

test("the operator's command refuses an address that matches no account, or more than one", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    const realFetch = globalThis.fetch;
    process.env.CLERK_SECRET_KEY = "sk_test_operator";
    globalThis.fetch = (async (input: RequestInfo | URL) => String(input).includes("twice")
      ? Response.json([{ id: "user_a" }, { id: "user_b" }])
      : Response.json([])) as typeof fetch;
    try {
      await assert.rejects((erasure.requestAccount as any)._handler(service.actionCtx, { email: "nobody@example.com" }), /No account uses/);
      await assert.rejects((erasure.requestAccount as any)._handler(service.actionCtx, { email: "twice@example.com" }), /matches 2 accounts/);
      assert.deepEqual(service.rows.filter((row) => row._table === "erasures"), []);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.CLERK_SECRET_KEY;
    }
  });
});

test("on the web page, Board settings knows a read-only copy, and its Delete online copy reaches the service", async () => {
  await withServiceEnv(async () => {
    const service = memoryService();
    const owner = await service.signIn("user_owner", "Owen");
    const boardId = await boardWithCard(as(service, owner.token), "Page board");
    const page = service.adapterFor(owner.token);
    const settings = async () => (await page.fetch(`/api/boards/${boardId}/online`)).json() as Promise<{ readOnlyCopy?: boolean }>;
    await page.fetch(`/api/boards/${boardId}/state`);
    assert.equal((await settings()).readOnlyCopy, undefined, "an online board isn't a copy");
    await takeLocal(service, owner.connectionId, boardId, []);
    await page.fetch(`/api/boards/${boardId}/state`);
    assert.equal((await settings()).readOnlyCopy, true);
    const refused = await page.fetch(`/api/boards/${boardId}/online/delete-copy`, { method: "POST", body: JSON.stringify({ confirmTitle: "Wrong" }) });
    assert.equal(refused.status, 422);
    const deleted = await page.fetch(`/api/boards/${boardId}/online/delete-copy`, { method: "POST", body: JSON.stringify({ confirmTitle: "Page board" }) });
    assert.equal(deleted.status, 200);
    assert.equal((await page.fetch(`/api/boards/${boardId}/state`)).status, 404);
  });
});
