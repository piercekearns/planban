---
name: pb
description: Fast Planban opener. Use when the user invokes pb, /pb, asks to quickly open Planban, or wants the best matching Planban board visible in Codex.
---

# PB

Open the best matching Planban board in the Codex in-app browser immediately.

Critical path for a plain `/pb` request:

1. Do not explain, inspect docs, read card state, or load Browser docs first.
2. Use the fastest opener available.
3. Reply only after the in-app browser URL is verified.

Fast opener, preferred in Codex Desktop:

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

Use the current workspace path for `cwd`.

If the `node_repl` `js` tool is not callable, make at most one tool-discovery call for
`node_repl js execute JavaScript`, then run the opener. Do not call `js_reset`,
`js_add_node_module_dir`, Browser docs, or broad Planban context on the open path.

Fallback only if the fast opener actually fails:

1. Use Planban MCP `planban_launch_board` for the current `cwd`, then open its URL in the in-app browser.
2. Otherwise run `node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo` and open the printed URL.
3. If browser automation fails, return the clickable URL.

Expected URL resolution is handled by the fast opener/launcher:

- current repo board if `.planban/project.json` maps to a registered board
- exactly one board if only one exists
- otherwise `/boards`

After `/pb` opens a board, treat near-term ambiguous follow-ups like "work on this",
"do the next thing", or "start this card" as likely Planban-related. Load the broader
Planban protocol only then, before reading or mutating roadmap/card state.
