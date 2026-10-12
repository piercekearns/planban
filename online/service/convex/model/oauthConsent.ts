import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { MACHINE_CLIENT_ID, REQUEST_MS, scopeLevel } from "../oauth";
import { publicOrigin, randomSecret, sha256Hex } from "./auth";
import { loadOAuthClient, clientRedirectAllowed, type OAuthClient } from "./oauthClient";
import { verifyHumanSession, type HumanIdentity } from "./humanSession";
import { readOAuthForm } from "./oauthHttp";

export const CLI_REDIRECT_PORTS = [53682, 53683, 53684, 53685, 53686] as const;
export const PLANBAN_SCOPES = ["planban:read", "planban:plan", "planban:complete", "offline_access"] as const;
const escape = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const jsonLiteral = (value: unknown) => JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
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
  const client = machine ? { clientId, name: "Planban CLI", redirectUris: CLI_REDIRECT_PORTS.map((port) => `http://127.0.0.1:${port}/callback`), native: true } : await loader(clientId);
  if (!client || !redirectUri || !(machine ? client.redirectUris.includes(redirectUri) : clientRedirectAllowed(client, redirectUri))) return rejected("invalid_client");
  const state = input.get("state") ?? "";
  if (state.length > 2048) return rejected("invalid_request");
  const failed = (error: string) => new Response(null, { status: 303, headers: { Location: callback(redirectUri, state, { error }), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  if (input.get("response_type") !== "code") return failed("unsupported_response_type");
  const resource = input.get("resource") ?? "";
  if (![config.origin, `${config.origin}/mcp`].includes(resource) || (machine && resource !== config.origin)) return failed("invalid_target");
  const scopes = (input.get("scope") ?? (machine ? "planban:machine" : "planban:read")).split(" ");
  if (!scopes.length || scopes.length > 4 || new Set(scopes).size !== scopes.length || (machine ? scopes.length !== 1 || scopes[0] !== "planban:machine" : !scopes.some((scope) => scope.startsWith("planban:")) || scopes.some((scope) => !(PLANBAN_SCOPES as readonly string[]).includes(scope)))) return failed("invalid_scope");
  const challenge = input.get("code_challenge") ?? "";
  if (input.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return failed("invalid_request");
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
  if (!cookies || !/^pbe_[A-Za-z0-9_-]{43}$/.test(secret)) return rejected("access_denied", 403);
  const frozen = await ctx.runQuery(internal.oauth.inspect, { requestHash: await sha256Hex(secret), browserHash: await sha256Hex(cookies.browser) });
  if (!frozen) return rejected("access_denied", 403);
  const nonce = randomSecret("");
  const returnTo = `${config.origin}/oauth/consent?request=${secret}`;
  const permission = frozen.purpose === "machine" ? "Sign in this computer with your full access." : frozen.scopes.includes("planban:complete") ? "Read boards, change plans and mark work complete." : frozen.scopes.includes("planban:plan") ? "Read boards and change plans." : "Read boards and their history.";
  const script = `(()=>{
    const status=document.getElementById('status'),signin=document.getElementById('signin');
    const allow=document.getElementById('allow'),deny=document.getElementById('deny');
    let mounted=false,deciding=false;
    async function decide(decision){
      if(deciding)return;deciding=true;
      allow.disabled=true;deny.disabled=true;
      try{
        const headers={'Content-Type':'application/x-www-form-urlencoded'};
        if(decision==='allow'){
          const token=await Clerk.session?.getToken();
          if(!token)throw Error();
          headers.Authorization='Bearer '+token;
        }
        const response=await fetch('/oauth/approve',{method:'POST',redirect:'error',headers,
          body:new URLSearchParams({request:${jsonLiteral(secret)},csrf:${jsonLiteral(cookies.csrf)},decision})});
        const result=await response.json();
        if(!response.ok||!result.redirect)throw Error();
        window.location.assign(result.redirect);
      }catch{status.textContent='Authorization failed or expired. Start again from your app.';}
    }
    allow.addEventListener('click',()=>decide('allow'));
    deny.addEventListener('click',()=>decide('deny'));
    window.addEventListener('load',async()=>{
    try{
      await Clerk.load({nonce:${jsonLiteral(nonce)},ui:{ClerkUI:window.__internal_ClerkUICtor}});
      const render=()=>{
        const active=Clerk.session&&Clerk.session.status==='active';
        allow.disabled=!active||deciding;
        if(!deciding)status.textContent=active?'Signed in as '+(Clerk.user?.primaryEmailAddress?.emailAddress||'your account')+'. Review the access above, then choose Allow.':'Sign in to review and approve this connection.';
        if(active&&mounted){Clerk.unmountSignIn(signin);mounted=false;}
        else if(!active&&!mounted){
          Clerk.mountSignIn(signin,{routing:'hash',forceRedirectUrl:${jsonLiteral(returnTo)},signUpForceRedirectUrl:${jsonLiteral(returnTo)}});
          mounted=true;
        }
      };
      Clerk.addListener(render);render();
    }catch{status.textContent='Sign-in could not load. Cancel or start again from your app.';}
    });
  })();`;

  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Connect to Planban</title><style nonce="${nonce}">body{font:16px/1.6 system-ui;max-width:620px;margin:48px auto;padding:0 20px}button{padding:10px 18px;margin:12px 12px 0 0}code{overflow-wrap:anywhere}#status{color:#555}</style><h1>${escape(frozen.purpose === "machine" ? "Sign in to Planban" : `Connect ${frozen.clientName} to Planban`)}</h1><p>${escape(permission)}</p><p>This applies to boards you can access. Your current board permissions and agent limits still apply.</p>${frozen.scopes.includes("offline_access") ? "<p>This app can stay connected until you revoke it, or it is unused for 90 days. Authorization ends after one year.</p>" : ""}<p>App: <code>${escape(frozen.clientId)}</code></p><div id="signin"></div><p id="status">Loading sign-in…</p><button id="allow" disabled>Allow</button><button id="deny">Cancel</button><script nonce="${nonce}" defer crossorigin="anonymous" src="${escape(config.frontend)}/npm/@clerk/ui@1.40.0/dist/ui.browser.js"></script><script nonce="${nonce}" defer crossorigin="anonymous" data-clerk-publishable-key="${escape(config.key)}" src="${escape(config.frontend)}/npm/@clerk/clerk-js@6.39.0/dist/clerk.browser.js"></script><script nonce="${nonce}">${script}</script></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' ${config.frontend} https://challenges.cloudflare.com https://*.protect.clerk.com; style-src 'unsafe-inline'; connect-src 'self' ${config.frontend} https://*.protect.clerk.com:*; img-src ${config.frontend} https://img.clerk.com data:; frame-src ${config.frontend} https://challenges.cloudflare.com https://*.protect.clerk.com; worker-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` } });
}
