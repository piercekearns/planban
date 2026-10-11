// HTTP entry points: the REST API that local Planban installs use for an
// Online Board, and development sign-in on local backends.
import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { authenticate, devAuthEnabled, publicOrigin, randomSecret, sha256Hex, type Authenticated } from "./model/auth";
import { CLOCK_SKEW_SECONDS, clerkConfigured, verifyClerkAccessToken } from "./model/clerk";
import type { ServiceErrorData } from "./model/errors";
import { liveTokensConfigured, publicJwks, signLiveToken } from "./model/liveToken";
import { handleMcp, McpService } from "./model/mcp";
import { streamParts } from "./model/blobs";
import { Sha256 } from "./model/sha256";

const STATUS_FOR: Record<ServiceErrorData["code"], number> = {
  conflict: 409,
  validation: 400,
  not_found: 404,
  forbidden: 403,
  unauthorized: 401,
};

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ConvexError) {
    const data = error.data as ServiceErrorData;
    return json({ error: data }, STATUS_FOR[data.code] ?? 400);
  }
  console.error("Unexpected service error", error instanceof Error ? error.name : typeof error);
  return json({ error: { code: "internal", message: "The Online Board service failed. Try again." } }, 500);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const unauthorized = () => json(
  { error: { code: "unauthorized", message: "Sign in to Planban Online first." } },
  401,
  { "WWW-Authenticate": 'Bearer realm="planban"' },
);

