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
works only on a local backend with `PLANBAN_DEV_AUTH=1`. Real sign-in uses Clerk.

## Checks

From the repository root, with the backend running:

```sh
node --import tsx/esm online/scripts/smoke-convex.ts                     # REST API end to end
node --import tsx/esm online/scripts/history-convex.ts                   # history rebuilds and pruning
node --import tsx/esm online/scripts/generations-convex.ts               # Take Local bound to a generation, large exports, replays
PLANBAN_HOME=$(mktemp -d) node --import tsx/esm online/scripts/transfers-convex.ts   # killed transfers resume
PLANBAN_HOME=$(mktemp -d) node --import tsx/esm online/scripts/live-convex.ts   # live updates
node --import tsx/esm online/scripts/access-convex.ts                    # connections, sign-out, personal access keys
PLANBAN_HOME=$(mktemp -d) node --import tsx/esm online/scripts/attachments-convex.ts   # card attachments
(cd online/service && node scripts/mcp-sdk-check.mjs)                  # remote MCP with the official MCP SDK client
online/scripts/demo-convex.sh                                            # two machines, CLI and local MCP
```
