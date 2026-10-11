import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as storage from "../src/core/storage";
import * as domain from "../src/core/boardOperations";
import { historyDocPath, historyRoadmapPath, manifestPath } from "../src/core/paths";
import { manifestSchema } from "../src/core/schema";
import { listBoards, registerBoardFromCwd, duplicateBoard } from "../src/core/registry";
import { credentialsRoot, onlineStatus, readCredentials, saveCredentials, serviceUrl } from "../src/core/online/credentials";
import { onlineRequest, OnlineAuthenticationError } from "../src/core/online/client";
import { onlineLogin } from "../src/core/online/login";
import { attachOnline, buildLocalBundle, exportOnline, keepLocalCopy, restoreBackup, takeLocal, takeOnline, type BoardBundle } from "../src/core/online/transfers";
import { onlineCacheRoot } from "../src/core/online/adapter";
import { PlanbanStaleCopyError, resetCopyChecks, STALE_MARKER } from "../src/core/online/copyCheck";
import { backupRoot, refreshBackup } from "../src/core/online/backup";
import { onlineLogout } from "../src/core/online/connections";
import { startServer } from "../src/server/server";
import type { PlanbanDocPayload, PlanbanRoadmap } from "../src/core/types";

const execFileAsync = promisify(execFile);
const originalHome = process.env.PLANBAN_HOME;
let root: string;
let cwd: string;
let fake: Awaited<ReturnType<typeof fakeService>>;

