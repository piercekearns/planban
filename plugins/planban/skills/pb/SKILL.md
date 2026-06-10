---
name: pb
description: Fast Planban opener. Use when the user invokes pb, /pb, asks to quickly open Planban, or wants the best matching Planban board visible in Codex.
---

# PB

Open Planban quickly with minimal explanation.

## Behavior

Resolve the board in this order:

1. If the current workspace/repo has `.planban/project.json` and that repo has a registered Planban board, open that board.
2. Else if there is exactly one registered Planban board, open that board.
3. Else open the all-boards view.

Use the Codex in-app browser when available. If the Browser plugin is available, load its `browser:control-in-app-browser` skill and navigate to the resolved local URL.

## Fast Path

Prefer the fastest reliable route:

```bash
node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo
```

If there is no current project board or the command cannot resolve a specific board, open:

```text
http://localhost:4317/boards
```

If browser automation fails, return the clickable URL and say that the user can open it in the Codex in-app browser.

Keep the response short. This is a muscle-memory command, not a tutorial.
