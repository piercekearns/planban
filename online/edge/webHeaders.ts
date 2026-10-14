// The web page's security headers (Planban 2.0 plan, "Hosting"), written as
// the _headers file Workers static assets serve with every page file. The
// Content Security Policy is built from the deployed Clerk and Convex
// addresses: Clerk's frontend for its scripts, calls, images and frames, plus
// its bot-protection and challenge frames and workers (the same allowances
// the service's own consent page uses); Convex over HTTPS and WebSocket for
// live updates. Nothing else may load, and no other site may frame the page.

export interface WebHeaderSettings {
  /** Clerk's frontend API origin for this deployment, for example https://clerk.planban.ai. */
  clerkFrontendApi: string;
  /** The Convex deployment's client address, for example https://name-123.eu-west-1.convex.cloud. */
  convexCloudUrl: string;
}

function exactOrigin(value: string, what: string, host?: RegExp): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${what} must be an https origin.`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !["", "/"].includes(url.pathname)
    || !/^[a-z0-9.-]+$/.test(url.hostname) || (host && !host.test(url.hostname))) {
    throw new Error(`${what} must be an https origin.`);
  }
  return url;
}

export function contentSecurityPolicy(settings: WebHeaderSettings): string {
  const clerk = exactOrigin(settings.clerkFrontendApi, "The Clerk frontend API").origin;
  const convex = exactOrigin(settings.convexCloudUrl, "The Convex address", /^[a-z0-9-]+(\.[a-z0-9-]+)?\.convex\.cloud$/).host;
  return [
    "default-src 'none'",
    `script-src 'self' ${clerk} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    // Clerk's components and the page's own inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${clerk} https://*.protect.clerk.com:* https://${convex} wss://${convex}`,
    `img-src 'self' ${clerk} https://img.clerk.com data:`,
    "font-src 'self'",
    `frame-src ${clerk} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** The whole _headers file. */
export function headersFile(settings: WebHeaderSettings): string {
  return [
    "/*",
    `  Content-Security-Policy: ${contentSecurityPolicy(settings)}`,
    "  Referrer-Policy: no-referrer",
    "  X-Content-Type-Options: nosniff",
    "  X-Frame-Options: DENY",
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
    "",
  ].join("\n");
}
