// Convex fetch does not expose connection-time DNS pinning. Client metadata
// therefore comes only from these reviewed publisher URLs, trusting their
// DNS/TLS rather than accepting arbitrary caller-selected network targets.
// Dynamic registration is disabled. Other clients need a reviewed policy.
export const CLAUDE_CODE_CLIENT_ID = "https://claude.ai/oauth/claude-code-client-metadata";
const METADATA_CLIENTS = new Set([
  "https://chatgpt.com/oauth/codex/client.json",
  "https://chatgpt.com/oauth/client.json",
  CLAUDE_CODE_CLIENT_ID,
]);
const MAX_BYTES = 5 * 1024;
export function metadataClientAllowed(clientId: string): boolean { return METADATA_CLIENTS.has(clientId); }
export interface OAuthClient {
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly native: boolean;
}

function validRedirect(value: string, native: boolean, codeLocalhost = false): boolean {
  try {
    const url = new URL(value);
    const literalLoopback = native && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
    const nativeCodeLocalhost = codeLocalhost && native && url.protocol === "http:" && url.hostname === "localhost";
    if (nativeCodeLocalhost) {
      // This publisher's installed CLI binds a varying localhost port. Keep
      // the raw authority canonical and exclude zero or normalized port forms.
      const authority = /^http:\/\/localhost(?::([1-9]\d*))?\//.exec(value);
      if (!authority || (authority[1] !== undefined && Number(authority[1]) > 65535)) return false;
    }
    // URL serialization removes the explicit default port. Allow that one
    // spelling for native loopback, but no other normalization of raw URIs.
    const canonical = nativeCodeLocalhost ? value.replace(/^http:\/\/localhost:80(?=\/)/, "http://localhost") : literalLoopback ? value.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\])):80(?=\/)/, "$1") : value;
    if (url.href !== canonical || url.username || url.password || value.includes("#")) return false;
    if (url.protocol === "https:") return true;
    return native && url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) && !value.includes("?");
  } catch { return false; }
}

export function parseClientMetadata(clientId: string, input: unknown): OAuthClient | null {
  if (!METADATA_CLIENTS.has(clientId) || !input || typeof input !== "object" || Array.isArray(input)) return null;
  const doc = input as Record<string, unknown>;
  if (doc.client_id !== clientId || typeof doc.client_name !== "string" || !doc.client_name.trim() || doc.client_name.length > 200) return null;
  // This exact reviewed publisher identifies a native CLI and publishes
  // loopback callbacks while omitting the optional application_type field.
  // Do not infer native behavior for any other document or override a type.
  const native = doc.application_type === "native" || (clientId === CLAUDE_CODE_CLIENT_ID && doc.application_type === undefined);
  const redirects = doc.redirect_uris;
  if (!Array.isArray(redirects) || !redirects.length || redirects.length > 20 || redirects.some((value) => typeof value !== "string" || value.length > 2048 || !validRedirect(value, native, clientId === CLAUDE_CODE_CLIENT_ID))) return null;
  // Some publishers list a legacy preferred method and multiple supported
  // methods. We accept only the intersection with our public-client method.
  const methods = doc.token_endpoint_auth_methods_supported ?? [doc.token_endpoint_auth_method];
  if (!Array.isArray(methods) || !methods.includes("none")) return null;
  if (!Array.isArray(doc.grant_types) || !doc.grant_types.includes("authorization_code") || !Array.isArray(doc.response_types) || !doc.response_types.includes("code")) return null;
  return Object.freeze({ clientId, name: doc.client_name.trim(), redirectUris: Object.freeze([...new Set(redirects as string[])]), native });
}

export function clientRedirectAllowed(client: OAuthClient, redirectUri: string): boolean {
  const codeLocalhost = client.clientId === CLAUDE_CODE_CLIENT_ID;
  if (redirectUri.length > 2048 || !validRedirect(redirectUri, client.native, codeLocalhost)) return false;
  if (client.redirectUris.includes(redirectUri)) return true;
  const requested = new URL(redirectUri);
  if (codeLocalhost && client.native && requested.protocol === "http:" && requested.hostname === "localhost") {
    const withoutPort = (value: string) => value.replace(/^http:\/\/localhost:[1-9]\d*(?=\/)/, "http://localhost");
    return client.redirectUris.some((value) => validRedirect(value, true, true) && withoutPort(value) === withoutPort(redirectUri));
  }
  // RFC 8252 allows a native client's ephemeral port to vary on a literal
  // loopback IP. The reviewed Code localhost exception above is separate;
  // no other DNS names or different paths are accepted.
  if (!client.native || requested.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(requested.hostname)) return false;
  const withoutPort = (value: string) => value.replace(/^(http:\/\/(?:127\.0\.0\.1|\[::1\])):\d+(?=\/)/, "$1");
  return client.redirectUris.some((value) => withoutPort(value) === withoutPort(redirectUri));
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
