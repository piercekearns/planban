import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { serviceUrl, saveCredentials } from "./credentials";
import { authorizationMetadata, onlineRequest, tokenRequest } from "./client";
import { PlanbanValidationError } from "../boardOperations";

export interface LoginOptions {
  user?: string | undefined;
  passwordEnv?: string | undefined;
  access?: "all" | "board" | undefined;
  boards?: string | undefined;
  openBrowser?: ((url: string) => Promise<void>) | undefined;
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

function hiddenHandle(html: string) {
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map((match) => [match[1]!, match[2]!]));
    if (attrs.name === "handle" && attrs.value) {
      return attrs.value.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
        const named: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&amp;": "&", "&lt;": "<", "&gt;": ">" };
        return named[entity] ?? String.fromCodePoint(entity.startsWith("&#x") ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10));
      });
    }
  }
  throw new Error("Online Board sign-in page is missing its consent handle.");
}

export async function onlineLogin(urlInput: string, options: LoginOptions = {}) {
  const url = serviceUrl(urlInput);
  if (!!options.user !== !!options.passwordEnv) throw new PlanbanValidationError("Headless login requires both --user and --password-env.");
  const password = options.passwordEnv ? process.env[options.passwordEnv] : undefined;
  if (options.passwordEnv && !password) throw new PlanbanValidationError(`Password environment variable ${options.passwordEnv} is empty.`);
  if (options.access === "board" && !options.boards?.trim()) throw new PlanbanValidationError("Board access requires --boards.");
  if (options.access === "board" && options.boards?.includes(",")) throw new PlanbanValidationError("The prototype supports one board per connection. Sign in separately for broader access.");
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  // Attach a handler immediately so an early timeout is never unhandled.
  void codePromise.catch(() => undefined);
  const listener = createServer((req, res) => {
    const callback = new URL(req.url ?? "/", "http://127.0.0.1");
    if (callback.pathname !== "/callback" || callback.searchParams.get("state") !== state
      || (callback.searchParams.has("iss") && callback.searchParams.get("iss") !== url)) {
      res.writeHead(400).end("Invalid sign-in callback.");
      return;
    }
    const code = callback.searchParams.get("code");
    if (!code) {
      res.writeHead(400).end("Sign-in was not completed.");
      rejectCode(new Error("Online Board sign-in was not completed."));
      return;
    }
    res.end("Signed in to Planban. You can close this window.");
    resolveCode(code);
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Could not start sign-in callback listener.");
  const redirectUri = `http://127.0.0.1:${address.port}/callback`;
  const timeout = setTimeout(() => rejectCode(new Error("Online Board sign-in timed out. Run login again.")), 5 * 60_000);
  try {
    const metadata = await authorizationMetadata(url);
    const registered = await fetch(metadata.register, {
      method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error",
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ client_name: "Planban CLI", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    });
    if (!registered.ok) throw new Error("Online Board client registration failed.");
    const registration = await registered.json();
    if (typeof registration.client_id !== "string") throw new Error("Online Board registration did not return a client id.");
    const clientId = registration.client_id;
    const authorize = new URL(metadata.authorize);
    authorize.search = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: redirectUri, state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256", resource: url, scope: "planban:read planban:write offline_access",
    }).toString();
    let code: string;
    if (options.user && password) {
      const page = await fetch(authorize, { redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!page.ok) throw new Error("Online Board sign-in page could not be loaded.");
      const cookies = page.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
      if (!cookies) throw new Error("Online Board sign-in page did not set a consent cookie.");
      const response = await fetch(metadata.authorize, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
        headers: { Cookie: cookies },
        body: new URLSearchParams({ handle: hiddenHandle(await page.text()), person: options.user, password, reach: options.access ?? "all", boardId: options.boards ?? "", decision: "approve" }),
      });
      const location = response.headers.get("location");
      if (response.status !== 302 || !location) throw new Error("Online Board sign-in failed. Check the prototype user and password.");
      const callback = new URL(location);
      if (callback.origin + callback.pathname !== redirectUri || callback.searchParams.get("state") !== state || !callback.searchParams.get("code")) {
        throw new Error("Online Board sign-in returned an invalid callback.");
      }
      if (callback.searchParams.has("iss") && callback.searchParams.get("iss") !== url) throw new Error("Online Board sign-in issuer does not match the service.");
      code = callback.searchParams.get("code")!;
    } else {
      await (options.openBrowser ?? openBrowser)(authorize.href);
      code = await codePromise;
    }
    const token = await tokenRequest(url, new URLSearchParams({
      grant_type: "authorization_code", code, client_id: clientId,
      code_verifier: verifier, redirect_uri: redirectUri, resource: url,
    }));
    await saveCredentials(url, {
      clientId, accessToken: token.access_token, refreshToken: token.refresh_token,
      expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(), person: options.user,
    });
    return { url, signedIn: true, identity: await onlineRequest<unknown>(url, "/api/v1/me") };
  } finally {
    clearTimeout(timeout);
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
}
