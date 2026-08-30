# Planban Protocol

Planban is a local, Codex-native planning board. Use this protocol when the user asks
Codex to read, create, update, review, move, or complete work tracked in Planban.

## Command-Like Skills

This plugin includes focused command-like skills:

- `pb`: fast-open the best matching Planban board.
- `planban`: full-name entry point; by default it opens the same board target as `pb`.
- `planban-help`: show Planban commands, common prompts, and a short getting-started guide.
- `planban-tutorial`: open the interactive first-run Planban tutorial.
- `planban-create`: create boards or roadmap items from rough user intent.
- `planban-feedback`: package Planban feedback.

Natural prompts remain first-class. Users can still say "Open my Planban board." or
mention `@planban`.

## First Reads

When working inside a repository that uses Planban, read these before changing
roadmap state:

- `.planban/project.json`
- `.planban/agent-context.md`
- Any linked card `spec.md` or `plan.md` relevant to the requested work

The repo-local files are discovery files. The canonical live roadmap state for the
device is listed in `.planban/agent-context.md`, usually under
`~/.planban/repos/<repo-id>/roadmap.json`.

## Owner-Facing Authoring

Before creating or materially editing a Title, Summary, Next action, Group objective,
Spec, or Plan, read `planban-house-style.md` completely and follow it. That reference
is the authority for lifecycle language, information placement, current-state
orientation, and lossless agent detail. Do not copy its full rules into prompts or
tool descriptions.

A status-only, priority-only, placement-only, or rank-only mutation does not require
the house-style reference unless the same change also edits owner-facing content.
Never rewrite historical evidence merely to make older content match the current
style.

## Local Storage Model

Planban deliberately separates repo discovery from live local state:

- Repo-local discovery: `.planban/project.json` and `.planban/agent-context.md`
- Device-local roadmap: `~/.planban/repos/<repo-id>/roadmap.json`
- Device-local card docs: `~/.planban/repos/<repo-id>/items/<card-id>/spec.md` and `plan.md`

Do not create or prefer `ROADMAP.md`.

## Work Item Model

Use these terms consistently:

- **Item**: one independently trackable outcome. It may stand alone on the Main Board or be owned by one Group.
- **Group**: a root Work Item that groups Items. It has its own title, summary, evidence, Workflow Status, and Board Rank, while its Items have their own statuses and Group Ranks.
- **Placement**: whether an Item is on the Main Board or owned by a Group. Placement is independent of Workflow Status.
- **Rollup**: derived progress across a Group's direct Items. It does not set the Group's own Workflow Status.

The hierarchy is exactly one level: `Group → Item`. Groups cannot own
Groups, and Items never own Work Items or become Groups. A Group is
a distinct root Work Item with its own purpose and evidence. Its purpose may be supplied
at creation or refined later. Grouping two root Items collects a title and optional Group-level purpose, creates the Group, and places both Items inside it atomically;
their identities, context, Workflow Statuses, and history remain unchanged. Empty
Groups may also be created deliberately.

Create an Item for a concrete outcome that can be prioritized, completed, and
reviewed independently. Create a Group when several Items contribute to one
larger outcome and need their own internal priority/status list. Do not create a
Group merely to represent a label, category, or speculative future hierarchy.
Make this decision before creating the Work Item. If the proposed scope already
contains several independently deliverable outcomes, create the Group and its
Items rather than storing a latent backlog in one Item's Spec or Plan. Markdown
checklists in documents remain execution notes or evidence, not uncreated Work
Items.

When moving an Item into a Group, preserve its Workflow Status unless the
owner asks to change it and choose an explicit Group Rank in that status. Moving it
between Groups removes the old ownership and assigns the new Group Rank in one
mutation. Moving it to the Main Board removes ownership and assigns Board Rank. A
Group's Workflow Status remains explicit; its Rollup is supporting evidence, not an
automatic status transition.

