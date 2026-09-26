---
name: pb
description: Fast Planban opener. Use when the user invokes pb, /pb, asks to quickly open Planban, or wants the best matching Planban board visible in the host's in-app browser.
---

# PB

Resolve the best matching Planban board immediately, show it in the host's in-app browser when the host adapter below supports that, and return the verified link.

## Non-negotiable response contract

After any successful board URL resolution, the user-facing reply **must include the exact verified URL as a clickable Markdown link**, even when automatic in-app browser opening succeeds. Never reply only that the board opened. Browser presentation is a convenience; the link is the durable handoff and must always remain available in chat.

Critical path for a plain `/pb` request:

1. Do not explain, inspect docs, read card state, or load Browser docs first.
2. Call the Planban MCP tool whose name ends in `planban_launch_board` for the current `cwd` to start/discover and verify the board URL. Treat `serviceReady: true` and `urlVerified: true` as a successful launch. Preserve its URL (also carried in `userReply.markdown`) before browser work.
3. Make one bounded in-app presentation attempt through the adapter for this host under **Host adapters**. Hosts without an adapter skip this step.
4. Reply with the preserved clickable verified URL whether browser presentation succeeds, fails, or is skipped. If browser setup, visibility, tab creation, navigation, or verification is unavailable or fails, stop browser work and add at most one short degradation reason. The board remains successfully launched.

Use the current workspace path for `cwd`.

If no `planban_launch_board` tool is callable, use the host adapter's fallbacks. A host without fallbacks runs `node <plugin-root>/scripts/launch-planban.mjs --cwd /path/to/repo`, where `<plugin-root>` is two directories above this skill's folder, and uses the URL it prints.

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
- Browser unavailable, failed, or not attempted: `Planban is running: [Open the verified board](URL)` plus, at most, one short browser-degradation reason from the structured diagnostics.

Do not replace either response with an unlinked statement such as “Planban is open” or “Board opened.”

## Host adapters

Use only the subsection for the host you are running in. Each adapter makes at most one presentation attempt and never turns a presentation failure into a launch failure.

### Codex desktop

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

### Claude Code desktop

Open the verified URL in the built-in browser pane with the pane's navigate tool (currently `mcp__Claude_Browser__navigate` with `{ "url": "<verified URL>" }`). Tool names can change between app versions, so match on that capability.

- Make one attempt. If the tool is listed as deferred, load it with a single tool-search call first; search no further.
- If no such tool is in the session, or the call errors, skip presentation and return the link with one short reason.
- Keep the attempt inside the pane: the OS `open` command and external browsers are not first attempts, and Computer Use is out of scope.

### Other hosts

Make no presentation attempt. Return the link.
