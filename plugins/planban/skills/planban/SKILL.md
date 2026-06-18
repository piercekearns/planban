---
name: planban
description: Use when the user invokes /planban, asks to open Planban, mentions a Planban board, roadmap item, card, spec, plan, docs, or wants Codex to work with Planban state.
---

# Planban

For a plain open request (`/planban`, "open Planban", or selecting Planban from the
slash menu), behave like `/pb`: open the best matching Planban board in the Codex
in-app browser before doing anything else.

Critical open path:

1. No pre-open explanation.
2. Do not read linked docs, inspect board state, load Browser docs, or load the full
   Planban protocol before the board is visible.
3. Prefer the installed fast opener in one Node REPL `js` call:

```js
{
  const os = await import("node:os");
  const path = await import("node:path");
  const url = await import("node:url");
  const root = path.join(nodeRepl.homeDir || os.homedir(), ".codex");
  const script = path.join(root, "plugins/cache/planban/planban/1.0.0/scripts/codex-fast-open-planban.mjs");
  const mod = await import(url.pathToFileURL(script).href);
  const result = await mod.openPlanbanBoardInCodexBrowser({ cwd: "/path/to/current/repo" });
  nodeRepl.write(JSON.stringify(result));
}
```

If `node_repl` `js` is not callable, make at most one tool-discovery call for
`node_repl js execute JavaScript`. Do not call `js_reset`, `js_add_node_module_dir`,
or Browser documentation on the open path.

Fallback only if the fast opener actually fails:

1. Use Planban MCP `planban_launch_board` with the current `cwd`, then open the URL
   in the Codex in-app browser.
2. Otherwise run `node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo`
   and open the printed URL.
3. If browser automation fails, return the clickable URL.

Keep the open response short.

## Broader Planban Work

Opening a board is not a roadmap mutation.

For roadmap, card, spec, plan, docs, status, creation, review, completion, or other
Planban state work, read `references/planban-protocol.md` before changing Planban
state.

After `/planban` or `/pb` opens a board in the current thread, treat near-term
ambiguous follow-ups like "work on this", "do the next thing", "start this card", or
"continue from here" as likely Planban-related when the in-app browser is showing a
Planban board or card. Load the broader protocol then, before reading or mutating
roadmap/card state. If the target card is unclear, ask a short clarifying question.