async function readBytes(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readBody(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text;
}

async function fakeService() {
  let url = "";
  let accessToken = "access-0";
  let refreshToken = "refresh-0";
  let refreshes = 0;
  let auth: URL | undefined;
  let registration: any;
  let bundle: BoardBundle | undefined;
  let authority = "online";
  let rejectRefresh = false;
  let rejectAccess = false;
  let failExport = false;
  let metadataOrigin: string | undefined;
  let beforeFence: (() => void) | undefined;
  const docs = new Map<string, PlanbanDocPayload>();
  const transfers = new Map<string, { begin: any; parts: Map<number, any>; state: "open" | "committed" | "aborted" }>();
  const replies = new Map<string, unknown>();
  let dropNextReply = false;
  let failLiveToken = false;
  let failCopyCheck = false;
  let localTransfer: string | undefined;
  const revokedTokens = new Set<string>();
  let failExportDocs = false;
  let boardUid: string | undefined;
  const attachments = new Map<string, any>();
  const blobs = new Map<string, Buffer>();
  const uploads = new Map<string, Buffer>();
  const sessions = new Map<string, any>();
  const requests: { method: string; path: string; body: any }[] = [];
  const errors: Error[] = [];
  const server = createServer(async (req, res) => {
    try {
      const request = new URL(req.url!, url);
      const path = request.pathname;
      const rawBytes = await readBytes(req);
      const raw = rawBytes.toString("utf8");
      const body = raw && req.method !== "PUT" ? (req.headers["content-type"]?.includes("application/json") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : undefined;
      requests.push({ method: req.method!, path, body });
      const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (path === "/.well-known/oauth-authorization-server") return json(200, {
        issuer: url, registration_endpoint: `${metadataOrigin ?? url}/oauth/register`, token_endpoint: `${metadataOrigin ?? url}/oauth/token`, authorization_endpoint: `${metadataOrigin ?? url}/authorize`,
      });
      if (path === "/oauth/register") {
        assert.equal(body.client_name, "Planban CLI");
        assert.equal(body.token_endpoint_auth_method, "none");
        assert.match(body.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
        registration = body;
        return json(201, { client_id: "cli" });
      }
      if (path === "/authorize" && req.method === "GET") {
        auth = request;
        assert.equal(auth.searchParams.get("resource"), url);
        assert.equal(auth.searchParams.get("scope"), "planban:read planban:write offline_access");
        assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
        res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": ["consent=secret; HttpOnly; SameSite=Lax", "second=yes; Path=/"] });
        return res.end('<form><input type="hidden" name="handle" value="a&#38;b"></form>');
      }
      if (path === "/authorize" && req.method === "POST") {
        assert.equal(req.headers.cookie, "consent=secret; second=yes");
        assert.equal(body.handle, "a&b");
        assert.equal(body.person, "owner");
        assert.equal(body.password, "test-password");
        assert.equal(body.decision, "approve");
        const callback = new URL(auth!.searchParams.get("redirect_uri")!);
        callback.search = new URLSearchParams({ code: "test-code", state: auth!.searchParams.get("state")!, iss: url }).toString();
        res.writeHead(302, { Location: callback.href });
        return res.end();
      }
      if (path === "/oauth/token") {
        assert.equal(body.client_id, "cli");
        assert.equal(body.resource, url);
        if (body.grant_type === "refresh_token") {
          refreshes++;
          if (rejectRefresh || body.refresh_token !== refreshToken) return json(400, { error: "invalid_grant" });
        } else {
          assert.equal(body.code, "test-code");
          assert.equal(body.redirect_uri, registration.redirect_uris[0]);
          assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), auth!.searchParams.get("code_challenge"));
        }
        accessToken = `access-${requests.length}`;
        refreshToken = `refresh-${requests.length}`;
        return json(200, { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600 });
      }
      if (rejectAccess || req.headers.authorization !== `Bearer ${accessToken}`) {
        res.setHeader("WWW-Authenticate", 'Bearer resource_metadata="' + url + '/.well-known/oauth-protected-resource"');
        return json(401, { error: "unauthorized" });
      }
      if (path === "/api/v1/me") return json(200, { userId: "dev-owner", scope: "all" });
      if (path === "/api/v1/connections/self/revoke") {
        revokedTokens.add(String(req.headers.authorization));
        return json(200, { revoked: true });
      }
      if (path === "/api/v1/copy-check") {
        if (failCopyCheck) return json(503, { error: { code: "unavailable", message: "Down for maintenance." } });
        if (!bundle || authority !== "online") return json(200, { matches: [] });
        const matchedVersions = body.fingerprints
          .filter((print: any) => bundle!.history.some(({ entry }) => entry.version === print.version && entry.createdAt === print.createdAt && entry.operation === print.operation))
          .map((print: any) => print.version);
        // Like the service: the same identity, or at least two shared entries.
        const identified = !!body.uid && body.uid === boardUid;
        const found = identified || matchedVersions.length >= Math.min(2, body.fingerprints.length);
        return json(200, { matches: found ? [{ boardId: "demo", title: bundle.roadmap.project.title, onlineSince: "2026-10-11T12:00:00.000Z", matchedVersions }] : [] });
      }
      if (path === "/api/v1/live-token" && failLiveToken) return json(503, { error: { code: "unavailable", message: "Live updates are down." } });
      if (path.startsWith("/error/")) return json(Number(path.split("/")[2]), { error: { code: "fixture", message: "Fixture refusal", currentRevision: 19 } });
      const importBundle = (input: BoardBundle) => {
        assert.equal(input.roadmap.project.id, "demo");
        bundle = structuredClone(input);
        authority = "online";
        bundle!.roadmap = domain.committedRoadmap(domain.normalizeRoadmap(bundle!.roadmap), new Date().toISOString());
        const version = Math.max(0, ...bundle!.history.map(({ entry }) => entry.version)) + 1;
        bundle!.history.push({ entry: { version, roadmapRevision: bundle!.roadmap.revision, createdAt: new Date().toISOString(), actor: "import", operation: "board.import", summary: "Imported board", affectedCards: [], affectedDocs: [] }, roadmap: structuredClone(bundle!.roadmap) });
        docs.clear();
        for (const doc of bundle!.docs) docs.set(`${doc.cardId}/${doc.kind}`, { ...doc, exists: true, path: `items/${doc.cardId}/${doc.kind}.md`, mtimeMs: 1 });
        return { boardId: "demo", roadmap: bundle!.roadmap };
      };
      if (path === "/api/v1/boards/import") {
        if (bundle && authority !== "returned-local") return json(409, { error: { code: "conflict", message: "Board exists" } });
        return json(201, importBundle(body));
      }
      if (path === "/api/v1/transfers") {
        const existing = transfers.get(body.transferId);
        if (existing) return json(200, { state: existing.state, receivedParts: [...existing.parts.keys()] });
        if (bundle && authority !== "returned-local") return json(409, { error: { code: "conflict", message: "Board exists" } });
        transfers.set(body.transferId, { begin: body, parts: new Map(), state: "open" });
        if (body.uid) boardUid = body.uid;
        return json(200, { state: "open", receivedParts: [] });
      }
      if (path.startsWith("/api/v1/transfers/")) {
        const [, , , , transferId, step] = path.split("/");
        const transfer = transfers.get(decodeURIComponent(transferId!));
        if (!transfer) return json(404, { error: { code: "not_found", message: "Upload not found." } });
        if (step === "parts") {
          if (transfer.state === "open") transfer.parts.set(body.seq, body);
          return json(200, { duplicate: false });
        }
        if (step === "abort") {
          if (transfer.state === "committed") return json(409, { error: { code: "conflict", message: "This upload already finished." } });
          transfer.state = "aborted";
          return json(200, { state: "aborted" });
        }
        if (step === "commit") {
          if (transfer.state === "committed") return json(200, { boardId: "demo", roadmap: bundle!.roadmap });
          if (transfer.parts.size !== body.partCount) return json(400, { error: { code: "validation", message: "The upload is incomplete." } });
          const parts = [...transfer.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
          const result = importBundle({
            format: "planban-board-bundle", version: 1, roadmap: transfer.begin.roadmap, retiredIds: transfer.begin.retiredIds,
            ...(transfer.begin.retention ? { retention: transfer.begin.retention } : {}),
            docs: parts.flatMap((part) => part.docs ?? []), history: parts.flatMap((part) => part.history ?? []), historyDocs: parts.flatMap((part) => part.historyDocs ?? []),
          } as BoardBundle);
          transfer.state = "committed";
          return json(200, result);
        }
      }
      if (!bundle || !path.startsWith("/api/v1/boards/demo")) return json(404, { error: { code: "not_found", message: "Board not found" } });
      const roadmap = () => domain.normalizeRoadmap(bundle!.roadmap);
      const suffix = path.slice("/api/v1/boards/demo".length);
      if (!suffix) return json(200, { roadmap: roadmap(), authority });
      if (suffix === "/changes") return json(200, { revision: roadmap().revision });
      if (suffix === "/export/meta") {
        if (failExport) return json(500, { error: { message: "Export interrupted" } });
        return json(200, { format: "planban-board-bundle", version: 1, roadmap: bundle.roadmap, retiredIds: bundle.retiredIds ?? [], historyVersions: bundle.history.map(({ entry }) => entry.version), ...(bundle.retention ? { retention: bundle.retention } : {}) });
      }
      if (suffix === "/export/docs") {
        if (failExportDocs) return json(500, { error: { message: "Export interrupted" } });
        const all = [...docs.values()].map(({ cardId, kind, markdown }) => ({ cardId, kind, markdown }));
        const offset = Number(request.searchParams.get("offset") ?? 0);
        return json(200, offset === 0 ? { docs: all, nextOffset: null } : { docs: [], nextOffset: null });
      }
      if (suffix === "/export/history") {
        const after = Number(request.searchParams.get("after") ?? 0);
        const limit = Number(request.searchParams.get("limit") ?? 8);
        const page = bundle.history.filter(({ entry }) => entry.version > after).sort((a, b) => a.entry.version - b.entry.version).slice(0, limit);
        const versions = new Set(page.map(({ entry }) => entry.version));
        return json(200, { history: page, historyDocs: (bundle.historyDocs ?? []).filter((doc) => versions.has(doc.version)) });
      }
      if (suffix === "/take-local/fence") {
        if (localTransfer === body.transferId) return json(200, { generation: 1 });
        if (authority !== "online") return json(409, { error: { code: "conflict", message: "Already being taken local." } });
        beforeFence?.();
        authority = "returned-local";
        localTransfer = body.transferId;
        bundle.roadmap = domain.committedRoadmap(roadmap(), new Date().toISOString());
        return json(200, { generation: 1 });
      }
      if (suffix === "/take-local/finish") {
        if (localTransfer === body.transferId) localTransfer = undefined;
        return json(200, { finished: true });
      }
      if (suffix === "/history") return json(200, { currentVersion: Math.max(...bundle.history.map(({ entry }) => entry.version)), retention: { boardVersions: 100, cardVersions: 25, documentVersions: 25, hourlyDays: 2, maxAgeDays: 90 }, entries: bundle.history.map(({ entry }) => entry).filter((entry) => entry.version > Number(request.searchParams.get("after") ?? 0)).reverse() });
      if (suffix === "/attachments" && req.method === "GET") return json(200, { attachments: [...attachments.values()] });
      if (suffix === "/attachments/begin" || suffix === "/attachments/finish") {
        if (suffix === "/attachments/begin" && !blobs.has(body.sha256)) {
          const uploadId = `upload-${sessions.size + 1}`;
          sessions.set(uploadId, { ...body, parts: new Map<number, Buffer>() });
          return json(200, { done: false, uploadId, partBytes: 4, partCount: Math.max(1, Math.ceil(body.size / 4)) });
        }
        let file = body;
        if (suffix === "/attachments/finish") {
          file = sessions.get(body.uploadId);
          const uploaded = file && Buffer.concat([...file.parts.entries()].sort(([a]: [number], [b]: [number]) => a - b).map(([, part]: [number, Buffer]) => part));
          if (!file || !uploaded || createHash("sha256").update(uploaded).digest("hex") !== file.sha256) return json(400, { error: { code: "validation", message: "Upload mismatch." } });
          blobs.set(file.sha256, uploaded);
        }
        const id = `att-${file.cardId}-${file.path}`;
        const record = { id, cardId: file.cardId, path: file.path, sha256: file.sha256, size: file.size, contentType: file.contentType, uploadedBy: "dev-owner", uploadedAt: new Date().toISOString() };
        attachments.set(id, record);
        return json(200, { done: true, attachment: record });
      }
      if (suffix.startsWith("/attachments/uploads/") && req.method === "PUT") {
        const [, , , uploadId, , index] = suffix.split("/");
        sessions.get(uploadId!)?.parts.set(Number(index), Buffer.from(rawBytes));
        return json(200, { stored: true });
      }
      if (suffix.startsWith("/attachments/") && req.method === "GET") {
        const record = attachments.get(decodeURIComponent(suffix.split("/")[2]!));
        if (!record) return json(404, { error: { code: "not_found", message: "Attachment not found." } });
        res.writeHead(200, { "Content-Type": record.contentType });
        res.end(blobs.get(record.sha256));
        return;
      }
      if (suffix.startsWith("/docs/")) {
        const [, , cardId, kind] = suffix.split("/").map(decodeURIComponent);
        return json(200, docs.get(`${cardId}/${kind}`) ?? { cardId, kind, exists: false, path: null, markdown: "", mtimeMs: null });
      }
      if (suffix.startsWith("/ops/")) {
        assert.equal("cwd" in body, false);
        if (authority !== "online") return json(409, { error: { code: "conflict", message: "Board has returned to local authority" } });
        const op = suffix.split("/").at(-1)!;
        const key = req.headers["idempotency-key"] as string | undefined;
        if (key && replies.has(key)) return json(200, replies.get(key));
        // Like the hosted service: every edit states its base version.
        if (op === "writeDoc" ? body.expectedMtimeMs === undefined : typeof body.baseRevision !== "number") {
          return json(400, { error: { code: "validation", message: "Online Board edits must state the version they were based on (baseRevision).", currentRevision: roadmap().revision } });
        }
        if (body.baseRevision !== undefined) domain.assertBaseRevision(roadmap(), body.baseRevision);
        const context = { now: new Date().toISOString() };
        let result: Record<string, unknown> = {};
        let change: domain.PlannedChange;
        if (op === "writeDoc") {
          const planned = domain.planWriteDoc(roadmap(), body, context);
          const existing = docs.get(`${body.cardId}/${body.kind}`);
          if (body.expectedMtimeMs !== undefined && body.expectedMtimeMs !== (existing?.mtimeMs ?? null)) throw new domain.PlanbanConflictError("Document changed online.");
          const doc = { cardId: body.cardId, kind: body.kind, path: planned.path, markdown: body.markdown, exists: true, mtimeMs: (existing?.mtimeMs ?? 0) + 1 };
          docs.set(`${body.cardId}/${body.kind}`, doc);
          result = { doc };
          change = { roadmap: planned.roadmap ?? roadmap(), history: planned.history, docWrites: [] };
        } else {
          const planners: Record<string, Function> = { createCard: domain.planCreateCard, createGroup: domain.planCreateGroup, createCards: domain.planCreateCards, moveCard: domain.planMoveCard, updateCard: domain.planUpdateCard, deleteArchivedCard: domain.planDeleteArchivedCard, reorderCards: domain.planReorderCards };
          change = planners[op]!(roadmap(), body, context);
          if (op === "createCard") result = { createdCard: change.roadmap.roadmapItems.find((item) => item.id === (change as any).cardId) };
          if (op === "createGroup") result = { createdGroup: change.roadmap.roadmapItems.find((item) => item.id === (change as any).groupId) };
          if (op === "createCards") result = { createdCards: change.roadmap.roadmapItems.filter((item) => (change as any).cardIds.includes(item.id)) };
          for (const doc of change.docWrites) docs.set(`${doc.cardId}/${doc.kind}`, { ...doc, exists: true, mtimeMs: 1 });
          if (op === "deleteArchivedCard") for (const key of docs.keys()) if (key.startsWith(`${body.cardId}/`)) docs.delete(key);
        }
        bundle.roadmap = domain.committedRoadmap(change.roadmap, context.now);
        const version = Math.max(...bundle.history.map(({ entry }) => entry.version)) + 1;
        bundle.history.push({ entry: { ...change.history, affectedDocs: change.history.affectedDocs ?? [], version, roadmapRevision: bundle.roadmap.revision, createdAt: context.now }, roadmap: structuredClone(bundle.roadmap) });
        if (key) replies.set(key, { roadmap: bundle.roadmap, result });
        if (dropNextReply) {
          // Simulates a response lost on the network after the edit committed.
          dropNextReply = false;
          req.socket.destroy();
          return;
        }
        return json(200, { roadmap: bundle.roadmap, result });
      }
      json(404, { error: { code: "not_found", message: "Unknown endpoint" } });
    } catch (error) {
      const status = error instanceof domain.PlanbanConflictError ? 409 : error instanceof domain.PlanbanValidationError ? 400 : error instanceof domain.PlanbanNotFoundError ? 404 : 500;
      if (status === 500) errors.push(error as Error);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: status === 409 ? "conflict" : "validation", message: (error as Error).message } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    url, requests, errors, get refreshes() { return refreshes; }, get bundle() { return bundle!; }, get authority() { return authority; },
    expireAccess() { accessToken = "expired"; }, rejectRefresh() { rejectRefresh = true; }, rejectAccess() { rejectAccess = true; },
    failExport(value: boolean) { failExport = value; }, setMetadataOrigin(value: string) { metadataOrigin = value; },
    beforeFence(fn: () => void) { beforeFence = fn; }, dropNextReply() { dropNextReply = true; }, failLiveToken() { failLiveToken = true; }, failCopyCheck(value: boolean) { failCopyCheck = value; }, transfers, revokedTokens, attachments, blobs, failExportDocs(value: boolean) { failExportDocs = value; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "planban-online-"));
  process.env.PLANBAN_HOME = join(root, "home");
  process.env.PLANBAN_ONLINE_TEST_PASSWORD = "test-password";
  cwd = join(root, "repo");
  fake = await fakeService();
  await storage.initializeProject({ cwd, repoId: "demo", title: "Demo board", updateAgents: false });
  await storage.createCard({ cwd, title: "Alpha", specMarkdown: "# Original spec", planMarkdown: "# Original plan" });
  await saveCredentials(fake.url, { clientId: "cli", accessToken: "access-0", refreshToken: "refresh-0", expiresAt: new Date(Date.now() + 3600_000).toISOString(), person: "owner" });
});

test.afterEach(async () => {
  await fake.close();
  await rm(root, { recursive: true, force: true });
  process.env.PLANBAN_HOME = originalHome;
  delete process.env.PLANBAN_ONLINE_TEST_PASSWORD;
  assert.deepEqual(fake.errors, []);
});

test("online manifest accepts origins without secrets and rejects unsafe origins", () => {
  for (const url of ["https://example.com", "http://localhost:8787", fake.url]) {
    assert.equal(manifestSchema.parse({ version: 1, enabled: true, repoId: "demo", storage: { kind: "online", url, boardId: "demo" } }).storage?.kind, "online");
  }
  for (const url of ["http://example.com", "https://user:password@example.com", "https://example.com/path", "https://example.com?token=secret"]) {
    assert.throws(() => serviceUrl(url));
    assert.equal(manifestSchema.safeParse({ version: 1, enabled: true, repoId: "demo", storage: { kind: "online", url, boardId: "demo" } }).success, false);
  }
});

test("headless CLI login discovers OAuth endpoints, preserves cookies and sends PKCE and resource", async () => {
  await saveCredentials(fake.url, null);
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", "online", "login", fake.url, "--user", "owner", "--password-env", "PLANBAN_ONLINE_TEST_PASSWORD", "--access", "board", "--boards", "demo"], { env: process.env });
  assert.equal(JSON.parse(stdout).identity.userId, "dev-owner");
  const consent = fake.requests.find((req) => req.path === "/authorize" && req.method === "POST")!;
  assert.equal(consent.body.reach, "board");
  assert.equal(consent.body.boardId, "demo");
  const file = await readCredentials();
  assert.match(file.services[fake.url]!.refreshToken, /^refresh-/);
  assert.equal((await stat(join(credentialsRoot(), "credentials.json"))).mode & 0o777, 0o600);
  const status = await onlineStatus();
  assert.equal(status[0]?.person, "owner");
  assert.equal(JSON.stringify(status).includes("Token"), false);
});

test("browser login accepts only the state-bound loopback callback", async () => {
  const loggedIn = await onlineLogin(fake.url, { openBrowser: async (url) => {
    const page = await fetch(url);
    const consent = await fetch(`${fake.url}/authorize`, { method: "POST", redirect: "manual", headers: { Cookie: page.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") }, body: new URLSearchParams({ handle: "a&b", person: "owner", password: "test-password", decision: "approve", reach: "all", boardId: "" }) });
    const valid = new URL(consent.headers.get("location")!);
    const invalid = new URL(valid);
    invalid.searchParams.set("state", "wrong");
    assert.equal((await fetch(invalid)).status, 400);
    assert.equal((await fetch(valid)).status, 200);
  } });
  assert.equal(loggedIn.signedIn, true);
});

test("401 refresh rotates and persists credentials once across concurrent calls", async () => {
  fake.expireAccess();
  const results = await Promise.all(Array.from({ length: 6 }, () => onlineRequest(fake.url, "/api/v1/me")));
  assert.equal(results.length, 6);
  assert.equal(fake.refreshes, 1);
  assert.notEqual((await readCredentials()).services[fake.url]!.refreshToken, "refresh-0");
  await onlineRequest(fake.url, "/api/v1/me");
  assert.equal(fake.refreshes, 1);
});

test("near-expiry refresh is serialized between separate CLI processes", async () => {
  const credentials = (await readCredentials()).services[fake.url]!;
  await saveCredentials(fake.url, { ...credentials, expiresAt: new Date(Date.now() + 5000).toISOString() });
  const script = `import {onlineRequest} from './src/core/online/client.ts'; await onlineRequest(process.env.TEST_ONLINE_URL, '/api/v1/me');`;
  await Promise.all(Array.from({ length: 3 }, () => execFileAsync(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script], { env: { ...process.env, TEST_ONLINE_URL: fake.url } })));
  assert.equal(fake.refreshes, 1);
});

test("revoked or failed refresh connections give a sign-in error without retry loops", async () => {
  fake.rejectAccess();
  await assert.rejects(onlineRequest(fake.url, "/api/v1/me"), (error: any) => error instanceof OnlineAuthenticationError && error.message.includes("online login"));
  assert.equal(fake.refreshes, 1);
  fake.rejectRefresh();
  await assert.rejects(onlineRequest(fake.url, "/api/v1/me"), OnlineAuthenticationError);
  assert.equal(fake.refreshes, 2);
});

test("OAuth metadata cannot send client credentials to another origin", async () => {
  fake.setMetadataOrigin("https://other.example");
  await assert.rejects(onlineLogin(fake.url, { user: "owner", passwordEnv: "PLANBAN_ONLINE_TEST_PASSWORD" }), /must belong to the service origin/);
  assert.equal(fake.requests.some((req) => req.path === "/oauth/register"), false);
});

test("dispatch preserves state and result shapes for all card operations", async () => {
  await takeOnline(fake.url, cwd);
  const initial = await storage.loadState(cwd);
  assert.equal(initial.manifest.storage?.kind, "online");
  assert.equal(initial.roadmapPath.endsWith("snapshot.json"), true);
  assert.equal(await storage.pathExists(join(initial.planningRoot, "roadmap.json")), false);
  const moved = await storage.moveCard({ cwd, cardId: "alpha", status: "up-next", baseRevision: initial.roadmap.revision });
  assert.equal(moved.roadmap.roadmapItems[0]?.status, "up-next");
  const updated = await storage.updateCard({ cwd, cardId: "alpha", summary: "Shared summary", metadata: { source: "test" }, baseRevision: moved.roadmap.revision });
  assert.equal(updated.roadmap.roadmapItems[0]?.summary, "Shared summary");
  const rev = async () => (await storage.loadState(cwd)).roadmap.revision;
  const created = await storage.createCard({ cwd, title: "Beta", status: "pending", baseRevision: await rev() });
  assert.equal(created.createdCard.id, "beta");
  const group = await storage.createGroup({ cwd, title: "Group", summary: "Shared objective", baseRevision: await rev() });
  assert.equal(group.createdGroup.isGroup, true);
  const children = await storage.createCards({ cwd, titles: ["Child one", "Child two"], parentId: group.createdGroup.id, baseRevision: await rev() });
  assert.equal(children.createdCards.length, 2);
  const parented = await storage.setCardParent({ cwd, cardId: "beta", parentId: group.createdGroup.id, baseRevision: await rev() });
  assert.equal(parented.roadmap.roadmapItems.find((item) => item.id === "beta")?.parentId, group.createdGroup.id);
  await storage.setCardParent({ cwd, cardId: "beta", parentId: null, baseRevision: await rev() });
  await storage.reorderCards({ cwd, items: (await storage.loadState(cwd)).roadmap.roadmapItems.map(({ id, status }) => ({ id, status })).reverse(), baseRevision: await rev() });
  await storage.setCardStatus(cwd, "beta", "archived", await rev());
  const deleted = await storage.deleteArchivedCard({ cwd, cardId: "beta", baseRevision: await rev() });
  assert.equal(deleted.roadmap.roadmapItems.some((item) => item.id === "beta"), false);
  assert.ok((await storage.historyPayload(cwd)).entries.length > 2);
});

test("documents preserve online stamps and stale roadmap or document edits conflict", async () => {
  await takeOnline(fake.url, cwd);
  const doc = await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" });
  assert.equal(doc.markdown, "# Original spec");
  const saved = await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Shared spec", expectedMtimeMs: doc.mtimeMs });
  assert.equal(saved.mtimeMs, 2);
  assert.equal((await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown, "# Shared spec");
  await assert.rejects(storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "stale", expectedMtimeMs: doc.mtimeMs }), storage.PlanbanConflictError);
  await assert.rejects(storage.moveCard({ cwd, cardId: "alpha", status: "up-next", baseRevision: 0 }), storage.PlanbanConflictError);
});

test("hosted errors retain domain classes, access status and revision details", async () => {
  for (const [status, type] of [[400, storage.PlanbanValidationError], [404, storage.PlanbanNotFoundError], [409, storage.PlanbanConflictError], [403, OnlineAuthenticationError]] as const) {
    await assert.rejects(onlineRequest(fake.url, `/error/${status}`), (error: any) => error instanceof type && (status !== 409 || error.currentRevision === 19));
  }
});

test("take-online sends every retained roadmap and current and historical document body", async () => {
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Second spec" });
  const before = await storage.loadState(cwd);
  const expected = await buildLocalBundle(cwd);
  const result = await takeOnline(fake.url, cwd);
  // Reassemble what was uploaded in parts.
  const begin = fake.requests.find((req) => req.path === "/api/v1/transfers")!.body;
  const parts = fake.requests.filter((req) => req.path.endsWith("/parts")).map((req) => req.body).sort((a, b) => a.seq - b.seq);
  const imported = {
    format: expected.format, version: expected.version, roadmap: begin.roadmap,
    docs: parts.flatMap((part) => part.docs ?? []), history: parts.flatMap((part) => part.history ?? []),
    historyDocs: parts.flatMap((part) => part.historyDocs ?? []), retention: begin.retention,
  };
  const byVersion = <T extends { version: number; cardId: string; kind: string }>(docs: T[]) => [...docs].sort((a, b) => a.version - b.version || a.cardId.localeCompare(b.cardId) || a.kind.localeCompare(b.kind));
  assert.deepEqual({ ...imported, historyDocs: byVersion(imported.historyDocs) }, {
    ...expected, history: [...expected.history].sort((a, b) => a.entry.version - b.entry.version), historyDocs: byVersion(expected.historyDocs ?? []),
  });
  assert.equal(imported.roadmap.project.id, "demo");
  assert.equal(expected.docs.length, 2);
  assert.ok(expected.historyDocs!.some((doc) => doc.markdown === "# Original spec"));
  assert.ok(expected.historyDocs!.some((doc) => doc.markdown === "# Second spec"));
  for (const version of expected.history) assert.deepEqual(version.roadmap, JSON.parse(await readFile(historyRoadmapPath(before.planningRoot, version.entry.version), "utf8")));
  assert.deepEqual(JSON.parse(await readFile(result.localSnapshot, "utf8")), before.roadmap);
  assert.equal(await storage.pathExists(before.roadmapPath), false);
  assert.equal((await storage.loadState(cwd)).roadmap.revision, before.roadmap.revision + 1);
});

test("take-local fences before export, preserves history docs and can re-take online", async () => {
  await storage.writeDoc({ cwd, cardId: "alpha", kind: "spec", markdown: "# Later spec" });
  const bundleBefore = await buildLocalBundle(cwd);
  await takeOnline(fake.url, cwd);
  fake.beforeFence(() => { fake.bundle.roadmap.roadmapItems[0]!.summary = "Last remote edit"; });
  const start = fake.requests.length;
  const returned = await takeLocal(cwd);
  const calls = fake.requests.slice(start).filter((req) => req.path.endsWith("/fence") || req.path.includes("/export/"));
  assert.deepEqual(calls.slice(0, 2).map((req) => req.path.split("/").at(-1)), ["fence", "meta"]);
  assert.equal(fake.authority, "returned-local");
  const local = await storage.loadState(cwd);
  assert.equal(local.manifest.storage?.kind, "local");
  assert.equal(local.roadmap.roadmapItems[0]!.summary, "Last remote edit");
  assert.equal((await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown, "# Later spec");
  for (const doc of bundleBefore.historyDocs!) assert.equal(await readFile(historyDocPath(returned.planningRoot, doc.version, doc.cardId, doc.kind), "utf8"), doc.markdown);
  const oldVersion = bundleBefore.historyDocs!.find((doc) => doc.markdown === "# Original spec")!.version;
  assert.equal((await storage.readHistoryDoc({ cwd, version: oldVersion, cardId: "alpha", kind: "spec" })).markdown, "# Original spec");
  await storage.updateCard({ cwd, cardId: "alpha", summary: "Local edit" });
  const revision = (await storage.loadState(cwd)).roadmap.revision;
  await takeOnline(fake.url, cwd);
  assert.equal(fake.authority, "online");
  assert.equal((await storage.loadState(cwd)).roadmap.revision, revision + 1);
});

test("an interrupted take-local keeps the online manifest and can be retried", async () => {
  await takeOnline(fake.url, cwd);
  fake.failExport(true);
  await assert.rejects(takeLocal(cwd), /Export interrupted/);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  assert.equal(fake.authority, "returned-local");
  fake.failExport(false);
  await takeLocal(cwd);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "local");
});

test("attach and registry discovery use remote authority and export writes a bundle", async () => {
  await takeOnline(fake.url, cwd);
  const second = join(root, "second-machine");
  await attachOnline(fake.url, "demo", second);
  assert.equal((await registerBoardFromCwd(second))?.repoId, "demo");
  assert.equal((await listBoards()).find((board) => board.repoId === "demo")?.cwd, second);
  await storage.updateCard({ cwd: second, cardId: "alpha", summary: "Second machine", baseRevision: (await storage.loadState(second)).roadmap.revision });
  assert.equal((await storage.loadState(cwd)).roadmap.roadmapItems[0]!.summary, "Second machine");
  const out = join(root, "bundle.json");
  await execFileAsync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", "online", "export", "--cwd", second, "--out", out], { env: process.env });
  assert.equal(JSON.parse(await readFile(out, "utf8")).format, "planban-board-bundle");
  await assert.rejects(attachOnline(fake.url, "other", second), /already has a different board/);
});

test("unsupported online file operations refuse rather than using local snapshots", async () => {
  await takeOnline(fake.url, cwd);
  const state = await storage.loadState(cwd);
  for (const run of [
    () => storage.saveRoadmap(state, state.roadmap),
    () => storage.exportFlatVersion1({ cwd, exportId: "backup" }),
    () => storage.reconstructHierarchy({ cwd, groups: [], baseRevision: state.roadmap.revision }),
    () => storage.loadHistoryState({ cwd, version: 1 }),
    () => storage.readHistoryDoc({ cwd, version: 1, cardId: "alpha", kind: "spec" }),
    () => storage.restoreBoardVersion({ cwd, version: 1 }),
    () => storage.restoreCardVersion({ cwd, version: 1, cardId: "alpha" }),
    () => storage.restoreDocVersion({ cwd, version: 1, cardId: "alpha", kind: "spec" }),
    () => storage.initializeProject({ cwd }),
    () => duplicateBoard({ sourceRepoId: "demo" }),
  ]) await assert.rejects(run(), (error: any) => error instanceof storage.PlanbanValidationError && /not yet available for Online Boards/.test(error.message));
  fake.rejectAccess();
  await assert.rejects(storage.loadState(cwd), OnlineAuthenticationError);
});

test("Board HTTP API reads and edits online state and signals changes from another machine", async () => {
  await takeOnline(fake.url, cwd);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const state = await (await fetch(`${server.url}/api/boards/demo/state`)).json();
    assert.equal(state.roadmap.roadmapItems[0].id, "alpha");
    const response = await fetch(`${server.url}/api/boards/demo/cards/alpha`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary: "UI edit", baseRevision: state.roadmap.revision }) });
    assert.equal(response.status, 200);
    // Watching only another board must not reach the hosted service.
    await fetch(`${server.url}/api/live?repoId=some-local-board`);
    const before = fake.requests.filter((req) => req.path.endsWith("/changes")).length;
    await new Promise((resolve) => setTimeout(resolve, 3300));
    assert.equal(fake.requests.filter((req) => req.path.endsWith("/changes")).length, before);
    const live = await (await fetch(`${server.url}/api/live?repoId=demo`)).json();
    await storage.updateCard({ cwd, cardId: "alpha", summary: "Other machine edit", baseRevision: (await storage.loadState(cwd)).roadmap.revision });
    await new Promise((resolve) => setTimeout(resolve, 3300));
    const changed = await (await fetch(`${server.url}/api/live?repoId=demo`)).json();
    assert.ok(changed.stateVersion > live.stateVersion);
    assert.ok(fake.requests.some((req) => req.path.endsWith("/changes")));
    const stale = await fetch(`${server.url}/api/boards/demo/cards/alpha`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary: "stale", baseRevision: 0 }) });
    assert.equal(stale.status, 409);
    const draft = await fetch(`${server.url}/api/boards/demo/cards/alpha/codex-thread/draft`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "codex://threads/new", launchToken: "demo" }) });
    assert.equal(draft.status, 422);
    assert.match((await draft.json()).error, /not yet available for Online Boards/);
  } finally { await server.close(); }
});