async function handleApi(ctx: ActionCtx, request: Request, auth: Authenticated): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/v1\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const method = request.method;
  const { connectionId } = auth;

  if (parts[0] === "me" && parts.length === 1 && method === "GET") return json(await ctx.runQuery(internal.boards.me, { connectionId }));
  if (parts[0] === "live-token" && parts.length === 1 && method === "POST") {
    if (!liveTokensConfigured()) return json({ error: { code: "not_found", message: "Live updates are not configured." } }, 404);
    await ctx.runQuery(internal.boards.me, { connectionId });
    return json({ ...(await signLiveToken(connectionId)), convexUrl: process.env.CONVEX_CLOUD_URL });
  }
  if (parts[0] === "transfers" && method === "POST") {
    // Take Online in parts: begin (with the roadmap), parts, commit; or abort.
    const input = await body(request);
    if (parts.length === 1) {
      return json(await ctx.runMutation(internal.transfers.begin, {
        connectionId, transferId: String(input.transferId ?? ""), roadmap: input.roadmap,
        ...(typeof input.uid === "string" ? { uid: input.uid } : {}),
        ...(input.retention === undefined ? {} : { retention: input.retention }),
        ...(Array.isArray(input.retiredIds) ? { retiredIds: input.retiredIds.map(String) } : {}),
      }));
    }
    const transferId = parts[1]!;
    if (parts[2] === "parts" && parts.length === 3) {
      return json(await ctx.runMutation(internal.transfers.part, {
        connectionId, transferId, seq: Number(input.seq),
        ...(input.docs === undefined ? {} : { docs: input.docs }),
        ...(input.history === undefined ? {} : { history: input.history }),
        ...(input.historyDocs === undefined ? {} : { historyDocs: input.historyDocs }),
      }));
    }
    if (parts[2] === "commit" && parts.length === 3) return json(await ctx.runMutation(internal.transfers.commit, { connectionId, transferId, partCount: Number(input.partCount) }));
    if (parts[2] === "abort" && parts.length === 3) return json(await ctx.runMutation(internal.transfers.abort, { connectionId, transferId }));
  }
  if (parts[0] === "copy-check" && parts.length === 1 && method === "POST") {
    const input = await body(request);
    const fingerprints = Array.isArray(input.fingerprints) ? input.fingerprints
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({ version: Number(item.version), createdAt: String(item.createdAt ?? ""), operation: String(item.operation ?? "") }))
      .filter((item) => Number.isInteger(item.version)) : [];
    return json(await ctx.runQuery(internal.copies.check, { connectionId, fingerprints, ...(typeof input.uid === "string" ? { uid: input.uid } : {}) }));
  }
  if (parts[0] === "connections" && parts.length === 1 && method === "GET") return json(await ctx.runQuery(internal.connections.list, { connectionId }));
  if (parts[0] === "connections" && parts.length === 3 && parts[2] === "revoke" && method === "POST") {
    return json(await ctx.runMutation(internal.connections.revoke, { connectionId, targetId: parts[1]! }));
  }
  if (parts[0] === "connections" && parts.length === 3 && parts[2] === "access" && method === "POST") {
    const input = await body(request);
    const level = input.level === "read" || input.level === "plan" || input.level === "complete" ? input.level : undefined;
    const boards = input.boards === "all" ? "all" as const : Array.isArray(input.boards) ? input.boards.map(String) : undefined;
    return json(await ctx.runMutation(internal.connections.setAccess, { connectionId, targetId: parts[1]!, ...(level ? { level } : {}), ...(boards !== undefined ? { boards } : {}) }));
  }
  if (parts[0] === "connections" && parts.length === 3 && parts[2] === "restore" && method === "POST") {
    return json(await ctx.runMutation(internal.connections.restore, { connectionId, targetId: parts[1]! }));
  }
  if (parts[0] === "keys" && parts.length === 1 && method === "POST") {
    const input = await body(request);
    const level = input.level === "read" || input.level === "plan" || input.level === "complete" ? input.level : null;
    if (!level) return json({ error: { code: "validation", message: "level must be read, plan or complete." } }, 400);
    const days = input.expiresInDays === undefined ? undefined : Number(input.expiresInDays);
    if (days !== undefined && !(Number.isInteger(days) && days > 0 && days <= 3650)) return json({ error: { code: "validation", message: "expiresInDays must be a whole number of days." } }, 400);
    const token = randomSecret("pbk_");
    const created = await ctx.runMutation(internal.connections.createKey, {
      connectionId, tokenHash: await sha256Hex(token), name: String(input.name ?? ""), boardId: String(input.boardId ?? ""), level,
      ...(days === undefined ? {} : { expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString() }),
    });
    // The key is shown once; only its hash is stored.
    return json({ ...created, key: token }, 201);
  }
  if (parts[0] !== "boards") return json({ error: { code: "not_found", message: "Unknown endpoint." } }, 404);
  if (parts.length === 1 && method === "GET") return json({ boards: await ctx.runQuery(internal.boards.listBoards, { connectionId }) });
  if (parts[1] === "import" && parts.length === 2 && method === "POST") {
    return json(await ctx.runMutation(internal.transfers.importBundle, { connectionId, transferId: crypto.randomUUID(), bundle: await body(request) }), 201);
  }

  const boardId = parts[1]!;
  const rest = parts.slice(2);
  if (rest.length === 0 && method === "GET") {
    const since = url.searchParams.get("since");
    return json(await ctx.runQuery(internal.boards.getBoard, { connectionId, boardId, ...(since === null ? {} : { since: Number(since) }) }));
  }
  if (rest[0] === "export" && rest.length === 1 && method === "GET") return json(await ctx.runQuery(internal.boards.exportBoard, { connectionId, boardId }));
  const transfer = url.searchParams.get("transferId");
  const bound = transfer === null ? {} : { transferId: transfer };
  if (rest[0] === "export" && rest[1] === "meta" && method === "GET") return json(await ctx.runQuery(internal.boards.exportMeta, { connectionId, boardId, ...bound }));
  if (rest[0] === "export" && rest[1] === "docs" && method === "GET") {
    const atRevision = url.searchParams.get("revision");
    return json(await ctx.runQuery(internal.boards.exportDocs, {
      connectionId, boardId, offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 100), ...bound,
      ...(atRevision === null ? {} : { revision: Number(atRevision) }),
    }));
  }
  if (rest[0] === "export" && rest[1] === "history" && method === "GET") {
    return json(await ctx.runQuery(internal.boards.exportHistory, { connectionId, boardId, after: Number(url.searchParams.get("after") ?? 0), limit: Number(url.searchParams.get("limit") ?? 8), ...bound }));
  }
  if (rest[0] === "history" && method === "GET") {
    const after = url.searchParams.get("after");
    return json(await ctx.runQuery(internal.boards.history, { connectionId, boardId, ...(after === null ? {} : { after: Number(after) }) }));
  }
  if (rest[0] === "changes" && method === "GET") {
    // Live updates use Convex subscriptions; this one-shot check remains for
    // clients that cannot subscribe.
    const { revision } = await ctx.runQuery(internal.boards.revision, { connectionId, boardId });
    return json({ revision });
  }
  if (rest[0] === "members" && method === "GET") return json({ members: await ctx.runQuery(internal.members.list, { connectionId, boardId }) });
  if (rest[0] === "members" && method === "POST") {
    const input = await body(request);
    const role = input.role === "viewer" ? "viewer" : "editor";
    return json({ members: await ctx.runMutation(internal.members.add, { connectionId, boardId, userId: String(input.userId ?? ""), role }) });
  }
  if (rest[0] === "take-local" && rest[1] === "fence" && method === "POST") {
    const input = await body(request);
    return json(await ctx.runMutation(internal.boards.fence, {
      connectionId, boardId, transferId: String(input.transferId ?? ""),
      ...(typeof input.expectedGeneration === "number" ? { expectedGeneration: input.expectedGeneration } : {}),
    }));
  }
  if (rest[0] === "take-local" && rest[1] === "finish" && method === "POST") {
    const input = await body(request);
    return json(await ctx.runMutation(internal.boards.finishTakeLocal, { connectionId, boardId, transferId: String(input.transferId ?? "") }));
  }
  if (rest[0] === "ops" && rest.length === 2 && method === "POST") {
    // A retried edit carries the same Idempotency-Key and byte-identical body.
    const raw = await request.text();
    let input: unknown = {};
    try {
      input = JSON.parse(raw || "{}");
    } catch {
      return json({ error: { code: "validation", message: "The request body must be JSON." } }, 400);
    }
    const idempotencyKey = request.headers.get("Idempotency-Key");
    return json(await ctx.runMutation(internal.boards.run, {
      connectionId, boardId, op: rest[1]!, input,
      ...(idempotencyKey ? { idempotencyKey, requestHash: await sha256Hex(`${boardId}\n${rest[1]}\n${raw}`) } : {}),
    }));
  }
  if (rest[0] === "attachments") {
    if (rest.length === 1 && method === "GET") {
      const cardId = url.searchParams.get("cardId");
      return json(await ctx.runQuery(internal.attachments.list, { connectionId, boardId, ...(cardId ? { cardId } : {}) }));
    }
    if (rest[1] === "begin" && rest.length === 2 && method === "POST") {
      const input = await body(request);
      const file = { cardId: String(input.cardId ?? ""), path: String(input.path ?? ""), sha256: String(input.sha256 ?? ""), size: Number(input.size), contentType: String(input.contentType ?? "application/octet-stream") };
      return json(await ctx.runMutation(internal.attachments.begin, { connectionId, boardId, ...file }));
    }
    // One part of an upload, stored by Planban for that upload session only.
    if (rest[1] === "uploads" && rest[3] === "parts" && rest.length === 5 && method === "PUT") {
      const uploadId = rest[2]!;
      const index = Number(rest[4]);
      const { expected } = await ctx.runQuery(internal.attachments.partAllowed, { connectionId, boardId, uploadId, index });
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength !== expected) return json({ error: { code: "validation", message: `This part must be ${expected} bytes.` } }, 400);
      const storageId = await ctx.storage.store(new Blob([bytes]));
      const recorded = await ctx.runMutation(internal.attachments.recordPart, { connectionId, boardId, uploadId, index, storageId, size: bytes.byteLength });
      if (!recorded.stored) return json({ error: { code: "conflict", message: "This upload is no longer open." } }, 409);
      return json({ stored: true, index });
    }
    if (rest[1] === "finish" && rest.length === 2 && method === "POST") {
      const input = await body(request);
      const uploadId = String(input.uploadId ?? "");
      const { state, parts } = await ctx.runQuery(internal.attachments.partsToVerify, { connectionId, boardId, uploadId });
      // Hash what actually arrived, part by part.
      const hash = new Sha256();
      let size = 0;
      if (state === "open") {
        for (const part of parts) {
          const blob = await ctx.storage.get(part.storageId);
          if (!blob) return json({ error: { code: "conflict", message: "A part of this upload is missing. Send it again." } }, 409);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          hash.update(bytes);
          size += bytes.byteLength;
        }
      }
      const finished = await ctx.runMutation(internal.attachments.complete, {
        connectionId, boardId, uploadId, sha256: state === "open" ? hash.hex() : "", size,
        // Exactly the parts that were hashed; if any changed meanwhile, completing is refused.
        partIds: parts.map((part) => part.id),
      });
      if ("rejected" in finished) return json({ error: { code: "validation", message: finished.rejected } }, 400);
      return json(finished);
    }
    if (rest.length === 3 && rest[2] === "delete" && method === "POST") return json(await ctx.runMutation(internal.attachments.remove, { connectionId, boardId, attachmentId: rest[1]! }));
    if (rest.length === 2 && method === "GET") {
      const located = await ctx.runQuery(internal.attachments.locate, { connectionId, boardId, attachmentId: rest[1]! });
      return streamParts(ctx, located.parts, located.contentType);
    }
  }
  if (rest[0] === "docs" && rest.length === 3 && method === "GET") {
    const kind = rest[2] === "plan" ? "plan" : rest[2] === "spec" ? "spec" : null;
    if (!kind) return json({ error: { code: "validation", message: "kind must be spec or plan." } }, 400);
    return json(await ctx.runQuery(internal.boards.readDoc, { connectionId, boardId, cardId: rest[1]!, kind }));
  }
  return json({ error: { code: "not_found", message: "Unknown endpoint." } }, 404);
}

