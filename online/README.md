# Planban Online Boards: hosted service

An Online Board has one source of truth: this service, built on Convex. Local
Planban installs whose project manifest says `"storage": { "kind": "online" }`
read and write through it; local boards never touch it.

- `service/convex/`: the Convex functions. `boards.ts` runs the shared planning
  rules from `src/core/boardOperations.ts` inside one mutation per change.
  `http.ts` serves the REST API the local side uses (`/api/v1/...`).
  `live.ts` is the revision query a board server subscribes to.
- `scripts/`: end-to-end checks that run against a local backend.

## Run it locally (no account needed)

```sh
cd online/service
npm install
CONVEX_AGENT_MODE=anonymous npx convex dev          # leave running; serves http://127.0.0.1:3211
CONVEX_AGENT_MODE=anonymous node scripts/setup-local.mjs   # once: development sign-in and live-update key
```

Development sign-in (`planban online login http://127.0.0.1:3211 --dev-user owner`)
works only on a local backend with `PLANBAN_DEV_AUTH=1`.

Real sign-in uses Clerk. The backend's environment names the Clerk instance
(`CLERK_ISSUER`, `CLERK_JWKS_URL`) and the public OAuth client the command
line uses (`PLANBAN_CLI_CLIENT_ID`, registered with redirect addresses
`http://127.0.0.1:53682/callback` to `:53686`). `planban online login <url>`
then opens the browser to sign in with Clerk and keeps only this machine's own
Planban sign-in. AI apps (ChatGPT, Claude) sign in through Clerk with client ID
metadata documents; the service publishes `/.well-known/oauth-protected-resource/mcp`.

Clerk behaviour seen on the development instance, which the code relies on:
its access tokens are JWTs with `client_id`, `iat`, `jti` and no `sid` or
`aud`, last 24 hours and cannot be revoked (so the service accepts the command
line's token for one exchange only); and it sends codes to any loopback port,
not just the registered ones, as RFC 8252 allows. The Clerk instance must serve
Planban alone, since its tokens do not name an audience. Clerk gives every OAuth
app refresh tokens; each new access token can be exchanged once, but only
someone who completed the sign-in as that person ever holds a refresh token,
and the command line does not ask for one.

## Checks

From the repository root, with the backend running:

```sh
node --import tsx/esm online/scripts/smoke-convex.ts                     # REST API end to end
node --import tsx/esm online/scripts/history-convex.ts                   # history rebuilds and pruning
node --import tsx/esm online/scripts/generations-convex.ts               # Take Local bound to a generation, large exports, replays
PLANBAN_HOME=$(mktemp -d) node --import tsx/esm online/scripts/transfers-convex.ts   # killed transfers resume
PLANBAN_HOME=$(mktemp -d) node --import tsx/esm online/scripts/live-convex.ts   # live updates
node --import tsx/esm online/scripts/access-convex.ts                    # connections, sign-out, personal access keys
node --import tsx/esm online/scripts/index-convex.ts                     # boards hold text only; no file routes
node --import tsx/esm online/scripts/invites-convex.ts                   # invites, joining, roles, agent permissions
node --import tsx/esm online/scripts/clerk-tokens-convex.ts               # sign-in server tokens (see the script for its settings)
(cd online/service && node scripts/mcp-sdk-check.mjs)                  # remote MCP with the official MCP SDK client
online/scripts/demo-convex.sh                                            # two machines, CLI and local MCP
```

## Planban is an index, not storage

Online Boards hold text only (owner decision 18). The service has no file
routes, and every write (edits, remote MCP, Take Online) refuses embedded
files and oversized documents (`src/core/contentRules.ts`). The attachment
storage built earlier is kept but not routed: `convex/attachments.ts`,
`convex/model/blobs.ts`, `src/core/online/attachments.ts`, and its check in
`online/retired/attachments-convex.ts`.
