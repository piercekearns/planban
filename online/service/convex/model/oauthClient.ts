// Convex fetch does not expose connection-time DNS pinning. Client metadata
// therefore comes only from these reviewed publisher URLs, trusting their
// DNS/TLS rather than accepting arbitrary caller-selected network targets.
// Dynamic registration is disabled. Other clients need a reviewed policy.
export const METADATA_CLIENTS = new Set([
  "https://chatgpt.com/oauth/codex/client.json",
  "https://chatgpt.com/oauth/client.json",
]);
const MAX_BYTES = 5 * 1024;
export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  native: boolean;
}

function validRedirect(value: string, native: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.href !== value || url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return native && url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) && !url.search;
  } catch { return false; }
}

export function parseClientMetadata(clientId: string, input: unknown): OAuthClient | null {
  if (!METADATA_CLIENTS.has(clientId) || !input || typeof input !== "object" || Array.isArray(input)) return null;
  const doc = input as Record<string, unknown>;
  if (doc.client_id !== clientId || typeof doc.client_name !== "string" || !doc.client_name.trim() || doc.client_name.length > 200) return null;
  const native = doc.application_type === "native";
  const redirects = doc.redirect_uris;
  if (!Array.isArray(redirects) || !redirects.length || redirects.length > 20 || redirects.some((value) => typeof value !== "string" || value.length > 2048 || !validRedirect(value, native))) return null;
  // Some publishers list a legacy preferred method and multiple supported
  // methods. We accept only the intersection with our public-client method.
  const methods = doc.token_endpoint_auth_methods_supported ?? [doc.token_endpoint_auth_method];
  if (!Array.isArray(methods) || !methods.includes("none")) return null;
  if (!Array.isArray(doc.grant_types) || !doc.grant_types.includes("authorization_code") || !Array.isArray(doc.response_types) || !doc.response_types.includes("code")) return null;
  return { clientId, name: doc.client_name.trim(), redirectUris: [...new Set(redirects as string[])], native };
}

export function clientRedirectAllowed(client: OAuthClient, redirectUri: string): boolean {
  if (redirectUri.length > 2048 || !validRedirect(redirectUri, client.native)) return false;
  if (client.redirectUris.includes(redirectUri)) return true;
  const requested = new URL(redirectUri);
  // RFC 8252 allows a native client's ephemeral port to vary on a literal
  // loopback IP. Do not extend that exception to DNS names or different paths.
  if (!client.native || requested.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(requested.hostname) || !requested.port) return false;
  return client.redirectUris.some((value) => {
    const registered = new URL(value);
    return registered.protocol === requested.protocol && registered.hostname === requested.hostname && registered.pathname === requested.pathname && !registered.search && !registered.hash;
  });
}

/** Fetch no logos, keys or secondary URLs, and follow no redirects. */
export async function loadOAuthClient(clientId: string, fetcher: typeof fetch = fetch): Promise<OAuthClient | null> {
  if (!METADATA_CLIENTS.has(clientId)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(clientId, { redirect: "error", signal: controller.signal, headers: { Accept: "application/json" } });
    if (response.status !== 200 || response.redirected || (response.url && response.url !== clientId) || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")) return null;
    const length = response.headers.get("Content-Length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return null;
    reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) return null;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return parseClientMetadata(clientId, JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { return null; }
  finally { clearTimeout(timer); controller.abort(); if (reader) await reader.cancel().catch(() => {}); }
}
