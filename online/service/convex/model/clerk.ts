// Clerk is Planban Online's sign-in server (owner decision 3). People sign in
// with Clerk; AI apps (ChatGPT, Claude) and the Planban command line get OAuth
// access tokens from it. These are JWTs signed with the instance's keys,
// which this module checks against Clerk's published key set.
//
// Configuration (deployment environment): CLERK_ISSUER, CLERK_JWKS_URL and
// PLANBAN_CLI_CLIENT_ID (the public OAuth client the command line uses).
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";

export interface ClerkAccessToken {
  /** The Clerk user id. */
  sub: string;
  /** The OAuth client the token was issued to: a client id, or for a client ID metadata document its URL. */
  clientId: string;
  /** When it was issued (seconds); never later than now plus the allowed clock skew. */
  issuedAt: number;
  /**
   * The signed part of the token (header and claims). Its signature can be
   * written several ways, so this, not the token text, identifies the token.
   */
  signed: string;
}

export const CLOCK_SKEW_SECONDS = 60;
const KEYS_TTL_MS = 10 * 60 * 1000;
/** The key set is refetched at most this often across the service, so made-up key ids cannot flood Clerk. */
const KEYS_REFRESH_COOLDOWN_MS = 30 * 1000;
const KEYS_FETCH_TIMEOUT_MS = 5000;
/** A known key is still trusted this long after the last successful fetch while Clerk cannot be reached. */
const KEYS_MAX_STALE_MS = 60 * 60 * 1000;
type KeyWithId = JsonWebKey & { kid?: string };

export function clerkConfigured() {
  return !!process.env.CLERK_ISSUER && !!process.env.CLERK_JWKS_URL;
}

/** Strict base64url (no padding, no stray characters), so one token has exactly one spelling. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function base64UrlDecode(part: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(part) || part.length % 4 === 1) throw new Error("Not base64url.");
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function decodeJson(part: string): Record<string, unknown> | null {
  const value: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Loads Clerk's key set. A failure here is the service's, not the token's, so it throws. */
async function fetchKeys(ctx: ActionCtx): Promise<KeyWithId[]> {
  const response = await fetch(process.env.CLERK_JWKS_URL!, { redirect: "error", signal: AbortSignal.timeout(KEYS_FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error("Clerk's signing keys could not be loaded.");
  const set = await response.json() as { keys?: KeyWithId[] };
  const keys = (set.keys ?? []).filter((key) => typeof key.kid === "string");
  await ctx.runMutation(internal.signingKeys.store, { keys: JSON.stringify(keys) });
  return keys;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function signingKey(ctx: ActionCtx, kid: string): Promise<JsonWebKey | null> {
  const cached = await ctx.runQuery(internal.signingKeys.cached, {});
  const loaded = !!cached && cached.fetchedAt > 0;
  const age = loaded ? Date.now() - cached!.fetchedAt : Infinity;
  const known = loaded ? (JSON.parse(cached!.keys) as KeyWithId[]).find((key) => key.kid === kid) : undefined;
  if (known && age < KEYS_TTL_MS) return known;
  // Stale keys, or an unknown key id (Clerk may have rotated its keys): one
  // request service-wide may refetch per cooldown.
  if (await ctx.runMutation(internal.signingKeys.claimRefresh, { cooldownMs: KEYS_REFRESH_COOLDOWN_MS })) {
    return (await fetchKeys(ctx)).find((key) => key.kid === kid) ?? null;
  }
  // Someone else is refreshing, or just did. A known key stays usable a while
  // longer, but not indefinitely: Clerk may have withdrawn it.
  if (known && age < KEYS_MAX_STALE_MS) return known;
  if (loaded) return null;
  // Never loaded yet: wait briefly for the request that is loading them.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await sleep(500);
    const now = await ctx.runQuery(internal.signingKeys.cached, {});
    if (now && now.fetchedAt > 0) return (JSON.parse(now.keys) as KeyWithId[]).find((key) => key.kid === kid) ?? null;
  }
  throw new Error("Clerk's signing keys could not be loaded yet. Try again shortly.");
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * Checks a Clerk OAuth access token: RS256 signature by a current Clerk key,
 * Clerk's issuer, a current time window with well-formed times, and a client
 * id. A person's own browser session token (it carries a session id) is never
 * accepted here, whatever else it contains. If the token names audiences,
 * this service's public address must be one of them. Malformed tokens are
 * refused (null); only failing to load Clerk's keys throws.
 */
export async function verifyClerkAccessToken(ctx: ActionCtx, token: string, audience: string): Promise<ClerkAccessToken | null> {
  if (!clerkConfigured()) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: Record<string, unknown> | null;
  let claims: Record<string, unknown> | null;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = decodeJson(parts[0]!);
    claims = decodeJson(parts[1]!);
    signature = base64UrlDecode(parts[2]!);
  } catch {
    return null;
  }
  if (!header || !claims) return null;
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const jwk = await signingKey(ctx, header.kid);
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", { ...jwk, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) return null;
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== process.env.CLERK_ISSUER) return null;
  if (!isTime(claims.exp) || claims.exp < now - CLOCK_SKEW_SECONDS) return null;
  if (claims.nbf !== undefined && (!isTime(claims.nbf) || claims.nbf > now + CLOCK_SKEW_SECONDS)) return null;
  if (!isTime(claims.iat) || claims.iat > now + CLOCK_SKEW_SECONDS) return null;
  if (typeof claims.sub !== "string" || !claims.sub) return null;
  if (claims.sid !== undefined) return null;
  const clientId = typeof claims.client_id === "string" ? claims.client_id : typeof claims.azp === "string" ? claims.azp : null;
  if (!clientId) return null;
  if (claims.aud !== undefined) {
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(audience) && !audiences.includes(`${audience}/mcp`)) return null;
  }
  return { sub: claims.sub, clientId, issuedAt: claims.iat, signed: `${parts[0]}.${parts[1]}` };
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
