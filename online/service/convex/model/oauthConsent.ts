import { consentPage } from "./oauthConsentPage";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { MACHINE_CLIENT_ID, REQUEST_MS, scopeLevel } from "../oauth";
import { publicOrigin, randomSecret, sha256Hex } from "./auth";
import { loadOAuthClient, clientRedirectAllowed, metadataClientAllowed, parseClaudeRegistration, REGISTERED_CLIENT_NAME, registeredClientId, type OAuthClient } from "./oauthClient";
import { verifyHumanSession, type HumanIdentity } from "./humanSession";
import { readOAuthForm } from "./oauthHttp";

export const CLI_REDIRECT_PORTS = [53682, 53683, 53684, 53685, 53686] as const;
export const PLANBAN_SCOPES = ["planban:read", "planban:plan", "planban:complete", "offline_access"] as const;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
const rejected = (code: string, status = 400) => json({ error: code }, status);

function configuration() {
  try {
    const origin = publicOrigin(), service = new URL(origin), issuer = new URL(process.env.CLERK_ISSUER ?? "");
    const key = process.env.CLERK_PUBLISHABLE_KEY ?? "";
    if (!process.env.CLERK_SECRET_KEY || !/^pk_(test|live)_[A-Za-z0-9_-]+=*$/.test(key)) return null;
    const domain = atob(key.split("_").slice(2).join("_").replace(/-/g, "+").replace(/_/g, "/")).replace(/\$$/, "");
    if (issuer.protocol !== "https:" || issuer.origin !== `https://${domain}` || issuer.username || issuer.password || issuer.search || issuer.hash || !["", "/"].includes(issuer.pathname)) return null;
    const local = service.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(service.hostname);
    if ((!local && service.protocol !== "https:") || service.origin !== origin || service.username || service.password) return null;
    return { origin, frontend: issuer.origin, key, secure: service.protocol === "https:" };
  } catch { return null; }
}

export function enrollmentConfigured(): boolean { return configuration() !== null; }

function cookieNames(secure: boolean) {
  const prefix = secure ? "__Host-" : "";
  return { browser: `${prefix}planban_browser`, csrf: `${prefix}planban_csrf` };
}

function browserCookies(request: Request, secure: boolean) {
  const names = cookieNames(secure), values = new Map<string, string>();
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const equals = part.indexOf("="), name = part.slice(0, equals).trim();
    if (equals < 0 || !Object.values(names).includes(name)) continue;
    if (values.has(name)) return null;
    values.set(name, part.slice(equals + 1).trim());
  }
  const browser = values.get(names.browser), csrf = values.get(names.csrf);
  return browser && /^pbb_[A-Za-z0-9_-]{43}$/.test(browser) && csrf && /^pbs_[A-Za-z0-9_-]{43}$/.test(csrf) ? { browser, csrf } : null;
}

async function query(request: Request) {
  if (request.method !== "GET" || request.url.length > 8192) return null;
  return readOAuthForm(new Request(request.url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URL(request.url).search.slice(1) }));
}

function callback(redirectUri: string, state: string, result: Record<string, string>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries({ ...result, ...(state ? { state } : {}), iss: publicOrigin() })) url.searchParams.set(key, value);
  return url.href;
}

