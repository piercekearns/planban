// Convex verifies the short-lived live-update tokens Planban signs itself
// (model/liveToken.ts). Each query still checks the connection row, so a
// revoked connection stops at once.
const site = process.env.CONVEX_SITE_URL;

export default {
  providers: [
    {
      type: "customJwt" as const,
      applicationID: "planban-live",
      issuer: site!,
      jwks: `${site}/.well-known/jwks.json`,
      algorithm: "ES256" as const,
    },
  ],
};
