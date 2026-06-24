---
name: pb
description: Fast Planban opener. Use when the user invokes pb, /pb, asks to quickly open Planban, or wants the best matching Planban board visible in Codex.
---

# PB

Open the best matching Planban board in the Codex in-app browser immediately.

Critical path for a plain `/pb` request:

1. Do not explain, inspect docs, read card state, or load Browser docs first.
2. Use Planban MCP `planban_launch_board` for the current `cwd` to start/discover the board URL.
3. Use the browser-only opener below to make that URL visible in the Codex in-app browser.
4. Reply only after the in-app browser URL is verified, unless the Codex browser bridge itself is unavailable.

Browser opener, preferred in Codex Desktop after `planban_launch_board` returns a URL:

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

Use the current workspace path for `cwd`.

If the `node_repl` `js` tool is not callable, make at most one tool-discovery call for
`node_repl js execute JavaScript`, then run the browser opener. Do not call `js_reset`,
`js_add_node_module_dir`, Browser docs, or broad Planban context on the open path.

If the `node_repl` `js` call fails at the tool/runtime layer before JavaScript runs
(for example a missing sandbox metadata field, disabled Node REPL, permission bridge
failure, or MCP argument validation failure), treat the Codex browser bridge as
unavailable for this turn. Do not try local Node, Browser documentation, Computer Use,
Codex app UI automation, or repeated opener variations. Return the verified Planban
URL immediately and state that the board is running but the Codex browser bridge failed
before the opener code could execute.

Fallbacks:

1. If the Planban MCP tool is not callable but `node_repl` `js` is available, use `openPlanbanBoardInCodexBrowser({ cwd, statusTimeoutMs: 800, launchTimeoutMs: 3500 })`.
2. Use the current Browser plugin/runtime when opening any returned URL; do not reuse a browser helper path from an older thread or older Codex app build.
3. Otherwise run `node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo` to resolve/start the board, then attempt the single browser opener above if `node_repl` is available.
4. If browser automation runs and fails after JavaScript executes, return the clickable URL.

Expected URL resolution is handled by `planban_launch_board` or the bounded fallback launcher:

- current repo board if `.planban/project.json` maps to a registered board
- exactly one board if only one exists
- otherwise `/boards`

After `/pb` opens a board, treat near-term ambiguous follow-ups like "work on this",
"do the next thing", or "start this card" as likely Planban-related. Load the broader
Planban protocol only then, before reading or mutating roadmap/card state.