/** Validate and freeze the entire request before any human identity is used. */
export async function authorizationResponse(ctx: ActionCtx, request: Request, loader: (id: string) => Promise<OAuthClient | null> = loadOAuthClient): Promise<Response> {
  const config = configuration();
  if (!config) return rejected("temporarily_unavailable", 503);
  const input = await query(request);
  if (!input) return rejected("invalid_request");
  const clientId = input.get("client_id") ?? "", redirectUri = input.get("redirect_uri") ?? "";
  const machine = clientId === MACHINE_CLIENT_ID;
  // Machine requests must start their service lease before browser opening.
  if (machine) return rejected("invalid_request");
  if (!clientId || clientId.length > 2048 || !redirectUri || redirectUri.length > 2048) return rejected("invalid_client");
  const state = input.get("state") ?? "";
  if (state.length > 2048) return rejected("invalid_request");
  // Reject independent malformed fields before any publisher fetch. Until
  // metadata validates the callback, errors must not redirect to that URI.
  if (input.get("response_type") !== "code") return rejected("unsupported_response_type");
  const resource = input.get("resource") ?? "";
  if (![config.origin, `${config.origin}/mcp`].includes(resource) || (machine && resource !== config.origin)) return rejected("invalid_target");
  const scopes = (input.get("scope") ?? (machine ? "planban:machine" : "planban:read")).split(" ");
  if (!scopes.length || scopes.length > 4 || new Set(scopes).size !== scopes.length || (machine ? scopes.length !== 1 || scopes[0] !== "planban:machine" : !scopes.some((scope) => scope.startsWith("planban:")) || scopes.some((scope) => !(PLANBAN_SCOPES as readonly string[]).includes(scope)))) return rejected("invalid_scope");
  const challenge = input.get("code_challenge") ?? "";
  if (input.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return rejected("invalid_request");
  const registered = registeredClientId(clientId);
  if (!machine && !registered) {
    if (!metadataClientAllowed(clientId)) return rejected("invalid_client");
    try {
      if (!await ctx.runMutation(internal.oauth.reserveMetadataFetch, { clientId })) return rejected("temporarily_unavailable", 429);
    } catch { return rejected("temporarily_unavailable", 503); }
  }
  let client: OAuthClient | null;
  if (machine) client = { clientId, name: "Planban CLI", redirectUris: CLI_REDIRECT_PORTS.map((port) => `http://127.0.0.1:${port}/callback`), native: true };
  else if (registered) {
    try { client = await ctx.runQuery(internal.oauth.registeredClient, { clientId }); } catch { return rejected("temporarily_unavailable", 503); }
  } else client = await loader(clientId);
  if (!client || !(machine ? client.redirectUris.includes(redirectUri) : clientRedirectAllowed(client, redirectUri))) return rejected("invalid_client");
  const cookies = browserCookies(request, config.secure) ?? { browser: randomSecret("pbb_"), csrf: randomSecret("pbs_") };
  const requestSecret = randomSecret("pbe_");
  try {
    await ctx.runMutation(internal.oauth.createRequest, { requestHash: await sha256Hex(requestSecret), browserHash: await sha256Hex(cookies.browser), csrfHash: await sha256Hex(cookies.csrf), clientId, clientName: client.name, redirectUri, resource, scopes, level: machine ? "complete" : scopeLevel(scopes), challenge, state, purpose: machine ? "machine" : "oauth" });
    const headers = new Headers({ Location: `${config.origin}/oauth/consent?request=${requestSecret}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    const names = cookieNames(config.secure);
    for (const name of ["browser", "csrf"] as const) headers.append("Set-Cookie", `${names[name]}=${cookies[name]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${REQUEST_MS / 1000}${config.secure ? "; Secure" : ""}`);
    return new Response(null, { status: 303, headers });
  } catch { return rejected("temporarily_unavailable", 503); }
}

const REGISTRATION_BYTES = 4096;

/** RFC 7591 registration, for claude.ai's connector only (owner decision 22). */
export async function registrationResponse(ctx: ActionCtx, request: Request): Promise<Response> {
  if (!configuration()) return rejected("temporarily_unavailable", 503);
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) return rejected("invalid_client_metadata");
  const length = request.headers.get("Content-Length");
  if (length !== null && !(/^\d+$/.test(length) && Number(length) <= REGISTRATION_BYTES)) return rejected("invalid_client_metadata");
  let input: unknown;
  try {
    const text = await request.text();
    if (text.length > REGISTRATION_BYTES) return rejected("invalid_client_metadata");
    input = JSON.parse(text);
  } catch { return rejected("invalid_client_metadata"); }
  const parsed = parseClaudeRegistration(input);
  if ("error" in parsed) return rejected(parsed.error);
  const clientId = randomSecret("pbc_");
  try {
    const { createdAt } = await ctx.runMutation(internal.oauth.register, { clientId, redirectUris: parsed.redirectUris });
    return json({
      client_id: clientId, client_id_issued_at: Math.floor(createdAt / 1000), client_name: REGISTERED_CLIENT_NAME,
      redirect_uris: parsed.redirectUris, grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201);
  } catch { return rejected("temporarily_unavailable", 429); }
}

export async function machineStartResponse(ctx: ActionCtx, request: Request): Promise<Response> {
  const config = configuration(), input = await readOAuthForm(request);
  if (!config) return rejected("temporarily_unavailable", 503);
  if (!input || input.get("client_id") !== MACHINE_CLIENT_ID || input.get("resource") !== config.origin || input.get("scope") !== "planban:machine" || input.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(input.get("code_challenge") ?? "") || !input.get("state") || input.get("state")!.length > 2048 || !CLI_REDIRECT_PORTS.some((port) => input.get("redirect_uri") === `http://127.0.0.1:${port}/callback`)) return rejected("invalid_request");
  const launch = randomSecret("pbl_");
  try {
    const lease = await ctx.runMutation(internal.oauth.startMachine, { launchHash: await sha256Hex(launch), requestHash: await sha256Hex(randomSecret("pbe_")), challenge: input.get("code_challenge")!, state: input.get("state")!, redirectUri: input.get("redirect_uri")!, resource: config.origin });
    return json({ ...lease, launch, launchUrl: `${config.origin}/oauth/machine/launch?launch=${launch}` });
  } catch { return rejected("temporarily_unavailable", 503); }
}

export async function machineLaunchResponse(ctx: ActionCtx, request: Request): Promise<Response> {
  const config = configuration(), input = await query(request);
  if (!config) return rejected("temporarily_unavailable", 503);
  const launch = input?.get("launch") ?? "";
  if (!/^pbl_[A-Za-z0-9_-]{43}$/.test(launch) || [...input!.keys()].some((k) => k !== "launch")) return rejected("invalid_request");
  const cookies = browserCookies(request, config.secure) ?? { browser: randomSecret("pbb_"), csrf: randomSecret("pbs_") };
  const secret = randomSecret("pbe_");
  const claimed = await ctx.runMutation(internal.oauth.claimMachine, { launchHash: await sha256Hex(launch), requestHash: await sha256Hex(secret), browserHash: await sha256Hex(cookies.browser), csrfHash: await sha256Hex(cookies.csrf) });
  if (!claimed) return endedResponse(config);
  const headers = new Headers({ Location: `${config.origin}/oauth/consent?request=${secret}`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const names = cookieNames(config.secure);
  for (const name of ["browser", "csrf"] as const) headers.append("Set-Cookie", `${names[name]}=${cookies[name]}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${REQUEST_MS / 1000}${config.secure ? "; Secure" : ""}`);
  return new Response(null, { status: 303, headers });
}

export async function machineCancelResponse(ctx: ActionCtx, request: Request): Promise<Response> {
  const input = await readOAuthForm(request), verifier = input?.get("code_verifier") ?? "";
  if (!configuration()) return rejected("temporarily_unavailable", 503);
  if (!input || !/^pbl_[A-Za-z0-9_-]{43}$/.test(input.get("launch") ?? "") || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return rejected("invalid_request");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await ctx.runMutation(internal.oauth.cancelMachine, { launchHash: await sha256Hex(input.get("launch")!), challenge });
  return json({ ended: true });
}

/** Indexed browser-bound read only: neither a human session nor approval authority. */
export async function consentValidityResponse(ctx: ActionCtx, request: Request): Promise<Response> {
  const config = configuration(), input = await readOAuthForm(request);
  if (!config) return rejected("temporarily_unavailable", 503);
  const cookies = browserCookies(request, config.secure), secret = input?.get("request") ?? "";
  if (request.headers.get("Origin") !== config.origin || !cookies || input?.get("csrf") !== cookies.csrf || !/^pbe_[A-Za-z0-9_-]{43}$/.test(secret)) return json({ valid: false });
  const row = await ctx.runQuery(internal.oauth.inspect, { requestHash: await sha256Hex(secret), browserHash: await sha256Hex(cookies.browser) });
  return json(row ? { valid: true, expiresAt: row.expiresAt, serverNow: row.serverNow } : { valid: false });
}

function endedResponse(config: NonNullable<ReturnType<typeof configuration>>): Response {
  const nonce = randomSecret("");
  const html = consentPage({ nonce, frontend: config.frontend, key: config.key, returnTo: "", secret: "", csrf: "", clientId: "", clientName: "", permission: "", machine: false, offline: false, ended: true });
  return pageResponse(html, nonce, config.frontend);
}

function pageResponse(html: string, nonce: string, frontend: string): Response {
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' ${frontend} https://challenges.cloudflare.com https://*.protect.clerk.com; style-src 'unsafe-inline'; connect-src 'self' ${frontend} https://*.protect.clerk.com:*; img-src ${frontend} https://img.clerk.com data:; frame-src ${frontend} https://challenges.cloudflare.com https://*.protect.clerk.com; worker-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` } });
}

/** Approval can use only the browser-bound, frozen request and verified user. */
export async function approvalResponse(ctx: ActionCtx, request: Request, verify: (request: Request) => Promise<HumanIdentity | null> = verifyHumanSession): Promise<Response> {
  const config = configuration();
  if (!config) return rejected("temporarily_unavailable", 503);
  if (request.headers.get("Origin") !== config.origin) return rejected("access_denied", 403);
  const cookies = browserCookies(request, config.secure), input = await readOAuthForm(request, true);
  if (!cookies || !input || input.get("csrf") !== cookies.csrf || !/^pbe_[A-Za-z0-9_-]{43}$/.test(input.get("request") ?? "") || !["allow", "deny"].includes(input.get("decision") ?? "")) return rejected("access_denied", 403);
  const binding = { requestHash: await sha256Hex(input.get("request")!), browserHash: await sha256Hex(cookies.browser), csrfHash: await sha256Hex(cookies.csrf) };
  try {
    if (input.get("decision") === "deny") {
      const result = await ctx.runMutation(internal.oauth.denyRequest, binding);
      return json({ redirect: callback(result.redirectUri, result.state, { error: "access_denied" }) });
    }
    const identity = await verify(request);
    if (!identity) return rejected("access_denied", 403);
    await ctx.runMutation(internal.oauth.bindIdentity, { ...binding, ...identity });
    const code = randomSecret("pbc_");
    const result = await ctx.runMutation(internal.oauth.approve, { ...binding, ...identity, codeHash: await sha256Hex(code), deny: false });
    if (!("redirectUri" in result) || !result.redirectUri) return rejected("access_denied", 403);
    return json({ redirect: callback(result.redirectUri, result.state, { code }) });
  } catch { return rejected("access_denied", 403); }
}

/** The page displays frozen permissions. No client metadata is executable. */
export async function consentResponse(ctx: ActionCtx, request: Request): Promise<Response> {
  const config = configuration(), input = await query(request);
  if (!config) return rejected("temporarily_unavailable", 503);
  const cookies = browserCookies(request, config.secure), secret = input?.get("request") ?? "";
  if (!cookies || !/^pbe_[A-Za-z0-9_-]{43}$/.test(secret)) return endedResponse(config);
  const frozen = await ctx.runQuery(internal.oauth.inspect, { requestHash: await sha256Hex(secret), browserHash: await sha256Hex(cookies.browser) });
  if (!frozen) return endedResponse(config);
  const nonce = randomSecret("");
  const returnTo = `${config.origin}/oauth/consent?request=${secret}`;
  const permission = frozen.purpose === "machine" ? "Sign in this computer with your full access." : frozen.scopes.includes("planban:complete") ? "Read boards, change plans and mark work complete." : frozen.scopes.includes("planban:plan") ? "Read boards and change plans." : "Read boards and their history.";
  const html = consentPage({ nonce, frontend: config.frontend, key: config.key, returnTo, secret, csrf: cookies.csrf,
    clientId: frozen.clientId, clientName: frozen.clientName, permission,
    machine: frozen.purpose === "machine", offline: frozen.scopes.includes("offline_access"), expiresAt: frozen.expiresAt, serverNow: frozen.serverNow });
  return pageResponse(html, nonce, config.frontend);
}