test("local stdio MCP dispatches online reads and mutations", async () => {
  await takeOnline(fake.url, cwd);
  const child = spawn(process.execPath, ["plugins/planban/scripts/start-planban-mcp.mjs"], {
    env: { ...process.env, PLANBAN_REPO_ROOT: resolve("."), PLANBAN_ACTIVITY_URL: fake.url }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP timeout")); }, 10_000);
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(stderr)); });
  });
  child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "planban_update_card", arguments: { cwd, cardId: "alpha", summary: "MCP edit", baseRevision: (await storage.loadState(cwd)).roadmap.revision } } }) + "\n");
  await exit;
  const result = JSON.parse(output.trim()).result;
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal((await storage.loadState(cwd)).roadmap.roadmapItems[0]!.summary, "MCP edit");
});

test("logout removes only the chosen service and missing login never uses local files", async () => {
  await takeOnline(fake.url, cwd);
  await saveCredentials("https://another.example", { clientId: "other", accessToken: "other-token", refreshToken: "other-refresh", expiresAt: new Date().toISOString() });
  await execFileAsync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", "online", "logout", fake.url], { env: process.env });
  assert.equal((await readCredentials()).services[fake.url], undefined);
  assert.ok((await readCredentials()).services["https://another.example"]);
  await assert.rejects(storage.loadState(cwd), OnlineAuthenticationError);
});

