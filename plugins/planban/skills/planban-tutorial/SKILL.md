---
name: planban-tutorial
description: Open the interactive Planban tutorial in Codex. Use when the user wants onboarding, first-run guidance, a tour, help learning Planban, or to reopen the tutorial.
---

# Planban Tutorial

Open the interactive Planban tutorial quickly.

## Behavior

Use the Codex in-app browser when available. If the Browser plugin is available, load its `browser:control-in-app-browser` skill and navigate to the tutorial URL.

Prefer the helper script:

```bash
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

The script creates or reuses the local Planban Demo board, starts the local app if needed, and prints a URL like:

```text
http://localhost:4317/tutorial?mode=first-run
```

Open that URL in the Codex in-app browser, not an external browser, unless the in-app browser is unavailable.

Keep the response short. This command is for getting the user into the product tour, not explaining every Planban concept in chat.
