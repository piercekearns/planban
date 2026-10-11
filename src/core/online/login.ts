import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultPlanbanRoot } from "../paths";
import { spawn } from "node:child_process";
import { serviceUrl, saveCredentials } from "./credentials";
import { onlineRequest } from "./client";
import { PlanbanValidationError } from "../boardOperations";

export interface LoginOptions {
  /** Development sign-in only: a connection limited to one board. */
  access?: "all" | "board" | undefined;
  boards?: string | undefined;
  openBrowser?: ((url: string) => Promise<void>) | undefined;
  /** Development sign-in, offered only by a local Online Board backend. */
  devUser?: string | undefined;
  /** Sign in with a personal access key held in this environment variable. */
  keyEnv?: string | undefined;
}

async function keyLogin(url: string, variable: string) {
  const key = process.env[variable];
  if (!key) throw new PlanbanValidationError(`Environment variable ${variable} is empty.`);
  if (!/^pbk_[A-Za-z0-9_-]{20,}$/.test(key)) throw new PlanbanValidationError(`Environment variable ${variable} does not hold a Planban personal access key.`);
  // Keys do not refresh; they last until revoked or until their expiry.
  await saveCredentials(url, { clientId: "key", accessToken: key, refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z" });
  return { url, signedIn: true, identity: await onlineRequest<unknown>(url, "/api/v1/me") };
}

/**
 * A machine that has just signed in checks every local board it holds, so a
 * copy of a board that went online while this machine was signed out is
 * caught now rather than at its next edit.
 */
async function staleCopiesAfterSignIn() {
  const { listBoards } = await import("../registry");
  const { readManifest, resolvePlanningRoot } = await import("../storage");
  const boards = new Map<string, { planningRoot: string; repoId: string }>();
  for (const board of await listBoards()) {
    const manifest = await readManifest(board.cwd).catch(() => null);
    if (manifest?.enabled && manifest.storage?.kind !== "online") boards.set(resolvePlanningRoot(manifest), { planningRoot: resolvePlanningRoot(manifest), repoId: manifest.repoId });
  }
  // Board folders copied onto this machine may not be in its board list yet.
  const repos = join(defaultPlanbanRoot(), "repos");
  for (const name of await readdir(repos).catch(() => [] as string[])) {
    const planningRoot = join(repos, name);
    if (boards.has(planningRoot) || await stat(join(planningRoot, "ONLINE-BOARD.txt")).then(() => true, () => false)) continue;
    const roadmap = await readFile(join(planningRoot, "roadmap.json"), "utf8").then((text) => JSON.parse(text), () => null);
    if (roadmap?.project?.id) boards.set(planningRoot, { planningRoot, repoId: roadmap.project.id });
  }
  const { scanLocalCopies } = await import("./copyCheck");
  const found = await scanLocalCopies([...boards.values()]);
  return found.length ? { staleLocalCopies: found.map(({ repoId, stale }) => ({ repoId, onlineBoard: stale.boardId, url: stale.url, unsyncedChanges: stale.unsyncedChanges.length })) } : {};
}

async function devLogin(url: string, options: LoginOptions) {
  const response = await fetch(`${url}/dev/token`, {
    method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      userId: options.devUser, clientName: "Planban CLI",
      ...(options.access === "board" ? { boards: [options.boards] } : {}),
    }),
  });
  if (response.status !== 201) throw new PlanbanValidationError("This Online Board service does not offer development sign-in.");
  const { token } = await response.json() as { token: string };
  // Development tokens do not expire or refresh; signing out revokes them.
  await saveCredentials(url, { clientId: "dev", accessToken: token, refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z", person: options.devUser });
  return { url, signedIn: true, identity: await onlineRequest<unknown>(url, "/api/v1/me"), ...await staleCopiesAfterSignIn() };
}

async function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Could not open sign-in page: ${url}`)));
  });
}

interface SignInConfig {
  issuer: string;
  cliClientId: string;
  redirectPorts: number[];
  scope: string;
}

function httpsOrLoopback(value: string, what: string) {
  const parsed = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new Error(`${what} must use HTTPS.`);
  return parsed;
}

/** Where to sign in: the service names its sign-in server, whose metadata gives the endpoints. */
async function signInEndpoints(url: string) {
  const discovery = await fetch(`${url}/.well-known/planban.json`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!discovery.ok) throw new Error("This Online Board service did not say how to sign in.");
  const config = (await discovery.json() as { signIn?: SignInConfig }).signIn;
  if (!config?.issuer || !config.cliClientId || !config.redirectPorts?.length) {
    throw new PlanbanValidationError("This Online Board service has no browser sign-in yet. On a local development backend use --dev-user.");
  }
  const issuer = httpsOrLoopback(config.issuer, "The sign-in server").origin;
  const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error("The sign-in server's details could not be loaded.");
  const metadata = await response.json() as Record<string, unknown>;
  if (String(metadata.issuer ?? "").replace(/\/+$/, "") !== issuer) throw new Error("The sign-in server's details name a different server.");
  const endpoint = (name: string, required = true) => {
    const value = metadata[name];
    if (typeof value !== "string" || new URL(value).origin !== issuer) {
      if (!required) return null;
      throw new Error(`The sign-in server's ${name} must belong to it.`);
    }
    return value;
  };
  if (!(metadata.code_challenge_methods_supported as string[] | undefined)?.includes("S256")) throw new Error("The sign-in server does not support PKCE.");
  return {
    issuer, clientId: config.cliClientId, ports: config.redirectPorts, scope: config.scope,
    authorize: endpoint("authorization_endpoint")!, token: endpoint("token_endpoint")!, revoke: endpoint("revocation_endpoint", false),
  };
}