test("stale local checkouts cannot edit or reinitialize a transferred planning root", async () => {
  const other = join(root, "stale-checkout");
  await mkdir(join(other, ".planban"), { recursive: true });
  await writeFile(manifestPath(other), await readFile(manifestPath(cwd)));
  await takeOnline(fake.url, cwd);
  await assert.rejects(storage.updateCard({ cwd: other, cardId: "alpha", summary: "stale local edit" }), /roadmap is missing/);
  await assert.rejects(storage.initializeProject({ cwd: other, repoId: "demo", updateAgents: false }), /recovery snapshot/);
  assert.notEqual(fake.bundle.roadmap.roadmapItems[0]!.summary, "stale local edit");
});

test("invalid export paths leave the hosted fence and online manifest intact", async () => {
  await takeOnline(fake.url, cwd);
  fake.bundle.roadmap.roadmapItems[0]!.specDoc = "../../escaped-spec.md";
  await assert.rejects(takeLocal(cwd), /must stay inside/);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  assert.equal(fake.authority, "returned-local");
  assert.equal(await storage.pathExists(join(process.env.PLANBAN_HOME!, "escaped-spec.md")), false);
});

test("export documents cannot replace the local roadmap, history index or lock", async () => {
  await takeOnline(fake.url, cwd);
  for (const path of ["roadmap.json", "history/index.json", ".planban-write.lock/owner.json"]) {
    fake.bundle.roadmap.roadmapItems[0]!.specDoc = path;
    await assert.rejects(takeLocal(cwd), (error: any) => error instanceof storage.PlanbanValidationError && /conflicting document path/.test(error.message));
    assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  }
});

