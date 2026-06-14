---
name: planban
description: Use when the user invokes /planban, asks to open Planban, mentions a Planban board, roadmap item, card, spec, plan, docs, or wants Codex to work with Planban state.
---

# Planban

`/planban` and `/pb` are two entry points for the same primary outcome: surface the
best matching Planban board in the Codex in-app browser, or the best fallback surface
when a specific board cannot be selected safely.

Use `/planban` as the memorable full-name command and `/pb` as the faster-to-type
power-user command. Do not make them semantically different for board opening.

## Default Open Behavior

When the user invokes `/planban` with no extra instruction, selects Planban from the
slash menu, says "open Planban", or otherwise asks to see their board, open Planban
quickly with minimal explanation.

Resolve the target in this order:

1. If the current workspace/repo has `.planban/project.json` and that repo has a
   registered Planban board, open that board.
2. Else if there is exactly one registered Planban board, open that board.
3. Else open the all-boards view.

Opening the resolved target in the Codex in-app browser is the expected outcome. A
clickable URL is only a fallback if browser automation is unavailable or has actually
failed.

## Fast Path

Prefer the fastest reliable route:

1. If the Planban MCP tool `planban_launch_board` is available, call it with the
   current workspace `cwd`, then open the returned URL in the Codex in-app browser.
2. Otherwise, run the helper script:

```bash
node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo
```

Then open the printed URL in the Codex in-app browser.

If no specific board can be selected safely, open:

```text
http://localhost:4317/boards
```

## Browser Expectation

If the Browser plugin is available, load the current `browser:control-in-app-browser`
skill/runtime and navigate to the resolved local URL. Codex updates can move the
Browser plugin to a new versioned cache path, so rediscover the Browser runtime if an
old path fails.

After navigating, verify the in-app browser state before replying:

1. Confirm the in-app browser is visible or has been shown.
2. Confirm a browser tab is open at the resolved Planban URL.
3. If the selected/current tab is not at that URL, navigate it or open a new in-app
   browser tab and verify again.

Use the Browser runtime's visibility capability explicitly when the user expects the board
to appear beside the Codex thread:

```js
await (await browser.capabilities.get("visibility")).set(true);
```

When working with Browser tab snapshots, rehydrate the tab before navigating:

```js
const tab = await browser.tabs.get(snapshot.id);
await tab.goto(resolvedUrl);
```

Some Browser APIs expose tab snapshots from `tabs.list()` and full tab handles from
`tabs.get(id)`. Do not assume a listed tab has navigation methods. Prefer `tab.goto()`
on a full tab handle, then verify `await tab.url()` matches the resolved Planban URL.

Do not say the board is open until the URL check succeeds. If URL verification still
fails after retrying, return the clickable URL and say briefly that the user can open
it in the Codex in-app browser.

Keep the response short. This is a muscle-memory command, not a tutorial.

## Broader Planban Work

Opening a board is not a roadmap mutation. For plain open-board requests, do not read
linked card docs or the broader Planban protocol.

For roadmap, card, spec, plan, docs, status, creation, review, or completion work,
read `references/planban-protocol.md` before changing Planban state.