/** Listens for the sign-in callback on the first free registered loopback port. */
async function callbackListener(ports: number[], state: string, issuer: string) {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Attach a handler immediately so an early timeout is never unhandled.
  void code.catch(() => undefined);
  const listener = createServer((req, res) => {
    const callback = new URL(req.url ?? "/", "http://127.0.0.1");
    if (callback.pathname !== "/callback" || callback.searchParams.get("state") !== state
      || (callback.searchParams.has("iss") && callback.searchParams.get("iss")?.replace(/\/+$/, "") !== issuer)) {
      res.writeHead(400).end("Invalid sign-in callback.");
      return;
    }
    const received = callback.searchParams.get("code");
    if (!received) {
      res.writeHead(400).end("Sign-in was not completed.");
      rejectCode(new Error(`Planban sign-in was not completed${callback.searchParams.get("error") ? ` (${callback.searchParams.get("error")})` : ""}.`));
      return;
    }
    res.end("Signed in to Planban. You can close this window.");
    resolveCode(received);
  });
  for (const port of ports) {
    const listening = await new Promise<boolean>((resolve) => {
      listener.once("error", () => resolve(false));
      listener.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (listening) {
      return {
        redirectUri: `http://127.0.0.1:${port}/callback`, code, fail: rejectCode,
        async close() {
          listener.closeAllConnections();
          await new Promise<void>((resolve) => listener.close(() => resolve()));
        },
      };
    }
  }
  throw new Error(`Planban sign-in needs one of these local ports free: ${ports.join(", ")}.`);
}

/**
 * Browser sign-in (owner decision 6): the person signs in with Clerk (email
 * code or GitHub) as the Planban command line, a public OAuth client using
 * PKCE. The token is then exchanged for this machine's own Planban sign-in,
 * which lasts until sign-out or 90 days unused, with the person's full
 * access. Nothing keeps Clerk's tokens: a refresh token, if issued, is
 * revoked; its access tokens cannot be.
 */
export async function onlineLogin(urlInput: string, options: LoginOptions = {}) {
  const url = serviceUrl(urlInput);
  if (options.access === "board" && !options.boards?.trim()) throw new PlanbanValidationError("Board access requires --boards.");
  if (!options.devUser && (options.access === "board" || options.boards)) {
    throw new PlanbanValidationError("--access board and --boards apply only to development sign-in (--dev-user). Signing in through the browser gives this machine your full access; limit AI apps and keys from your connections instead.");
  }
  if (options.devUser) return devLogin(url, options);
  if (options.keyEnv) return keyLogin(url, options.keyEnv);
  const server = await signInEndpoints(url);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const callback = await callbackListener(server.ports, state, server.issuer);
  const timeout = setTimeout(() => callback.fail(new Error("Planban sign-in timed out. Run login again.")), 5 * 60_000);
  try {
    const authorize = new URL(server.authorize);
    authorize.search = new URLSearchParams({
      response_type: "code", client_id: server.clientId, redirect_uri: callback.redirectUri, state, scope: server.scope,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: url,
    }).toString();
    await (options.openBrowser ?? openBrowser)(authorize.href);
    const code = await callback.code;
    const exchanged = await fetch(server.token, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: server.clientId, code_verifier: verifier, redirect_uri: callback.redirectUri }),
    });
    const tokens = await exchanged.json().catch(() => ({})) as { access_token?: string; refresh_token?: string };
    if (!exchanged.ok || !tokens.access_token) throw new Error("The sign-in server did not complete the sign-in. Run login again.");
    const machine = await fetch(`${url}/api/v1/auth/machine`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Planban CLI on ${hostname()}` }),
    });
    const signedIn = await machine.json().catch(() => ({})) as { token?: string; userId?: string; error?: { message?: string } };
    if (!machine.ok || !signedIn.token) throw new Error(signedIn.error?.message ?? "This Online Board service did not accept the sign-in.");
    // Nothing keeps the sign-in server's tokens. A refresh token, if one was
    // issued, is revoked (best effort). Clerk's access tokens cannot be
    // revoked; the service accepts this one for one exchange only.
    if (server.revoke && tokens.refresh_token) {
      await fetch(server.revoke, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000), body: new URLSearchParams({ token: tokens.refresh_token, client_id: server.clientId }) }).catch(() => undefined);
    }
    await saveCredentials(url, { clientId: "machine", accessToken: signedIn.token, refreshToken: "", expiresAt: "9999-12-31T00:00:00.000Z", ...(signedIn.userId ? { person: signedIn.userId } : {}) });
    return { url, signedIn: true, identity: await onlineRequest<unknown>(url, "/api/v1/me"), ...await staleCopiesAfterSignIn() };
  } finally {
    clearTimeout(timeout);
    await callback.close();
  }
}