## Board Opening

Opening a board is the same primary service for `/pb` and `/planban`:

1. If the current workspace/repo has `.planban/project.json`, open that repo's board.
2. Else if there is exactly one registered Planban board, open it.
3. Else open the all-boards selector.

Every successful board-open confirmation must include the exact verified board URL as a clickable Markdown link, regardless of whether in-app browser presentation succeeds. A bare “board opened” acknowledgement is never sufficient. The verified link is part of the durable response contract, while browser presentation is optional.

In Codex Desktop, use the Planban MCP tool as the authority for server lifecycle,
service health, canonical board URL resolution, and URL verification. Use the Planban
browser opener module only as a bounded optional adapter for in-app browser visibility,
fresh-tab navigation, and presentation verification. The Node REPL runtime can be
sandboxed away from localhost networking, so browser availability must never redefine
whether the board launched successfully.

```js
const mod = await import("/absolute/path/to/codex-fast-open-planban.mjs");
const result = await mod.openUrlInCodexBrowser({
  url: "VERIFIED_URL_FROM_PLANBAN_LAUNCH_BOARD",
  urlVerified: true,
  serviceReady: true
});
nodeRepl.write(JSON.stringify(result));
```

Resolve the module path from the active Planban plugin root, preferably by scanning
`$CODEX_HOME/plugins/cache/planban/planban/*/scripts/codex-fast-open-planban.mjs`
and selecting the newest version. In source checkouts, use
`plugins/planban/scripts/codex-fast-open-planban.mjs`. Do not call
`browser.documentation()` before this fast
opener. Large Browser documentation payloads belong on the fallback/warm-up path, not
on the critical path for making the board visible.

Only the Node REPL `js` execution tool can run this browser opener. If Node REPL is not
callable yet, make at most one tool-discovery attempt for `node_repl js execute
JavaScript`. Do not call `js_reset`, `js_add_node_module_dir`, or any reset/setup-only
Node REPL tool for a plain open-board command. If `js` is still not callable after
that one discovery attempt, skip the Node REPL path and use the fallback route
immediately.

If the `node_repl` `js` call fails at the tool/runtime layer before JavaScript runs
(for example a missing sandbox metadata field, disabled Node REPL, permission bridge
failure, or MCP argument validation failure), classify this as "Codex browser bridge
unavailable". Do not spend more time on local Node invocations, Browser documentation,
Computer Use, Codex app UI automation, or repeated opener variations. Keep the board
launch result, return the clickable verified URL, and say that the board is running
but automatic in-app opening is unavailable.

Use `planban_launch_board` when it is available, then open the returned URL in the
Codex in-app browser through the current official Browser plugin/runtime. Do not
reuse a browser helper path copied from an older thread or older Codex app build.
If the Planban MCP tool is unavailable and Node REPL `js` is available, use
`openPlanbanBoardInCodexBrowser({ cwd, statusTimeoutMs: 800, launchTimeoutMs: 3500 })`
as a bounded fallback. Otherwise, run:

```bash
node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo
```

Do not use the OS URL handler, `open`, or an external browser as the first presentation
attempt when the user specifically wants the board visible beside the Codex thread.
The clickable verified URL is not merely a fallback: include it in the final reply
after every successful resolution, including when the in-app browser opened correctly.

Default board opening should optimize for the cold-start return-to-work case. The
Planban server may be stopped, the in-app browser may be closed, or the selected tab
may be stale, unrelated, or on an error page. Use an open-first flow: resolve the
board, make the in-app browser visible, open a fresh in-app browser tab by default,
verify the URL, and tell the user the board is open with the exact clickable verified URL. Only reuse the selected tab
when it is already exactly at the resolved Planban URL. After the board is visible,
continue with a lightweight ready-next warm-up for likely follow-up work: load broader
Planban context, linked docs, or Browser context then when useful. Do not put that
work on the critical path. Always return the verified URL. If browser presentation fails,
also include at most one useful reason from the adapter's structured `browser-presentation`
diagnostic; service/URL failures remain separate `service-url` failures.

