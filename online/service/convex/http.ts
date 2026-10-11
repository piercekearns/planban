// HTTP entry points: the REST API that local Planban installs use for an
// Online Board, and development sign-in on local backends.
import { httpRouter } from "convex/server";
import { ConvexError } from "convex/values";
import { internal } from "./_generated/api";
import { httpAction, type ActionCtx } from "./_generated/server";
import { authenticate, devAuthEnabled, randomSecret, sha256Hex, type Authenticated } from "./model/auth";
import type { ServiceErrorData } from "./model/errors";
import { liveTokensConfigured, publicJwks, signLiveToken } from "./model/liveToken";

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
  if (parts[0] !== "boards") return json({ error: { code: "not_found", message: "Unknown endpoint." } }, 404);
  if (parts.length === 1 && method === "GET") return json({ boards: await ctx.runQuery(internal.boards.listBoards, { connectionId }) });
  if (parts[1] === "import" && parts.length === 2 && method === "POST") {
    return json(await ctx.runMutation(internal.boards.importBoard, { connectionId, bundle: await body(request) }), 201);
  }

  const boardId = parts[1]!;
  const rest = parts.slice(2);
  if (rest.length === 0 && method === "GET") {
    const since = url.searchParams.get("since");
    return json(await ctx.runQuery(internal.boards.getBoard, { connectionId, boardId, ...(since === null ? {} : { since: Number(since) }) }));
  }
  if (rest[0] === "export" && method === "GET") return json(await ctx.runQuery(internal.boards.exportBoard, { connectionId, boardId }));
  if (rest[0] === "history" && method === "GET") return json(await ctx.runQuery(internal.boards.history, { connectionId, boardId }));
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
  if (rest[0] === "authority" && method === "POST") {
    const input = await body(request);
    if (input.state !== "online" && input.state !== "returned-local") {
      return json({ error: { code: "validation", message: "state must be online or returned-local." } }, 400);
    }
    return json(await ctx.runMutation(internal.boards.setAuthority, { connectionId, boardId, state: input.state }));
  }
  if (rest[0] === "ops" && rest.length === 2 && method === "POST") {
    return json(await ctx.runMutation(internal.boards.run, { connectionId, boardId, op: rest[1]!, input: await body(request) }));
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

const http = httpRouter();
for (const method of ["GET", "POST"] as const) http.route({ pathPrefix: "/api/v1/", method, handler: api });
http.route({ path: "/dev/token", method: "POST", handler: devToken });
http.route({
  path: "/.well-known/jwks.json",
  method: "GET",
  handler: httpAction(async () => liveTokensConfigured() ? json(publicJwks(), 200, { "Cache-Control": "public, max-age=300" }) : json({ keys: [] })),
});
export default http;