async function killedAt(point: string, args: string[]) {
  const failure = await execFileAsync(process.execPath, ["--import", "tsx/esm", "src/cli.ts", ...args], {
    env: { ...process.env, PLANBAN_TEST_CRASH_AT: point },
  }).then(() => null, (error) => error);
  assert.equal(failure?.signal, "SIGKILL", `expected the process to be killed at ${point}`);
}

test("take-online killed mid-upload leaves the board local, and running it again finishes once", async () => {
  const before = await storage.loadState(cwd);
  await killedAt("take-online:after-part", ["online", "take-online", fake.url, "--cwd", cwd]);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
  assert.equal(await storage.pathExists(before.roadmapPath), true);
  assert.equal([...fake.transfers.values()].some((transfer) => transfer.state === "committed"), false);
  const result = await takeOnline(fake.url, cwd);
  assert.equal(result.boardId, "demo");
  assert.equal([...fake.transfers.values()].filter((transfer) => transfer.state === "committed").length, 1);
  assert.equal(fake.transfers.size, 1, "the resumed upload reuses the same transfer");
  assert.equal((await storage.loadState(cwd)).manifest.storage?.kind, "online");
  assert.equal(await storage.pathExists(join(before.planningRoot, "online-transfer.json")), false);
});

test("take-online killed after the upload committed finishes on retry and reports later local edits", async () => {
  const before = await storage.loadState(cwd);
  await killedAt("take-online:after-commit", ["online", "take-online", fake.url, "--cwd", cwd]);
  assert.equal(fake.authority, "online");
  assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
  // An edit made on this machine after the upload, before the retry.
  await storage.createCard({ cwd, title: "Made after the upload" });
  const result = await takeOnline(fake.url, cwd);
  assert.equal([...fake.transfers.values()].filter((transfer) => transfer.state === "committed").length, 1);
  assert.deepEqual(result.unsyncedLocalChanges?.map((change) => change.summary), ["Created Made after the upload"]);
  assert.equal(fake.bundle.roadmap.roadmapItems.some((item) => item.title === "Made after the upload"), false);
  // The local edit is kept as recovery evidence.
  assert.ok(JSON.parse(await readFile(result.localSnapshot, "utf8")).roadmapItems.some((item: { title: string }) => item.title === "Made after the upload"));
  assert.equal((await storage.loadState(cwd)).manifest.storage?.kind, "online");
  assert.equal(await storage.pathExists(before.roadmapPath), false);
});

