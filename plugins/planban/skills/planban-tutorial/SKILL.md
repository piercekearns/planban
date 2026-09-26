---
name: planban-tutorial
description: Open the interactive Planban tutorial in the host's in-app browser. Use when the user wants onboarding, first-run guidance, a tour, help learning Planban, or to reopen the tutorial.
---

# Planban Tutorial

Open the interactive Planban tutorial quickly.

After resolving the tutorial URL, every user-facing confirmation must include the exact verified URL as a clickable Markdown link, even when in-app browser presentation succeeds. Never reply only that the tutorial opened.

## Behavior

1. Resolve the tutorial URL with the helper script:

   ```bash
   node plugins/planban/scripts/launch-planban.mjs --tutorial
   ```

   Outside a Planban source checkout, run `scripts/launch-planban.mjs` from the plugin root (two directories above this skill's folder). The script creates or reuses the local Planban Demo board, starts the local app if needed, and prints a URL like:

   ```text
   http://127.0.0.1:4317/tutorial?mode=first-run
   ```

2. Make one bounded in-app presentation attempt through the adapter for this host under **Host adapters**. Hosts without an adapter skip this step.
3. Reply with the clickable tutorial URL in every outcome:

   - Browser verified: `Planban tutorial is open: [Open the tutorial](URL)`
   - Browser unavailable, failed, or not attempted: `Planban tutorial is running: [Open the tutorial](URL)` and say briefly that automatic in-app opening was unavailable.

Keep the response short. This command is for getting the user into the product tour, not explaining every Planban concept in chat.

## Host adapters

Use only the subsection for the host you are running in.

### Codex desktop

Use the Codex in-app browser when available. If the Browser plugin is available, load its current `browser:control-in-app-browser` skill and navigate to the tutorial URL.

Codex updates can move the Browser plugin to a new versioned cache path. Do not rely on a stale Browser skill path from earlier thread context. If loading Browser instructions or `browser-client.mjs` fails because a path no longer exists, rediscover the current Browser plugin/skill/runtime and retry before falling back to a plain URL.

After navigating, verify the in-app browser state before replying: the in-app browser should be visible or shown, and a tab should be open at the tutorial URL. If the selected/current tab is not at that URL, navigate it or open a new in-app browser tab and verify again.

Use the Browser runtime's visibility capability explicitly when the user expects the
tutorial to appear beside the Codex thread:

```js
await (await browser.capabilities.get("visibility")).set(true);
```

When working with Browser tab snapshots, rehydrate the tab before navigating:

```js
const tab = await browser.tabs.get(snapshot.id);
await tab.goto(tutorialUrl);
```

Some Browser APIs expose tab snapshots from `tabs.list()` and full tab handles from
`tabs.get(id)`. Do not assume a listed tab has navigation methods. Prefer `tab.goto()`
on a full tab handle, then verify `await tab.url()` matches the tutorial URL.

Open that URL in the Codex in-app browser, not an external browser, unless the in-app browser is unavailable.

Do not say the tutorial is open until the in-app browser URL check succeeds.

### Claude Code desktop

Open the tutorial URL in the built-in browser pane with the pane's navigate tool (currently `mcp__Claude_Browser__navigate` with `{ "url": "<tutorial URL>" }`). Tool names can change between app versions, so match on that capability.

- Make one attempt. If the tool is listed as deferred, load it with a single tool-search call first; search no further.
- If no such tool is in the session, or the call errors, skip presentation and return the link with one short reason.
- Keep the attempt inside the pane: the OS `open` command and external browsers are not first attempts, and Computer Use is out of scope.

### Other hosts

Make no presentation attempt. Return the link.