const api = httpAction(async (ctx, request) => {
  try {
    const auth = await authenticate(ctx, request);
    if (!auth) return unauthorized();
    return await handleApi(ctx, request, auth);
  } catch (error) {
    return errorResponse(error);
  }
});

/** Development sign-in for local backends only: returns a bearer token for a named test person. */
const devToken = httpAction(async (ctx, request) => {
  if (!devAuthEnabled()) return json({ error: { code: "not_found", message: "Unknown endpoint." } }, 404);
  const input = await body(request);
  const userId = typeof input.userId === "string" && /^[a-z0-9-]{1,40}$/.test(input.userId) ? input.userId : null;
  if (!userId) return json({ error: { code: "validation", message: "userId must be a short lowercase id." } }, 400);
  const boards = Array.isArray(input.boards) && input.boards.every((board) => typeof board === "string") ? input.boards as string[] : "all";
  const level = input.level === "read" || input.level === "plan" || input.level === "complete" ? input.level : boards === "all" ? "complete" : "plan";
  const token = randomSecret("pbd_");
  const { connectionId } = await ctx.runMutation(internal.connections.createDevConnection, {
    tokenHash: await sha256Hex(token),
    userId,
    clientName: typeof input.clientName === "string" ? input.clientName.slice(0, 80) : "Planban development sign-in",
    boards,
    level,
  });
  return json({ token, connectionId, userId }, 201);
});

