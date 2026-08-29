---
name: pb
description: Fast Planban opener. Use when the user invokes pb, /pb, asks to quickly open Planban, or wants the best matching Planban board visible in Codex.
---

# PB

Resolve the best matching Planban board immediately and open it in the Codex in-app browser when that optional presentation capability is available.

## Non-negotiable response contract

After any successful board URL resolution, the user-facing reply **must include the exact verified URL as a clickable Markdown link**, even when automatic in-app browser opening succeeds. Never reply only that the board opened. Browser presentation is a convenience; the link is the durable handoff and must always remain available in chat.

Critical path for a plain `/pb` request:

1. Do not explain, inspect docs, read card state, or load Browser docs first.
2. Use Planban MCP `planban_launch_board` for the current `cwd` to start/discover and verify the board URL.
3. Treat `serviceReady: true` and `urlVerified: true` as a successful launch. Preserve its URL before browser work.
4. Use the browser-only opener below once to make that URL visible in the Codex in-app browser.
5. Reply with the preserved clickable verified URL whether browser presentation succeeds or fails. If browser setup, visibility, tab creation, navigation, or verification is unavailable or fails, stop browser work and add at most one short degradation reason. The board remains successfully launched.

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
  const result = await mod.openUrlInCodexBrowser({
    url: "VERIFIED_URL_FROM_PLANBAN_LAUNCH_BOARD",
    urlVerified: true,
    serviceReady: true
  });
  nodeRepl.write(JSON.stringify(result));
}
```

The opener is an optional presentation adapter. It returns `browserOpened: false`, the
verified `url`, and a structured `diagnostics` entry when browser presentation
degrades; do not turn that into a Planban launch failure.

Use the current workspace path for `cwd`.

If the `node_repl` `js` tool is not callable, make at most one tool-discovery call for
`node_repl js execute JavaScript`, then run the browser opener. Do not call `js_reset`,
`js_add_node_module_dir`, Browser docs, or broad Planban context on the open path.

If the `node_repl` `js` call fails at the tool/runtime layer before JavaScript runs
(for example a missing sandbox metadata field, disabled Node REPL, permission bridge
failure, or MCP argument validation failure), treat the Codex browser bridge as
unavailable for this turn. Do not try local Node, Browser documentation, Computer Use,
Codex app UI automation, or repeated opener variations. Return the verified Planban
URL immediately and state that the board is running but automatic in-app opening is
unavailable.

Fallbacks:

1. If the Planban MCP tool is not callable but `node_repl` `js` is available, use `openPlanbanBoardInCodexBrowser({ cwd, statusTimeoutMs: 800, launchTimeoutMs: 3500 })`.
2. Use the current Browser plugin/runtime when opening any returned URL; do not reuse a browser helper path from an older thread or older Codex app build.
3. Otherwise run `node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo` to resolve/start the board, then attempt the single browser opener above if `node_repl` is available.
4. Always return the clickable verified URL; use `browserOpened` only to choose the short success or degradation wording.

Expected URL resolution is handled by `planban_launch_board` or the bounded fallback launcher:

- current repo board if `.planban/project.json` maps to a registered board
- exactly one board if only one exists
- otherwise `/boards`

After `/pb` opens a board, treat near-term ambiguous follow-ups like "work on this",
"do the next thing", or "start this card" as likely Planban-related. Load the broader
Planban protocol only then, before reading or mutating roadmap/card state.

## Response

Every successful response includes the exact verified URL:

- Browser opened: `Planban is open: [Open the verified board](URL)`
- Browser unavailable or failed: `Planban is running: [Open the verified board](URL)` plus, at most, one short browser-degradation reason from the structured diagnostics.

Do not replace either response with an unlinked statement such as “Planban is open” or “Board opened.”
