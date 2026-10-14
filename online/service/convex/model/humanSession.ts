// Clerk establishes human identity for explicit enrollment only. OAuth
// access credentials, machine credentials and caller-supplied identities
// cannot substitute for an active browser session.
import type { createClerkClient } from "@clerk/backend";
import { publicOrigin } from "./auth";

type SessionClient = ReturnType<typeof createClerkClient>;
export interface HumanIdentity { userId: string; sessionId: string }

export async function sessionClient(): Promise<SessionClient | null> {
  const secretKey = process.env.CLERK_SECRET_KEY;
  const publishableKey = process.env.CLERK_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey || !process.env.CLERK_ISSUER || !publicOrigin()) return null;
  try {
    const { createClerkClient } = await import("@clerk/backend");
    return createClerkClient({ secretKey, publishableKey });
  } catch { return null; }
}

/** Rechecked at code redemption; the app never receives the session token. */
export async function activeSessionIdentity(sessionId: string, userId: string, client?: SessionClient | null): Promise<HumanIdentity | null> {
  if (!/^sess_[A-Za-z0-9]+$/.test(sessionId) || !/^user_[A-Za-z0-9]+$/.test(userId)) return null;
  try {
    const verifier = client === undefined ? await sessionClient() : client;
    if (!verifier) return null;
    const session = await verifier.sessions.getSession(sessionId);
    return session.id === sessionId && session.userId === userId && session.status === "active" ? { sessionId, userId } : null;
  } catch { return null; }
}

export async function verifyHumanSession(request: Request, client?: SessionClient | null): Promise<HumanIdentity | null> {
  const issuer = process.env.CLERK_ISSUER;
  const origin = publicOrigin();
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("Authorization") ?? "");
  if (!issuer || !origin || !bearer) return null;
  try {
    const verifier = client === undefined ? await sessionClient() : client;
    if (!verifier) return null;
    // Clerk parses a literal "Bearer " prefix. Preserve HTTP scheme case
    // insensitivity without transferring or consuming the handler's body.
    const headers = new Headers(request.headers);
    headers.set("Authorization", `Bearer ${bearer[1]}`);
    const proof = new Request(request.url, { method: request.method, headers });
    const state = await verifier.authenticateRequest(proof, { acceptsToken: "session_token", authorizedParties: [origin] });
    if (!state.isAuthenticated) return null;
    const auth = state.toAuth();
    if (auth.tokenType !== "session_token" || !auth.userId || !auth.sessionId || auth.sessionClaims?.iss !== issuer || auth.sessionClaims?.azp !== origin) return null;
    return activeSessionIdentity(auth.sessionId, auth.userId, verifier);
  } catch { return null; }
}
