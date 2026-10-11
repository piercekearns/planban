// Signing out, the connection list and personal access keys, from this machine.
import { PlanbanValidationError } from "../boardOperations";
import { onlineRequest } from "./client";
import { readCredentials, saveCredentials, serviceUrl } from "./credentials";

/**
 * Signing out revokes this machine's connection on the service (owner
 * decision 7), then forgets it here. If the service cannot be reached, the
 * local sign-in is still removed and the result says the hosted connection
 * remains until it is revoked from another signed-in machine.
 */
export async function onlineLogout(urlInput: string) {
  const url = serviceUrl(urlInput);
  if (!(await readCredentials()).services[url]) return { url, signedOut: true, revoked: false, note: "This machine was not signed in." };
  let revoked = false;
  let note: string | undefined;
  try {
    await onlineRequest(url, "/api/v1/connections/self/revoke", {}, { signal: AbortSignal.timeout(10_000) });
    revoked = true;
  } catch (error) {
    note = `The service could not be reached (${error instanceof Error ? error.message : String(error)}). This machine's connection stays active until you revoke it with planban online revoke from another signed-in machine.`;
  }
  await saveCredentials(url, null);
  return { url, signedOut: true, revoked, ...(note ? { note } : {}) };
}

export async function listConnections(urlInput: string) {
  return onlineRequest<{ connections: unknown[] }>(serviceUrl(urlInput), "/api/v1/connections");
}

export async function revokeConnection(urlInput: string, connectionId: string) {
  if (!connectionId.trim()) throw new PlanbanValidationError("Name the connection to revoke.");
  return onlineRequest(serviceUrl(urlInput), `/api/v1/connections/${encodeURIComponent(connectionId)}/revoke`, {});
}

/** Creates a personal access key. The key is in the result once and is never shown again. */
export async function createKey(urlInput: string, input: { boardId: string; level: "read" | "plan" | "complete"; name: string; expiresInDays?: number | undefined }) {
  return onlineRequest<{ id: string; key: string; name: string; boardId: string; level: string; expiresAt?: string }>(serviceUrl(urlInput), "/api/v1/keys", input);
}
