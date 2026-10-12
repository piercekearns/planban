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

## Browser sign-in and remote MCP

Clerk proves the human identity for an explicit Planban consent screen. Set
`CLERK_ISSUER`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` and the canonical
`PLANBAN_PUBLIC_URL` privately on the selected backend. The publishable key and
issuer must belong to the same dedicated Clerk application. Never put secret
values in command arguments, chat or committed files.

Planban is the OAuth authorization server. Its discovery document is
`/.well-known/oauth-authorization-server`; protected MCP resource discovery is
`/.well-known/oauth-protected-resource/mcp`. Authorization uses S256 PKCE and
freezes the client, callback, resource and requested permissions before the
person chooses Allow or Cancel. The server verifies an active Clerk browser
session, including the configured issuer and authorized party, and checks it
again when a session-backed code is redeemed.

`planban online login <url>` uses the predefined `planban-cli` client and
`planban:machine` purpose. Its registered callbacks are
`http://127.0.0.1:53682/callback` through `:53686/callback`. Code redemption
returns this machine's own opaque credential directly. It persists until
sign-out or about 90 days unused; it does not retain provider tokens or a
refresh token. Signing out revokes that machine's connection.

Remote agents use `planban:read`, `planban:plan` or `planban:complete`, with
`offline_access` when needed. Access credentials last five minutes; rotating
refresh credentials expire after 90 days unused, bounded by a one-year grant.
Every credential belongs to one independently revocable connection. Refresh
replay closes that family. Explicit new consent creates a separate connection;
old revoked access and refresh-derived credentials stay refused. Direct Clerk
OAuth bearer exchange and restoration of revoked connections are retired.

Client metadata is fetched only from the reviewed exact publisher documents:

- `https://chatgpt.com/oauth/codex/client.json`
- `https://chatgpt.com/oauth/client.json`
- `https://claude.ai/oauth/claude-code-client-metadata`

The service trusts these publishers' DNS/TLS, follows no redirects, bounds
response size/time and fetches no secondary URLs. Dynamic registration and
arbitrary metadata publishers are disabled. Native callback ports may vary only
on a registered literal loopback IP and exact path. Only the exact Claude Code
publisher also permits a canonical port from 1 through 65535 on its registered
HTTP localhost callback, keeping host and raw path unchanged; other publishers'
localhost callbacks retain exact matching. This relies on the computer's
localhost resolution and PKCE, and does not authenticate the installed program.
Claude Code's reviewed native document omits `application_type`; that omission
is recognized only for this exact publisher. The separate hosted
Claude connector identity and acceptance remain unverified.

MCP discovery reflects the credential's current board permissions. Read grants
receive read tools; planning grants receive permitted writes without completion;
completion is scoped to eligible boards and requires explicit confirmation.
Each discovery request is private and uncached on the server. This stateless
endpoint advertises `listChanged: false` and sends no change notifications;
`ttlMs: 0` does not make SDK or native clients refresh their cached tool lists.
After changing board access, request `tools/list` again. In a client that caches
discovery, reconnect or reload the MCP connection to obtain its current tools
and board choices. That rediscovery can reuse a still-valid credential; access
beyond its original OAuth scopes requires new explicit authorization. Calls
always recheck authorization inside the operation, regardless of previously
discovered schemas.

Deterministic tests and SDK simulations do not establish real sign-in or client
acceptance. Provider-backed consent, native OAuth, refresh/revoke/reconnect and
independent machines must be verified on the exact candidate. Hosted connectors
cannot use a loopback-only backend; an externally reachable deployment and real
owner identities remain separate acceptance gates.

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
node --import tsx/esm online/scripts/limits-convex.ts                    # board size and daily volume caps (needs PLANBAN_TEST_LIMITS; see the script)
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

The guarantee has three layers, set out at the top of `src/core/contentRules.ts`
and in the card's spec (decision 21): the text check, the size and volume caps
(`convex/model/limits.ts`), and never serving stored text as a file
(`tests/no-file-serving.test.ts`). New ways of writing a file as text found
later are follow-ups, not blockers; record them here.

Historical direct-provider-token probes are archived in `retired/clerk-tokens-convex.ts`; they are not checks for the current enrollment boundary.