test("take-local killed mid-download keeps the online board intact, and running it again finishes", async () => {
  await takeOnline(fake.url, cwd);
  const online = await storage.loadState(cwd);
  await killedAt("take-local:mid-download", ["online", "take-local", "--cwd", cwd]);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  assert.equal(fake.authority, "returned-local");
  await assert.rejects(storage.updateCard({ cwd, cardId: "alpha", summary: "late", baseRevision: (await storage.loadState(cwd)).roadmap.revision }), storage.PlanbanConflictError);
  const returned = await takeLocal(cwd);
  const local = await storage.loadState(cwd);
  assert.equal(local.manifest.storage?.kind, "local");
  assert.equal(local.planningRoot, returned.planningRoot);
  assert.deepEqual(local.roadmap.roadmapItems.map((item) => item.id), online.roadmap.roadmapItems.map((item) => item.id));
  assert.equal((await storage.readDoc({ cwd, cardId: "alpha", kind: "spec" })).markdown, "# Original spec");
  assert.equal(await storage.pathExists(join(onlineCacheRoot({ kind: "online", url: fake.url, boardId: "demo" }), "online-transfer.json")), false);
});

test("take-online killed between setting the local roadmap aside and switching the project finishes on retry", async () => {
  const before = await storage.loadState(cwd);
  await killedAt("take-online:after-rename", ["online", "take-online", fake.url, "--cwd", cwd]);
  assert.equal(await storage.pathExists(before.roadmapPath), false);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind ?? "local", "local");
  const result = await takeOnline(fake.url, cwd);
  assert.equal((await storage.loadState(cwd)).manifest.storage?.kind, "online");
  assert.deepEqual(JSON.parse(await readFile(result.localSnapshot, "utf8")), before.roadmap);
  assert.equal([...fake.transfers.values()].filter((transfer) => transfer.state === "committed").length, 1);
});

test("take-local killed after writing the local copy resumes into the same folder", async () => {
  await takeOnline(fake.url, cwd);
  await killedAt("take-local:after-stage", ["online", "take-local", "--cwd", cwd]);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
  const journal = JSON.parse(await readFile(join(onlineCacheRoot({ kind: "online", url: fake.url, boardId: "demo" }), "online-transfer.json"), "utf8"));
  const returned = await takeLocal(cwd);
  assert.equal(returned.planningRoot, journal.root);
  assert.equal((await storage.loadState(cwd)).manifest.storage?.kind, "local");
});

test("an edit whose response is lost is retried with its idempotency key and applied once", async () => {
  await takeOnline(fake.url, cwd);
  const state = await storage.loadState(cwd);
  const versions = fake.bundle.history.length;
  fake.dropNextReply();
  const updated = await storage.updateCard({ cwd, cardId: "alpha", summary: "Exactly once", baseRevision: state.roadmap.revision });
  assert.equal(updated.roadmap.roadmapItems[0]!.summary, "Exactly once");
  assert.equal(fake.bundle.history.length, versions + 1);
  const keys = fake.requests.filter((req) => req.path.endsWith("/ops/updateCard"));
  assert.equal(keys.length, 2, "the edit was sent twice");
});

