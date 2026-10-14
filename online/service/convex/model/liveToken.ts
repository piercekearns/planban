// Short-lived (5 minute) ES256 tokens that let a Planban install subscribe to
// an Online Board's revision through the Convex client. The private key lives
// only in the deployment's environment (PLANBAN_LIVE_SIGNING_KEY, a JWK).
export const LIVE_AUDIENCE = "planban-live";
const LIFETIME_SECONDS = 300;

function base64url(bytes: Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signingJwk(): JsonWebKey & { kid?: string } {
  const raw = process.env.PLANBAN_LIVE_SIGNING_KEY;
  if (!raw) throw new Error("PLANBAN_LIVE_SIGNING_KEY is not configured.");
  return JSON.parse(raw);
}

export function liveTokensConfigured(): boolean {
  return !!process.env.PLANBAN_LIVE_SIGNING_KEY && !!process.env.CONVEX_SITE_URL;
}

export function publicJwks() {
  const { d: _private, ...jwk } = signingJwk();
  return { keys: [{ ...jwk, use: "sig", alg: "ES256" }] };
}

export async function signLiveToken(connectionId: string) {
  const jwk = signingJwk();
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid: jwk.kid ?? "planban-live" }));
  const payload = base64url(JSON.stringify({
    iss: process.env.CONVEX_SITE_URL, aud: LIVE_AUDIENCE, sub: connectionId, iat: now, exp: now + LIFETIME_SECONDS,
  }));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${payload}`)));
  return { token: `${header}.${payload}.${base64url(signature)}`, expiresAt: new Date((now + LIFETIME_SECONDS) * 1000).toISOString() };
}
