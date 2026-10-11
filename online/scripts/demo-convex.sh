#!/usr/bin/env bash
# One-command Online Board demo on a local Convex backend: two Planban installs
# ("MacBook" and "Mac mini", each with its own PLANBAN_HOME and project folder)
# share one Online Board. Uses only temporary folders and a fresh demo board;
# never touches ~/.planban or port 4317.
#
# Start the backend first, in online/service:
#   CONVEX_AGENT_MODE=anonymous npx convex dev
#   CONVEX_AGENT_MODE=anonymous npx convex env set PLANBAN_DEV_AUTH 1
#
#   online/scripts/demo-convex.sh            run the demo
#   online/scripts/demo-convex.sh --serve    also open both board UIs (ports 4418 and 4419)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SERVICE="$ROOT/online/service"
URL="${PLANBAN_ONLINE_URL:-http://127.0.0.1:3211}"
NODE=(node)
[ -x "$HOME/mac-mini-setup/dev24" ] && NODE=("$HOME/mac-mini-setup/dev24" node)

status="$(curl -s -o /dev/null -w '%{http_code}' "$URL/api/v1/me" || true)"
[ "$status" = "401" ] || { echo "No Online Board service at $URL. Start it as described at the top of this script."; exit 1; }

DEMO="$(mktemp -d)"
MACBOOK_HOME="$DEMO/macbook-home"; MACBOOK_REPO="$DEMO/macbook-project"
MINI_HOME="$DEMO/mini-home";       MINI_REPO="$DEMO/mini-project"
mkdir -p "$MACBOOK_HOME" "$MACBOOK_REPO" "$MINI_HOME" "$MINI_REPO"
BOARD="online-demo-$(date +%H%M%S)"

macbook() { PLANBAN_HOME="$MACBOOK_HOME" "${NODE[@]}" "$ROOT/bin/planban.mjs" "$@"; }
mini()    { PLANBAN_HOME="$MINI_HOME"    "${NODE[@]}" "$ROOT/bin/planban.mjs" "$@"; }
titles()  { "${NODE[@]}" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const items=j.roadmapItems??j.roadmap?.roadmapItems??j.cards??j;for(const i of items)console.log("    - "+i.title+" ("+i.status+")")})'; }
step()    { printf '\n== %s\n' "$1"; }

step "MacBook: a normal local board with three cards"
macbook init --cwd "$MACBOOK_REPO" --repo-id "$BOARD" --title "Online demo" --no-agents -o json >/dev/null
macbook create-card "Plan the launch" --summary "Created locally on the MacBook." --cwd "$MACBOOK_REPO" -o json >/dev/null
macbook create-card "Write the FAQ" --cwd "$MACBOOK_REPO" -o json >/dev/null
macbook create-card "Pick a domain" --status up-next --cwd "$MACBOOK_REPO" -o json >/dev/null
macbook list-cards --cwd "$MACBOOK_REPO" -o json | titles

step "MacBook: sign in and Take Online"
macbook online login "$URL" --dev-user owner >/dev/null
macbook online take-online "$URL" --cwd "$MACBOOK_REPO" >/dev/null
echo "    Board $BOARD is now online at $URL"

step "Mac mini: sign in, attach the same board, add a card"
mini online login "$URL" --dev-user owner >/dev/null
mini online attach "$URL" "$BOARD" --cwd "$MINI_REPO" >/dev/null
mini create-card "Added on the Mac mini" --summary "Created by the mini's CLI." --cwd "$MINI_REPO" -o json >/dev/null
mini list-cards --cwd "$MINI_REPO" -o json | titles

step "MacBook sees the Mac mini's card without any sync"
macbook list-cards --cwd "$MACBOOK_REPO" -o json | titles
macbook list-cards --cwd "$MACBOOK_REPO" -o json | grep -q "Added on the Mac mini" || { echo "    The MacBook does not see the mini's card."; exit 1; }

step "A stale edit is refused cleanly (revision conflict)"
if macbook update-card plan-the-launch --summary "Edited from an old view" --base-revision 1 --cwd "$MACBOOK_REPO" -o json >/dev/null 2>"$DEMO/conflict.txt"; then
  echo "    Unexpected: the stale edit was accepted."; exit 1
else
  echo "    Refused: $(tail -1 "$DEMO/conflict.txt")"
fi

step "Local agent on the Mac mini, through the ordinary local MCP server"
(cd "$SERVICE" && PLANBAN_HOME="$MINI_HOME" "${NODE[@]}" scripts/local-mcp-check.mjs "$ROOT" "$MINI_REPO")
macbook list-cards --cwd "$MACBOOK_REPO" -o json | grep -q "Added by a local agent" || { echo "    The MacBook does not see the local agent's card."; exit 1; }
echo "    ok - the MacBook sees the local agent's card"

step "Mac mini: Take Local, then the online copy is read-only"
mini online take-local --cwd "$MINI_REPO" >/dev/null
mini list-cards --cwd "$MINI_REPO" -o json | titles
if macbook create-card "After take local" --cwd "$MACBOOK_REPO" -o json >/dev/null 2>&1; then
  echo "    Unexpected: the online copy accepted an edit after Take Local."; exit 1
fi
echo "    ok - the MacBook's online view refuses edits after Take Local"

cat <<EOF

Demo folders: $DEMO
Look at it in the board UI (each in its own terminal):
  PLANBAN_HOME="$MACBOOK_HOME" node "$ROOT/bin/planban.mjs" serve --cwd "$MACBOOK_REPO" --port 4418
  PLANBAN_HOME="$MINI_HOME" node "$ROOT/bin/planban.mjs" serve --cwd "$MINI_REPO" --port 4419
EOF

if [ "${1:-}" = "--serve" ]; then
  PLANBAN_HOME="$MACBOOK_HOME" "${NODE[@]}" "$ROOT/bin/planban.mjs" serve --cwd "$MACBOOK_REPO" --port 4418 &
  PLANBAN_HOME="$MINI_HOME" "${NODE[@]}" "$ROOT/bin/planban.mjs" serve --cwd "$MINI_REPO" --port 4419 &
  wait
fi
