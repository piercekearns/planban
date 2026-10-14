// A local preview of the hosted web page, for building and screenshots. The
// page runs in hosted mode from Vite, and its /api/v1 calls reach the online
// service's real handlers in memory, the way the edge forwards them. Nothing
// leaves this computer; every restart starts from the same sample board.
//
//   ~/mac-mini-setup/dev24 node --import tsx/esm online/scripts/web-preview.ts [port]
//
// Then open http://127.0.0.1:<port>/dev/as?user=owner (or editor, viewer).
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createVite } from "vite";
import { memoryService } from "../../tests/hosted-harness";
import { apiResponse } from "../service/convex/http";
import { EDGE_PROOF_HEADER } from "../service/convex/model/auth";
import { webCookie } from "../service/convex/model/webSession";

const port = Number(process.argv[2] ?? 4319);
const PUBLIC = `http://127.0.0.1:${port}`;
const NATIVE = "https://preview-native.convex.invalid";
const PROOF = randomBytes(24).toString("base64url");
process.env.PLANBAN_PUBLIC_URL = PUBLIC;
process.env.CONVEX_SITE_URL = NATIVE;
process.env.PLANBAN_EDGE_PROOF_SHA256 = createHash("sha256").update(PROOF).digest("hex");
process.env.VITE_PLANBAN_HOSTED = "1";

const service = memoryService();
const PEOPLE = {
  owner: { userId: "user_sam", name: "Sam Reid" },
  editor: { userId: "user_maya", name: "Maya Okafor" },
  viewer: { userId: "user_jo", name: "Jo Lin" },
} as const;
type Who = keyof typeof PEOPLE;

/** A request as the edge forwards it: at the native address, with the proof. */
function forwarded(path: string, init: { method: string; headers: Headers; body?: Uint8Array | string }) {
  const headers = new Headers(init.headers);
  headers.set(EDGE_PROOF_HEADER, PROOF);
  return new Request(`${NATIVE}${path}`, { method: init.method, headers, ...(init.body === undefined ? {} : { body: init.body as BodyInit }) });
}

async function asPerson(token: string, method: string, path: string, body?: unknown) {
  const headers = new Headers({ "X-Planban-Client": "web", Cookie: `planban_web=${token}`, "Content-Type": "application/json", Origin: PUBLIC, "Sec-Fetch-Site": "same-origin" });
  const response = await apiResponse(service.actionCtx, forwarded(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
}

/** The sample board from the approved mockups: Northfold, shared by three people. */
async function seed() {
  const owner = await service.signIn(PEOPLE.owner.userId, PEOPLE.owner.name);
  const { boardId } = await asPerson(owner.token, "POST", "/api/v1/boards", { title: "Northfold" });
  let revision = 1;
  const card = async (title: string, status: string, nextAction?: string) => {
    const result = await asPerson(owner.token, "POST", `/api/v1/boards/${boardId}/ops/createCard`, { title, status, ...(nextAction ? { nextAction } : {}), baseRevision: revision });
    revision = result.roadmap.revision;
    return result.result.createdCard.id as string;
  };
  await card("Choose the hydration bladder supplier", "in-progress", "Owner: pick a supplier so the sample order can go out this week.");
  await card("Finish the size 2 pattern grading", "in-progress", "Agent: regrade the size 2 shoulder strap from the fit notes.");
  await card("Write the care label copy", "in-progress", "Agent: draft the label text from the fabric spec.");
  await card("Book the second fit session", "up-next", "Owner: confirm the date with the running club.");
  await card("Order sample zips", "up-next", "Agent: compare the two zip quotes.");
  await card("Photograph the prototype", "up-next");
  await card("Plan the launch email", "pending");
  await card("Price the first 300 units", "pending");
  await card("Pick the fabric colourways", "complete");
  await card("Sketch the first vest", "complete");
  for (const role of ["editor", "viewer"] as const) {
    await service.signIn(PEOPLE[role].userId, PEOPLE[role].name);
    await asPerson(owner.token, "POST", `/api/v1/boards/${boardId}/members`, { userId: PEOPLE[role].userId, role });
  }
  return boardId as string;
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}

async function send(response: ServerResponse, answer: Response) {
  const headers: Record<string, string | string[]> = {};
  answer.headers.forEach((value, name) => {
    headers[name] = name === "set-cookie" ? answer.headers.getSetCookie() : value;
  });
  response.writeHead(answer.status, headers);
  response.end(Buffer.from(await answer.arrayBuffer()));
}

const boardId = await seed();
const vite = await createVite({ configFile: new URL("../../vite.config.ts", import.meta.url).pathname, server: { middlewareMode: true, hmr: { port: port + 1 } }, appType: "spa" });

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", PUBLIC);
    if (url.pathname.startsWith("/api/v1/")) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) if (typeof value === "string") headers.set(name, value);
      const method = request.method ?? "GET";
      const body = method === "GET" || method === "HEAD" ? undefined : await readBody(request);
      await send(response, await apiResponse(service.actionCtx, forwarded(`${url.pathname}${url.search}`, { method, headers, ...(body ? { body } : {}) })));
      return;
    }
    if (url.pathname === "/dev/as") {
      // Stands in for the sign-in page (phase 4): a browser session for one of the sample people.
      const who = (url.searchParams.get("user") ?? "owner") as Who;
      const person = PEOPLE[who] ?? PEOPLE.owner;
      const { token } = await service.signIn(person.userId, person.name);
      const next = url.searchParams.get("next") ?? `/boards/${boardId}`;
      response.writeHead(302, { Location: next.startsWith("/") ? next : "/", "Set-Cookie": webCookie(token, 7 * 24 * 60 * 60) });
      response.end();
      return;
    }
    if (url.pathname === "/sign-in") {
      const next = encodeURIComponent(url.searchParams.get("next") ?? "/");
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>Preview sign-in</title><p>Preview only: sign in as <a href="/dev/as?user=owner&next=${next}">Sam (owner)</a>, <a href="/dev/as?user=editor&next=${next}">Maya (editor)</a> or <a href="/dev/as?user=viewer&next=${next}">Jo (viewer)</a>.</p>`);
      return;
    }
    vite.middlewares(request, response);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end(error instanceof Error ? error.message : String(error));
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`Planban web preview: ${PUBLIC}/dev/as?user=owner (board ${boardId})\n`);
});
