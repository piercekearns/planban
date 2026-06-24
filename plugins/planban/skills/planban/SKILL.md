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
3. Use Planban MCP `planban_launch_board` for the current `cwd` to start/discover
   the board URL.
4. Open the returned URL with the installed browser-only opener in one Node REPL `js`
   call, unless the Codex browser bridge itself is unavailable:

```js
{
  const os = await import("node:os");
  const fs = await import("node:fs");
  const fsp = await import("node:fs/promises");
  const path = await import("node:path");
  const url = await import("node:url");
  const root = path.join(nodeRepl.homeDir || os.homedir(), ".codex");
  const cacheRoot = path.join(root, "plugins/cache/planban/planban");
  const versions = await fsp.readdir(cacheRoot).catch(() => []);
  let script = versions
    .map((version) => path.join(cacheRoot, version, "scripts/codex-fast-open-planban.mjs"))
    .filter((candidate) => fs.existsSync(candidate))
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
  if (!script) {
    const pluginCacheRoot = path.join(root, "plugins/cache");
    const matches = [];
    async function visit(directory, depth = 0) {
      if (depth > 6 || script) return;
      const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
      await Promise.all(entries.map(async (entry) => {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) return visit(candidate, depth + 1);
        if (entry.isFile() && candidate.endsWith("/scripts/codex-fast-open-planban.mjs")) matches.push(candidate);
      }));
    }
    await visit(pluginCacheRoot);
    script = matches.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
  }
  if (!script) throw new Error(`Could not find codex-fast-open-planban.mjs under ${cacheRoot}`);
  const mod = await import(url.pathToFileURL(script).href);
  const result = await mod.openUrlInCodexBrowser({ url: "URL_FROM_PLANBAN_LAUNCH_BOARD" });
  nodeRepl.write(JSON.stringify(result));
}
```

If `node_repl` `js` is not callable, make at most one tool-discovery call for
`node_repl js execute JavaScript`. Do not call `js_reset`, `js_add_node_module_dir`,
or Browser documentation on the open path.

If the `node_repl` `js` call fails at the tool/runtime layer before JavaScript runs
(for example a missing sandbox metadata field, disabled Node REPL, permission bridge
failure, or MCP argument validation failure), treat the Codex browser bridge as
unavailable for this turn. Do not try local Node, Browser documentation, Computer Use,
Codex app UI automation, or repeated opener variations. Return the verified Planban
URL immediately and state that the board is running but the Codex browser bridge failed
before the opener code could execute.

Fallbacks:

1. If the Planban MCP tool is not callable, use
   `openPlanbanBoardInCodexBrowser({ cwd, statusTimeoutMs: 800, launchTimeoutMs: 3500 })`
   only when `node_repl` `js` is available.
2. Use the current Browser plugin/runtime when opening the returned URL; do not reuse
   a browser helper path from an older thread or older Codex app build.
3. Otherwise run `node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo`
   to resolve/start the board, then attempt the single browser opener above if
   `node_repl` is available.
4. If browser automation runs and fails after JavaScript executes, return the clickable URL.

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
