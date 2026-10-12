// The authentication boundary. A verifier turns a request's credential into a
// Planban connection id, or null. Planban-issued secrets (machine sign-ins,
// personal access keys, development tokens, OAuth access credentials) resolve
// by hash. Clerk proves human identity only at explicit enrollment.
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";

export interface Authenticated {
  connectionId: Id<"connections">;
}

export interface AuthVerifier {
  authenticate(ctx: ActionCtx, bearer: string): Promise<Authenticated | null>;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return prefix + btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const planbanTokenVerifier: AuthVerifier = {
  async authenticate(ctx, bearer) {
    if (!/^pb[a-z]_[A-Za-z0-9_-]{20,}$/.test(bearer)) return null;
    const resolved = await ctx.runQuery(internal.connections.resolveToken, { tokenHash: await sha256Hex(bearer) });
    if (!resolved) return null;
    if (resolved.oauthResource !== undefined && (!publicOrigin() || !resolved.oauthResource || ![publicOrigin(), `${publicOrigin()}/mcp`].includes(resolved.oauthResource))) return null;
    if (Date.now() - Date.parse(resolved.lastUsedAt) >= 60 * 60 * 1000) {
      await ctx.runMutation(internal.connections.touch, { connectionId: resolved.connectionId });
    }
    return { connectionId: resolved.connectionId };
  },
};

/** The service's public address, which Clerk tokens may name as their audience. */
export function publicOrigin() {
  return (process.env.PLANBAN_PUBLIC_URL ?? process.env.CONVEX_SITE_URL ?? "").replace(/\/+$/, "");
}

// Direct Clerk OAuth credentials cannot identify a grant incarnation. They
// remain denied even after a new service-owned connection is authorized.
const verifiers: AuthVerifier[] = [planbanTokenVerifier];

export async function authenticate(ctx: ActionCtx, request: Request): Promise<Authenticated | null> {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  for (const verifier of verifiers) {
    const result = await verifier.authenticate(ctx, match[1]!);
    if (result) return result;
  }
  return null;
}

/**
 * Development sign-in is only offered by a local backend with
 * PLANBAN_DEV_AUTH=1. A deployed service never has a loopback site URL.
 */
export function devAuthEnabled(): boolean {
  const site = process.env.CONVEX_SITE_URL ?? "";
  return process.env.PLANBAN_DEV_AUTH === "1" && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(site);
}
