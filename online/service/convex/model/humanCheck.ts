// A person-check before a sign-in starts (Cloudflare Turnstile, free). The
// sign-in start is the one browser-facing step that creates rows and spends
// each app's shared sign-in budget, so it runs only after a single-use
// Turnstile proof. Apps' own servers never call it: they use /oauth/token,
// /oauth/register and /mcp, which are unchanged. Off until both settings exist.
import type { ActionCtx } from "../_generated/server";
import { publicOrigin, randomSecret } from "./auth";
import { authorizationResponse } from "./oauthConsent";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ACTION = "authorize";
const MAX_FORM_BYTES = 4096;

export function turnstileConfig(): { siteKey: string; secret: string } | null {
  const siteKey = process.env.PLANBAN_TURNSTILE_SITE_KEY ?? "", secret = process.env.PLANBAN_TURNSTILE_SECRET ?? "";
  return /^[A-Za-z0-9_-]{8,128}$/.test(siteKey) && /^[A-Za-z0-9_.-]{8,256}$/.test(secret) ? { siteKey, secret } : null;
}

const headers = (nonce: string) => ({
  "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
});

function page(nonce: string, body: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Planban</title><style>body{margin:0;background:#f9f9f9;color:#0d0d0d;font:14px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif}main{max-width:420px;margin:72px auto;padding:0 20px}h1{font-size:20px;margin:0 0 6px}p{color:#5d5d5d;margin:0 0 18px}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: headers(nonce) });
}

/** The page shown at the sign-in start: Turnstile, then the same address again with its proof. */
export function humanCheckPage(siteKey: string): Response {
  const nonce = randomSecret("n_").slice(2);
  return page(nonce, `<h1>Checking you're a person</h1><p>This takes a moment. Then Planban asks you to sign in.</p>
<form id="check" method="post" action=""><div class="cf-turnstile" data-sitekey="${siteKey}" data-action="${ACTION}" data-callback="planbanChecked"></div></form>
<noscript><p>Turn on JavaScript to continue.</p></noscript>
<script nonce="${nonce}">window.planbanChecked=function(){document.getElementById('check').submit();};</script>
<script nonce="${nonce}" src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`);
}

function failed(message: string, status: number) {
  const nonce = randomSecret("n_").slice(2);
  return page(nonce, `<h1>Sign-in couldn't start</h1><p>${message}</p>`, status);
}

/** Asks Cloudflare whether this single-use proof came from this page on this address. */
export async function verifyTurnstile(secret: string, token: string, remoteIp: string | null, fetcher: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const body = new URLSearchParams({ secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) });
    const response = await fetcher(SITEVERIFY, { method: "POST", body, redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const result = await response.json() as { success?: unknown; hostname?: unknown; action?: unknown };
    return result.success === true && result.hostname === new URL(publicOrigin()).hostname && result.action === ACTION;
  } catch { return null; }
}

/** The body as text, or null once it passes `limit` bytes; stops reading there. */
async function boundedText(request: Request, limit: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } catch { return null; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

/**
 * The sign-in start. Without Turnstile settings it is unchanged. With them, a
 * visit shows the person-check page, and only its proof, posted back to the
 * same address from this origin, reaches the existing sign-in start.
 */
export async function authorizeEntry(ctx: ActionCtx, request: Request, verify: typeof verifyTurnstile = verifyTurnstile): Promise<Response> {
  const config = turnstileConfig();
  if (!config) return authorizationResponse(ctx, request);
  if (request.method === "GET") return humanCheckPage(config.siteKey);
  if (request.method !== "POST" || request.headers.get("Origin") !== publicOrigin()) return failed("Go back to your app and connect to Planban again.", 403);
  const length = Number(request.headers.get("Content-Length") ?? "0");
  if (!/^application\/x-www-form-urlencoded(\s*;|$)/i.test(request.headers.get("Content-Type") ?? "") || length > MAX_FORM_BYTES) return failed("Go back to your app and connect to Planban again.", 400);
  const text = await boundedText(request, MAX_FORM_BYTES);
  if (text === null) return failed("Go back to your app and connect to Planban again.", 400);
  const token = new URLSearchParams(text).get("cf-turnstile-response") ?? "";
  if (!token || token.length > 2048) return failed("The check didn't finish. Go back to your app and connect to Planban again.", 403);
  const human = await verify(config.secret, token, request.headers.get("CF-Connecting-IP"));
  if (human === null) return failed("Planban couldn't finish the check just now. Try again in a minute.", 503);
  if (!human) return failed("The check didn't pass. Go back to your app and connect to Planban again.", 403);
  // The proof is spent; the sign-in starts exactly as an unchecked visit used to.
  const headers = new Headers(request.headers);
  for (const name of ["Content-Type", "Content-Length", "Origin"]) headers.delete(name);
  return authorizationResponse(ctx, new Request(request.url, { method: "GET", headers }));
}
