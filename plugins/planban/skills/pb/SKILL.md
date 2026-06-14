---
name: pb
description: Fast Planban opener. Use when the user invokes pb, /pb, asks to quickly open Planban, or wants the best matching Planban board visible in Codex.
---

# PB

Open Planban quickly with minimal explanation.

`/pb` and `/planban` are two entry points for the same primary outcome: surface the
best matching Planban board in the Codex in-app browser, or the best fallback surface
when a specific board cannot be selected safely. `/pb` is the faster-to-type power-user
command; `/planban` is the memorable full-name command.

## Behavior

Resolve the board in this order:

1. If the current workspace/repo has `.planban/project.json` and that repo has a registered Planban board, open that board.
2. Else if there is exactly one registered Planban board, open that board.
3. Else open the all-boards view.

Opening the resolved board in the Codex in-app browser is the expected outcome of this skill, not an optional enhancement. After resolving the URL, use the Codex in-app browser when available. If the Browser plugin is available, load its current `browser:control-in-app-browser` skill and navigate to the resolved local URL.

Codex updates can move the Browser plugin to a new versioned cache path. Do not rely on a stale Browser skill path from earlier thread context. If loading Browser instructions or `browser-client.mjs` fails because a path no longer exists, rediscover the current Browser plugin/skill/runtime and retry before falling back to a plain URL.

Do not stop after printing or linking the resolved URL unless in-app browser automation has actually failed or the Browser plugin is unavailable in the current environment. A clickable URL is the fallback, not success.

After navigating, verify the in-app browser state before replying:

1. Confirm the in-app browser is visible or has been shown.
2. Confirm a browser tab is open at the resolved Planban URL.
3. If the selected/current tab is not at that URL, navigate it or open a new in-app browser tab and verify again.

Do not say the board is open until the in-app browser URL check succeeds. If the URL check still fails after retrying, return the clickable URL and explain briefly that the user can open it in the Codex in-app browser.

## Fast Path

Prefer the fastest reliable route:

1. If the Planban MCP tool `planban_launch_board` is available, call it with the current workspace `cwd`, then open the returned URL in the Codex in-app browser.
2. Otherwise, run the helper script:

```bash
node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo
```

Then open the printed URL in the Codex in-app browser.

If there is no current project board or the command cannot resolve a specific board, open:

```text
http://localhost:4317/boards
```

If browser automation or the in-app browser URL verification fails after retrying with the current Browser runtime, return the clickable URL and say that the user can open it in the Codex in-app browser.

Keep the response short. This is a muscle-memory command, not a tutorial.