test("online edits must state the version they were based on", async () => {
  await takeOnline(fake.url, cwd);
  await assert.rejects(storage.updateCard({ cwd, cardId: "alpha", summary: "No base" }), (error: any) => error instanceof storage.PlanbanValidationError && /baseRevision/.test(error.message));
});

test("when live updates fail, the board server checks for changes instead", async () => {
  await takeOnline(fake.url, cwd);
  fake.failLiveToken();
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as any).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const server = await startServer({ cwd, port, useVite: false });
  try {
    const live = await (await fetch(`${server.url}/api/live?repoId=demo`)).json();
    await storage.updateCard({ cwd, cardId: "alpha", summary: "Changed elsewhere", baseRevision: (await storage.loadState(cwd)).roadmap.revision });
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const changed = await (await fetch(`${server.url}/api/live?repoId=demo`)).json();
    assert.ok(fake.requests.some((req) => req.path === "/api/v1/live-token"));
    assert.ok(fake.requests.some((req) => req.path.endsWith("/changes")), "fell back to checking for changes");
    assert.ok(changed.stateVersion > live.stateVersion);
  } finally { await server.close(); }
});

/** Another machine's local copy of the demo board: a copy of its planning root, used from a second project. */
async function secondMachineCopy() {
  const source = (await storage.loadState(cwd)).planningRoot;
  const copyRoot = join(root, "second-machine-planning");
  await cp(source, copyRoot, { recursive: true });
  const second = join(root, "second-machine-project");
  await mkdir(join(second, ".planban"), { recursive: true });
  await writeFile(manifestPath(second), JSON.stringify({ version: 1, repoId: "demo", enabled: true, storage: { kind: "local", root: copyRoot } }));
  resetCopyChecks();
  return { second, copyRoot };
}

const revisionOf = async (project: string) => (await storage.loadState(project)).roadmap.revision;

test("a local copy of a board taken online elsewhere refuses writes and says how to continue", async () => {
  const { second, copyRoot } = await secondMachineCopy();
  await storage.updateCard({ cwd: second, cardId: "alpha", summary: "Before it went online", baseRevision: await revisionOf(second) });
  await takeOnline(fake.url, cwd);
  resetCopyChecks();
  await assert.rejects(storage.updateCard({ cwd: second, cardId: "alpha", summary: "Too late", baseRevision: await revisionOf(second) }),
    (error: any) => error instanceof PlanbanStaleCopyError && /taken online/.test(error.message) && /--replace-stale-copy/.test(error.message) && /keep-local-copy/.test(error.message));
  assert.equal((await storage.loadState(second)).roadmap.roadmapItems[0]!.summary, "Before it went online", "reads still work");
  assert.ok(await storage.pathExists(join(copyRoot, STALE_MARKER)));
  // The refusal survives the service being unreachable.
  fake.failCopyCheck(true);
  resetCopyChecks();
  await assert.rejects(storage.writeDoc({ cwd: second, cardId: "alpha", kind: "spec", markdown: "x" }), PlanbanStaleCopyError);
});

test("a stale copy with unsynced edits reports them and keeps them when attaching to the online board", async () => {
  const { second, copyRoot } = await secondMachineCopy();
  // Edited on the second machine, never synced, while the first machine takes the board online.
  await storage.createCard({ cwd: second, title: "Only on the second machine", baseRevision: await revisionOf(second) });
  await takeOnline(fake.url, cwd);
  resetCopyChecks();
  const refusal = await storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }).then(() => null, (error) => error);
  assert.ok(refusal instanceof PlanbanStaleCopyError);
  assert.deepEqual(refusal.stale.unsyncedChanges.map((change: { summary: string }) => change.summary), ["Created Only on the second machine"]);
  assert.match(refusal.message, /1 change\(s\) on this machine never reached the online board/);
  await assert.rejects(attachOnline(fake.url, "demo", second), /already has a different board/);
  const attached = await attachOnline(fake.url, "demo", second, { replaceStaleCopy: true });
  assert.equal((await storage.loadState(second)).manifest.storage?.kind, "online");
  assert.deepEqual(attached.staleCopy?.unsyncedChanges.map((change) => change.summary), ["Created Only on the second machine"]);
  assert.match(await readFile(attached.staleCopy!.report, "utf8"), /Only on the second machine/);
  assert.ok(JSON.parse(await readFile(attached.staleCopy!.snapshot, "utf8")).roadmapItems.some((item: { title: string }) => item.title === "Only on the second machine"));
  assert.equal(await storage.pathExists(join(copyRoot, "roadmap.json")), false);
});

test("when the service cannot be reached, a local write goes ahead and is reported later if the copy turns out stale", async () => {
  const { second } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  fake.failCopyCheck(true);
  resetCopyChecks();
  await storage.createCard({ cwd: second, title: "Written offline", baseRevision: await revisionOf(second) });
  fake.failCopyCheck(false);
  resetCopyChecks();
  const refusal = await storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }).then(() => null, (error) => error);
  assert.ok(refusal instanceof PlanbanStaleCopyError);
  assert.deepEqual(refusal.stale.unsyncedChanges.map((change: { summary: string }) => change.summary), ["Created Written offline"]);
});

test("a board with the same id but unrelated history is not treated as a stale copy", async () => {
  await takeOnline(fake.url, cwd);
  const other = join(root, "unrelated");
  await storage.initializeProject({ cwd: other, repoId: "unrelated-board", title: "Unrelated", updateAgents: false });
  const otherRoot = (await storage.loadState(other)).planningRoot;
  await writeFile(manifestPath(other), JSON.stringify({ version: 1, repoId: "demo", enabled: true, storage: { kind: "local", root: otherRoot } }));
  resetCopyChecks();
  await storage.createCard({ cwd: other, title: "Fine", baseRevision: await revisionOf(other) });
  assert.ok(fake.requests.some((req) => req.path === "/api/v1/copy-check"));
});

test("keeping a stale copy as a separate local board renames it and stops the checks for it", async () => {
  const { second, copyRoot } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  resetCopyChecks();
  await assert.rejects(storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }), PlanbanStaleCopyError);
  const kept = await keepLocalCopy(second, "demo-local");
  assert.equal(kept.repoId, "demo-local");
  resetCopyChecks();
  const state = await storage.loadState(second);
  assert.equal(state.manifest.repoId, "demo-local");
  assert.match(state.roadmap.project.title, /local copy/);
  await storage.updateCard({ cwd: second, cardId: "alpha", summary: "Mine now", baseRevision: state.roadmap.revision });
  assert.equal(await storage.pathExists(join(copyRoot, STALE_MARKER)), false);
});

test("a machine that never signed in makes no network calls for local boards", async () => {
  await saveCredentials(fake.url, null);
  resetCopyChecks();
  const start = fake.requests.length;
  await storage.updateCard({ cwd, cardId: "alpha", summary: "Offline machine", baseRevision: await revisionOf(cwd) });
  await storage.loadState(cwd);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.requests.length, start);
});

test("signing in checks the machine's local boards for stale copies", async () => {
  const { second } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  // On the second machine, its own registry lists its local copy.
  await registerBoardFromCwd(second);
  resetCopyChecks();
  const result: any = await onlineLogin(fake.url, { user: "owner", passwordEnv: "PLANBAN_ONLINE_TEST_PASSWORD" });
  assert.ok(result.staleLocalCopies?.some((copy: { repoId: string; onlineBoard: string }) => copy.repoId === "demo" && copy.onlineBoard === "demo"));
});

