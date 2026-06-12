---
name: planban-tutorial
description: Open the interactive Planban tutorial in Codex. Use when the user wants onboarding, first-run guidance, a tour, help learning Planban, or to reopen the tutorial.
---

# Planban Tutorial

Open the interactive Planban tutorial quickly.

## Behavior

Use the Codex in-app browser when available. If the Browser plugin is available, load its current `browser:control-in-app-browser` skill and navigate to the tutorial URL.

Codex updates can move the Browser plugin to a new versioned cache path. Do not rely on a stale Browser skill path from earlier thread context. If loading Browser instructions or `browser-client.mjs` fails because a path no longer exists, rediscover the current Browser plugin/skill/runtime and retry before falling back to a plain URL.

After navigating, verify the in-app browser state before replying: the in-app browser should be visible or shown, and a tab should be open at the tutorial URL. If the selected/current tab is not at that URL, navigate it or open a new in-app browser tab and verify again.

Prefer the helper script:

```bash
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

The script creates or reuses the local Planban Demo board, starts the local app if needed, and prints a URL like:

```text
http://localhost:4317/tutorial?mode=first-run
```

Open that URL in the Codex in-app browser, not an external browser, unless the in-app browser is unavailable.

Do not say the tutorial is open until the in-app browser URL check succeeds. If the URL check still fails after retrying, return the clickable URL and say that the user can open it in the Codex in-app browser.

Keep the response short. This command is for getting the user into the product tour, not explaining every Planban concept in chat.