For first-run or install verification, create or reuse the demo board:

```bash
node plugins/planban/scripts/launch-planban.mjs --demo
```

For first-run onboarding, create or reuse the demo board and open the tutorial:

```bash
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

## Roadmap Status Protocol

Follow this protocol exactly:

- Opening or linking a Codex thread is not enough to change status.
- Planning, reading context, or discussing approach is not enough to change status.
- If the user asks an agent to start implementation, or you proceed to implementation
  work, move the card to In Progress when it is not already there.
- When agent-side implementation and verification are done, keep the card In Progress.
- At that point, update the summary and next action to say the work is ready for user
  review/testing.
- Move a card to Complete only when the user explicitly asks, manually confirms
  completion after testing/review, or clearly waives user-side verification.
- Agent-side tests are evidence for readiness to review. They are not permission to
  self-complete the card.

## Updating Roadmap State

When changing roadmap state:

- Serialize mutations for the same board. Do not run multiple roadmap writes in
  parallel.
- Preserve the existing repo-local and device-local storage boundaries.
- Update status, priority, summary, and next action so the card reflects the current
  phase of work.
- Update linked docs when the work changes the spec or plan.
- Create a separate plan doc only when the work is complex enough to need one.

### Post-mutation handoff

After a successful user-requested Planban creation or material mutation, wait until
the complete logical mutation sequence has finished, then resolve the verified Board
URL once. In Codex Desktop, make one bounded attempt to open or focus that URL
through the supported Planban browser adapter. Always include the exact verified URL
as a clickable Markdown link in the final response.

- Do not reopen the Board after every storage write in a multi-step mutation. One
  presentation attempt belongs to the logical mutation batch.
- An explicitly headless or background operation may skip browser presentation, but
  it should still return the verified clickable URL when URL resolution succeeds.
- Browser-presentation failure does not invalidate a successful mutation. Preserve
  the mutation result and return the verified link with at most one short degradation
  reason.
- Prefer a stable changed-Item URL when Planban supports one. Otherwise use the
  verified Board URL.

When Planban MCP tools are available, prefer them for structured board, card, and
document reads/writes. Use shell commands or direct file edits only as a fallback when
the tools are unavailable or insufficient for the task.

Prefer the Planban CLI or API when available. Example CLI operations from the Planban
repo:

When an agent creates a Group, provide a concise Group objective by default. Omit it
only when the owner explicitly asks for no objective or when the larger outcome is
genuinely unresolved; do not invent a specific objective from weak context. The UI
may leave the objective blank and add or edit it later.

```bash
npm run planban -- status --cwd /path/to/repo -o json
npm run planban -- get-card <card-id> --cwd /path/to/repo -o json
npm run planban -- move-card <card-id> --status in-progress --cwd /path/to/repo -o json
npm run planban -- create-group "Larger outcome" --summary "Outcome these Items achieve together" --item <card-id> --item <card-id> --cwd /path/to/repo -o json
npm run planban -- update-card <group-id> --summary "Refined Group objective" --cwd /path/to/repo -o json
npm run planban -- set-card-parent <card-id> --parent <group-id> --cwd /path/to/repo -o json
npm run planban -- set-card-parent <card-id> --board --cwd /path/to/repo -o json
npm run planban -- read-doc <card-id> spec --cwd /path/to/repo -o json
npm run planban -- demo -o json
```

## Codex Thread Prompts

Planban thread prompts should include enough context to begin without rediscovery:

- repository path
- board URL
- card id
- current status
- Group ancestry from root to direct parent, when present
- linked spec and plan doc paths
- launch token when present
- this status protocol

Do not depend on unresolved `@Planban` mentions for local MVP prompts. Say to use the
Planban plugin or skill if available.