test("every machine keeps a local backup of an Online Board it uses, and it restores into a new local board", async () => {
  await takeOnline(fake.url, cwd);
  const backup = join(backupRoot(fake.url, "demo"), "latest");
  assert.equal(JSON.parse(await readFile(join(backup, "roadmap.json"), "utf8")).roadmapItems[0].id, "alpha");
  assert.equal(await readFile(join(backup, "docs", "alpha.spec.md"), "utf8"), "# Original spec");
  const second = join(root, "second-machine");
  await attachOnline(fake.url, "demo", second);
  const doc = await storage.readDoc({ cwd: second, cardId: "alpha", kind: "spec" });
  await storage.writeDoc({ cwd: second, cardId: "alpha", kind: "spec", markdown: "# Changed online", expectedMtimeMs: doc.mtimeMs });
  await storage.updateCard({ cwd: second, cardId: "alpha", summary: "Backed up", baseRevision: await revisionOf(second) });
  const before = fake.requests.length;
  await refreshBackup(fake.url, "demo", { force: true });
  const fetched = fake.requests.slice(before).filter((req) => req.path.includes("/docs/")).map((req) => req.path);
  assert.deepEqual(fetched, ["/api/v1/boards/demo/docs/alpha/spec"], "only the changed document is downloaded");
  assert.equal(await readFile(join(backup, "docs", "alpha.spec.md"), "utf8"), "# Changed online");
  assert.equal(JSON.parse(await readFile(join(backup, "roadmap.json"), "utf8")).roadmapItems[0].summary, "Backed up");
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(await storage.pathExists(join(backupRoot(fake.url, "demo"), "daily", today, "roadmap.json")));

  const restoredCwd = join(root, "restored");
  const restored = await restoreBackup(backup, restoredCwd, "demo-restored");
  assert.equal(restored.cards, 1);
  const state = await storage.loadState(restoredCwd);
  assert.equal(state.manifest.storage?.kind, "local");
  assert.equal(state.roadmap.roadmapItems[0]!.summary, "Backed up");
  assert.equal((await storage.readDoc({ cwd: restoredCwd, cardId: "alpha", kind: "spec" })).markdown, "# Changed online");
});

test("signing out revokes this machine's connection on the service, then forgets it locally", async () => {
  const result = await onlineLogout(fake.url);
  assert.equal(result.revoked, true);
  assert.ok(fake.revokedTokens.has("Bearer access-0"));
  assert.equal((await readCredentials()).services[fake.url], undefined);
});

test("signing out while the service is unreachable still forgets the sign-in and says the connection remains", async () => {
  const unreachable = "http://127.0.0.1:9";
  await saveCredentials(unreachable, { clientId: "cli", accessToken: "access-x", refreshToken: "", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  const result = await onlineLogout(unreachable);
  assert.equal(result.revoked, false);
  assert.match(result.note ?? "", /stays active until you revoke it/);
  assert.equal((await readCredentials()).services[unreachable], undefined);
});

test("a backup refresh that fails keeps the last good backup", async () => {
  await takeOnline(fake.url, cwd);
  const latest = join(backupRoot(fake.url, "demo"), "latest");
  await rm(join(latest, "backup.json"));
  fake.failExportDocs(true);
  assert.equal(await refreshBackup(fake.url, "demo", { force: true }), null);
  assert.equal(JSON.parse(await readFile(join(latest, "roadmap.json"), "utf8")).roadmapItems[0].id, "alpha");
  assert.equal(await readFile(join(latest, "docs", "alpha.spec.md"), "utf8"), "# Original spec");
});

test("take-local killed right after switching the project tells the service before the board is taken online again", async () => {
  await takeOnline(fake.url, cwd);
  await killedAt("take-local:after-publish", ["online", "take-local", "--cwd", cwd]);
  const local = await storage.loadState(cwd);
  assert.equal(local.manifest.storage?.kind, "local");
  assert.ok(await storage.pathExists(join(local.planningRoot, "online-transfer.json")));
  const start = fake.requests.length;
  await takeOnline(fake.url, cwd);
  const steps = fake.requests.slice(start).map((req) => req.path);
  assert.ok(steps.indexOf("/api/v1/boards/demo/take-local/finish") >= 0);
  assert.ok(steps.indexOf("/api/v1/boards/demo/take-local/finish") < steps.indexOf("/api/v1/transfers"));
});

test("a stale copy is recognised by the board's identity however many edits it has made since", async () => {
  const { second } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  fake.failCopyCheck(true);
  resetCopyChecks();
  for (let index = 0; index < 60; index += 1) await storage.createCard({ cwd: second, title: `Offline ${index}`, baseRevision: await revisionOf(second) });
  fake.failCopyCheck(false);
  resetCopyChecks();
  const refusal = await storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }).then(() => null, (error) => error);
  assert.ok(refusal instanceof PlanbanStaleCopyError);
});

test("a copy of a board made before identities existed is still recognised by its oldest shared history", async () => {
  await rm(join((await storage.loadState(cwd)).planningRoot, "board-identity.json"));
  const { second, copyRoot } = await secondMachineCopy();
  await takeOnline(fake.url, cwd);
  await rm(join(copyRoot, "board-identity.json"), { force: true });
  fake.failCopyCheck(true);
  resetCopyChecks();
  for (let index = 0; index < 60; index += 1) await storage.createCard({ cwd: second, title: `Offline ${index}`, baseRevision: await revisionOf(second) });
  fake.failCopyCheck(false);
  resetCopyChecks();
  const refusal = await storage.updateCard({ cwd: second, cardId: "alpha", summary: "x", baseRevision: await revisionOf(second) }).then(() => null, (error) => error);
  assert.ok(refusal instanceof PlanbanStaleCopyError);
  assert.equal(refusal.stale.unsyncedChanges.length, 60);
});

test("take-online with attachments uploads card files once, and take-local brings them back", async () => {
  const before = await storage.loadState(cwd);
  const folder = join(before.planningRoot, "items", "alpha");
  await mkdir(join(folder, "renders", "__pycache__"), { recursive: true });
  await writeFile(join(folder, "renders", "front.png"), Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  await writeFile(join(folder, "notes.txt"), "Fabric notes");
  await writeFile(join(folder, "model.blend1"), "autosave");
  await writeFile(join(folder, "renders", "__pycache__", "x.pyc"), "cache");
  const result: any = await takeOnline(fake.url, cwd, { attachments: true });
  assert.equal(result.attachments.files, 2);
  assert.equal(result.attachments.uploaded, 2);
  assert.deepEqual(result.attachments.skipped.map((entry: { path: string }) => entry.path).sort(), ["model.blend1", "renders/__pycache__"]);
  assert.deepEqual([...fake.attachments.values()].map((entry) => entry.path).sort(), ["notes.txt", "renders/front.png"]);
  const returned = await takeLocal(cwd);
  assert.deepEqual([...await readFile(join(returned.planningRoot, "items", "alpha", "renders", "front.png"))], [137, 80, 78, 71, 1, 2, 3]);
  assert.equal(await readFile(join(returned.planningRoot, "items", "alpha", "notes.txt"), "utf8"), "Fabric notes");
});

test("take-local never writes an attachment outside the board's folder, whatever the card id", async () => {
  await takeOnline(fake.url, cwd);
  fake.blobs.set("f".repeat(64), Buffer.from("escape"));
  fake.attachments.set("evil", { id: "evil", cardId: "../../outside", path: "proof.txt", sha256: "f".repeat(64), size: 6, contentType: "text/plain", uploadedBy: "x", uploadedAt: new Date().toISOString() });
  await assert.rejects(takeLocal(cwd), /Unsafe card id/);
  assert.equal(await storage.pathExists(join(root, "home", "outside", "proof.txt")), false);
  assert.equal((await storage.readManifest(cwd))?.storage?.kind, "online");
});