/**
 * Remote MCP over Streamable HTTP. An unauthenticated request gets the
 * standard challenge pointing at the protected resource metadata, which
 * names the sign-in server MCP clients use for OAuth.
 */
const mcp = httpAction(async (ctx, request) => {
  try {
    const auth = await authenticate(ctx, request);
    if (!auth) {
      return json({ error: { code: "unauthorized", message: "Sign in to Planban Online first." } }, 401, {
        "WWW-Authenticate": `Bearer realm="planban", resource_metadata="${publicOrigin()}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    return await handleMcp(request, new McpService(ctx, auth.connectionId), publicOrigin());
  } catch (error) {
    return errorResponse(error);
  }
});

/** RFC 9728 metadata: Clerk is the sign-in server (CLERK_ISSUER). */
function protectedResourceFor(path: string) {
  return httpAction(async () => json({
    resource: `${publicOrigin()}${path}`,
    authorization_servers: process.env.CLERK_ISSUER ? [process.env.CLERK_ISSUER] : [],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    resource_name: "Planban Online",
  }, 200, { "Cache-Control": "public, max-age=300" }));
}

// AI apps require the resource to equal the address they were given exactly,
// so the MCP endpoint has its own document naming /mcp.
const protectedResource = protectedResourceFor("");
const protectedMcpResource = protectedResourceFor("/mcp");


/**
 * The command line's browser sign-in, last step: it presents the Clerk access
 * token it just received for the Planban command-line client, and gets a
 * Planban sign-in for this machine (owner decision 6: it lasts until sign-out
 * or 90 days unused). Only fresh tokens for that client are accepted.
 */
const MACHINE_EXCHANGE_SECONDS = 10 * 60;
const machineSignIn = httpAction(async (ctx, request) => {
  try {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
    const token = match ? await verifyClerkAccessToken(ctx, match[1]!, publicOrigin()) : null;
    if (!token || token.clientId !== process.env.PLANBAN_CLI_CLIENT_ID || Date.now() / 1000 - token.issuedAt > MACHINE_EXCHANGE_SECONDS) {
      return json({ error: { code: "unauthorized", message: "Sign in again: the sign-in was not for the Planban command line, or is too old." } }, 401);
    }
    const input = await body(request);
    const secret = randomSecret("pbm_");
    const { connectionId } = await ctx.runMutation(internal.connections.createMachine, {
      userId: token.sub, tokenHash: await sha256Hex(secret), name: typeof input.name === "string" ? input.name : "",
      exchangeHash: await sha256Hex(match![1]!),
      // Past this, the age check above refuses the token anyway (issue times may be up to the clock skew ahead).
      exchangeExpiresAt: new Date((token.issuedAt + MACHINE_EXCHANGE_SECONDS + CLOCK_SKEW_SECONDS) * 1000).toISOString(),
    });
    return json({ token: secret, connectionId, userId: token.sub }, 201);
  } catch (error) {
    return errorResponse(error);
  }
});

/** What a Planban install needs to know to sign in here. */
const serviceDiscovery = httpAction(async () => json({
  service: "Planban Online",
  resource: publicOrigin(),
  ...(clerkConfigured() && process.env.PLANBAN_CLI_CLIENT_ID ? {
    signIn: {
      issuer: process.env.CLERK_ISSUER,
      cliClientId: process.env.PLANBAN_CLI_CLIENT_ID,
      // The command-line client's registered loopback addresses.
      redirectPorts: [53682, 53683, 53684, 53685, 53686],
      scope: "openid email profile offline_access",
    },
  } : {}),
  devSignIn: devAuthEnabled(),
}, 200, { "Cache-Control": "public, max-age=300" }));

const http = httpRouter();
for (const method of ["GET", "POST", "PUT"] as const) http.route({ pathPrefix: "/api/v1/", method, handler: api });
http.route({ path: "/dev/token", method: "POST", handler: devToken });
for (const method of ["GET", "POST", "DELETE"] as const) http.route({ path: "/mcp", method, handler: mcp });
http.route({ path: "/api/v1/auth/machine", method: "POST", handler: machineSignIn });
http.route({ path: "/.well-known/planban.json", method: "GET", handler: serviceDiscovery });
http.route({ path: "/.well-known/oauth-protected-resource", method: "GET", handler: protectedResource });
http.route({ path: "/.well-known/oauth-protected-resource/mcp", method: "GET", handler: protectedMcpResource });
http.route({
  path: "/.well-known/jwks.json",
  method: "GET",
  handler: httpAction(async () => liveTokensConfigured() ? json(publicJwks(), 200, { "Cache-Control": "public, max-age=300" }) : json({ keys: [] })),
});
export default http;
