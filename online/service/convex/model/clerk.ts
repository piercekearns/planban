// Clerk is Planban Online's sign-in server (owner decision 3). People sign in
// with Clerk; AI apps (ChatGPT, Claude) and the Planban command line get OAuth
// access tokens from it. These are JWTs signed with the instance's keys,
// which this module checks against Clerk's published key set.
//
// Configuration (deployment environment): CLERK_ISSUER, CLERK_JWKS_URL and
// PLANBAN_CLI_CLIENT_ID (the public OAuth client the command line uses).

export interface ClerkAccessToken {
  /** The Clerk user id. */
  sub: string;
  /** The OAuth client the token was issued to: a client id, or for a client ID metadata document its URL. */
  clientId: string;
  issuedAt: number;
}

const CLOCK_SKEW_SECONDS = 60;
const KEYS_TTL_MS = 10 * 60 * 1000;
let keys: { fetchedAt: number; byKid: Map<string, JsonWebKey> } | null = null;

export function clerkConfigured() {
  return !!process.env.CLERK_ISSUER && !!process.env.CLERK_JWKS_URL;
}

function base64UrlDecode(part: string): Uint8Array<ArrayBuffer> {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
}

async function signingKey(kid: string): Promise<JsonWebKey | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stale = !keys || Date.now() - keys.fetchedAt > KEYS_TTL_MS;
    // An unknown key id may mean Clerk rotated its keys: fetch once more.
    if (stale || attempt === 1) {
      const response = await fetch(process.env.CLERK_JWKS_URL!, { redirect: "error" });
      if (!response.ok) throw new Error("Clerk's signing keys could not be loaded.");
      const set = await response.json() as { keys?: Array<JsonWebKey & { kid?: string }> };
      keys = { fetchedAt: Date.now(), byKid: new Map((set.keys ?? []).filter((key) => key.kid).map((key) => [key.kid!, key])) };
    }
    const key = keys!.byKid.get(kid);
    if (key) return key;
  }
  return null;
}

/**
 * Checks a Clerk OAuth access token: RS256 signature by a current Clerk key,
 * Clerk's issuer, a current time window, and a client id (so a person's own
 * browser session token, which has none, is never accepted here). If the
 * token names audiences, this service's public address must be one of them.
 */
export async function verifyClerkAccessToken(token: string, audience: string): Promise<ClerkAccessToken | null> {
  if (!clerkConfigured()) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJson(parts[0]!);
    claims = decodeJson(parts[1]!);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const jwk = await signingKey(header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) return null;
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== process.env.CLERK_ISSUER) return null;
  if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_SECONDS) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_SECONDS) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  const clientId = typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" && !claims.sid ? claims.azp : null;
  if (!clientId) return null;
  if (claims.aud !== undefined) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience) && !audiences.includes(`${audience}/mcp`)) return null;
  }
  return { sub: claims.sub, clientId, issuedAt: typeof claims.iat === "number" ? claims.iat : now };
}

/** A readable name for an OAuth client: the host of a metadata document URL, or the client id. */
export function clientNameOf(clientId: string) {
  try {
    const url = new URL(clientId);
    if (url.protocol === "https:") return url.host;
  } catch {
    // a plain client id
  }
  return `OAuth app ${clientId}`;
}
