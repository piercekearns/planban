# Planban Protocol

Planban is a local, agent-native planning board. Use this protocol when the user asks
the agent to read, create, update, review, move, or complete work tracked in Planban.

## Command-Like Skills

This plugin includes focused command-like skills:

- `pb`: fast-open the best matching Planban board.
- `planban`: full-name entry point; by default it opens the same board target as `pb`.
- `planban-help`: show Planban commands, common prompts, and a short getting-started guide.
- `planban-tutorial`: open the interactive first-run Planban tutorial.
- `planban-create`: create boards or roadmap items from rough user intent.
- `planban-feedback`: package Planban feedback.

Codex invokes these as `/pb`, `/planban`, and so on. Claude Code prefixes the plugin
name: `/planban:pb`, `/planban:planban`, and so on.

Natural prompts remain first-class. Users can still say "Open my Planban board." or
mention `@planban` where the host supports plugin mentions.

## First Reads

When working inside a repository that uses Planban, read these before changing
roadmap state:

- `.planban/project.json`
- `.planban/agent-context.md`
- Any linked card `spec.md` or `plan.md` relevant to the requested work

The repo-local files are discovery files. The canonical live roadmap state for the
device is listed in `.planban/agent-context.md`, usually under
`~/.planban/repos/<repo-id>/roadmap.json`.

If `.planban/agent-context.md` says the board is online (or `.planban/online-board.json`
exists), the board lives at its online service, not in files on this machine. Read
and write it only through the Planban MCP tools or the CLI; local roadmap and Spec
files for an online board are a cache or backup, never the board.

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

## Product Constitution

Before creating or materially reshaping a Planban product feature, domain model,
workflow semantic, visible information hierarchy, platform or cloud behavior,
roadmap structure, onboarding, positioning, or agent guidance, read the repository
root `PRODUCT.md` completely. It is the public authority for Planban's product
definition, principles, boundaries, and feature-decision test.

Do not reload `PRODUCT.md` for routine Board operations, small current-state
corrections, or execution of an already accepted Plan. The constitution governs
product decisions; it must not become ceremony for ordinary use.

## Local Storage Model

Planban deliberately separates repo discovery from live local state:

- Repo-local discovery: `.planban/project.json` and `.planban/agent-context.md`
- Device-local roadmap: `~/.planban/repos/<repo-id>/roadmap.json`
- Device-local card docs: `~/.planban/repos/<repo-id>/items/<card-id>/spec.md` and `plan.md`

These paths hold local boards only. An online board's state lives at its service.

Do not create or prefer `ROADMAP.md`.

## Planban is an index, not storage

A Board holds only its own text: each card's fields, its Spec and Plan, and their
history. It never holds files. Everything else is a reference to where it lives.

- Never save a file into a card's folder under `~/.planban/repos/<repo-id>/items/`.
  Only Planban writes there, and only `spec.md` and `plan.md`.
- Keep evidence, screenshots, exports, logs and long reports where they belong: the
  project's repository, a shared drive, or a website. A file the owner should keep
  that has no home yet goes in the repository, for example under `docs/`, with the
  owner's agreement.
- Refer to a file from the card's Spec or Plan in one of three forms:
  - a GitHub link, such as `https://github.com/<owner>/<repo>/blob/main/docs/evidence/run.png`;
  - any other web address;
  - a local path labelled with its machine, such as `Mac mini: ~/Projects/app/renders/front.png`.
    The label matters: another machine, or a hosted board, cannot follow an unlabelled
    path.
- Do not paste a file into the text. Planban refuses writes that embed a file
  (`data:` addresses with a payload, long base64, binary content, or long lists of
  numbers standing in for bytes), Specs and Plans over 1 MB, and cards over 128 KB.
  The error says what was found and how to refer to it instead.

A card whose folder already holds files is flagged: tool results and the
session-start line name it, and the board shows a quiet "Holds files" note on it.
Planban refuses every change to that card until the files are moved out; reading it
still works. To tidy it, ask the owner where the files belong, then run
`planban_move_files_out` (or `planban move-files-out <card> --to <folder>`) with a
dry run first. It moves the files to that folder without overwriting or deleting
anything, and adds a Files section to the card's Spec that refers to each one where
it now lives.

### Online authority

Planban is free on a computer with no account. A board goes online only when its
owner chooses, with a free Planban account at https://app.planban.ai.

- **When to suggest it.** Suggest taking a board online only when the person wants
  to share it with someone, use it from another computer or a phone, or reach it
  from ChatGPT or claude.ai. Explain what changes, and let them decide; never take a
  board online, take it local, invite people, change roles or agent levels, revoke
  connections or create keys unless the person explicitly asks.
- **Taking it online.** Board settings, Take online, or
  `planban online login https://app.planban.ai` once per computer, then
  `planban online take-online https://app.planban.ai --cwd <project>`. The service
  address is required. On a remote machine, add `--no-browser` to `login` and give the
  person the printed link. A board goes online only when it is clean: Planban lists
  files and pictures to tidy before the transfer.
- **The project note.** Taking a board online leaves `.planban/online-board.json` in
  the project folder, for the owner to commit. On any machine where that note exists,
  the local copy becomes read-only: Planban refuses changes and says where the board
  lives. Do not retry or work around it; ask the owner to sign in and choose "Use the
  online board", or to keep the copy as a separate board.
- **Roles and agent levels.** Each person is an owner, editor or viewer, and chooses
  what their own agents may do: read, plan, or plan and complete. An agent never does
  more than its person. A "forbidden" refusal means this agent's level doesn't allow
  the action: tell the person; they can change it in People or with
  `planban online my-agents <level>`.
- **Edits.** Every edit on an online board passes the roadmap revision you last read
  (`baseRevision`, or `--base-revision`), and every Spec or Plan write passes the
  `mtimeMs` from reading it (`expectedMtimeMs`, or `--expected-mtime`). On a conflict,
  read again and retry. Serialize writes.
- **Limits.** A board holds up to 256 MB with its history, and each account can make
  up to 5,000 changes a day. Planban stays an index, not storage.
- **Signed out.** If Planban says this computer's sign-in is missing or has ended,
  ask the person to sign in again (the board page offers Sign in, or the printed
  `online login` command). Do not use local files instead.

The `planban` command: Planban's messages print the exact command for this computer.
If `planban` isn't installed as a command, it is
`node "<Planban install folder>/bin/planban.mjs"`.

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

The Planban MCP tool whose name ends in `planban_launch_board` is the authority for
server lifecycle, service health, canonical board URL resolution, and URL
verification. Host browser presentation is a bounded optional step; it must never
redefine whether the board launched successfully.

Critical path:

1. Call `planban_launch_board` for the current `cwd`. A result with
   `serviceReady: true` and `urlVerified: true` is the successful launch; preserve
   its URL (also carried in `userReply.markdown`).
2. Make one bounded in-app presentation attempt through the adapter for this host
   under **Host adapters**. Hosts without an adapter skip this step.
3. Reply with the exact clickable verified URL whether or not presentation
   succeeded: `Planban is open: [Open the verified board](URL)` after a successful
   presentation, otherwise `Planban is running: [Open the verified board](URL)` plus
   at most one short degradation reason.

If `planban_launch_board` is not callable, use the host adapter's fallbacks. A host
without fallbacks runs the bundled launcher and uses the URL it prints:

```bash
node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo
```

Default board opening should optimize for the cold-start return-to-work case. The
Planban server may be stopped, the in-app browser may be closed, or the selected tab
may be stale, unrelated, or on an error page. Use an open-first flow: resolve the
board, present it once, and tell the user the board is open with the exact clickable
verified URL. After the board is visible, continue with a lightweight ready-next
warm-up for likely follow-up work: load broader Planban context, linked docs, or
Browser context then when useful. Do not put that work on the critical path. Always
return the verified URL. If browser presentation fails, also include at most one
useful reason from the adapter's structured `browser-presentation` diagnostic;
service/URL failures remain separate `service-url` failures.

For first-run or install verification, create or reuse the demo board:

```bash
node plugins/planban/scripts/launch-planban.mjs --demo
```

For first-run onboarding, create or reuse the demo board and open the tutorial:

```bash
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

## Host adapters

Use only the subsection for the host you are running in. Each adapter makes at most
one presentation attempt per board open or logical mutation batch.

### Codex desktop

Use the Planban browser opener module only as a bounded optional adapter for in-app
browser visibility, fresh-tab navigation, and presentation verification. The Node
REPL runtime can be sandboxed away from localhost networking, so browser
availability must never redefine whether the board launched successfully.

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

Make the in-app browser visible and open a fresh in-app browser tab by default, then
verify the URL. Only reuse the selected tab when it is already exactly at the
resolved Planban URL.

### Claude Code desktop

Open the verified URL in the built-in browser pane with the pane's navigate tool
(currently `mcp__Claude_Browser__navigate` with `{ "url": "<verified URL>" }`). Tool
names can change between app versions, so match on that capability.

- Make one attempt. If the tool is listed as deferred, load it with a single
  tool-search call first; search no further.
- If no such tool is in the session, or the call errors, skip presentation and return
  the link with one short reason.
- Keep the attempt inside the pane: the OS `open` command and external browsers are
  not first attempts, and Computer Use is out of scope.

### Other hosts

Make no presentation attempt. Return the link.

## Roadmap Status Protocol

Follow this protocol exactly:

- Opening or linking an agent thread or session is not enough to change status.
- Planning, reading context, or discussing approach is not enough to change status.
- If the user asks an agent to start implementation, or you proceed to implementation
  work, move the card to In Progress when it is not already there.
- When agent-side implementation and verification are done, keep the card In Progress.
- At that point, update the summary and next action to say the work is ready for user
  review/testing.
- Move a card to Complete only when the user (on a shared board, a person on the
  board) explicitly asks, manually confirms completion after testing/review, or
  clearly waives user-side verification.
- Agent-side tests are evidence for readiness to review. They are not permission to
  self-complete the card.
- A landing is a card event: whoever merges a PR, pushes to a release branch or
  retires a branch updates every In Progress Item that names it, before reporting the
  landing.

## Updating Roadmap State

When changing roadmap state:

- Serialize mutations for the same board. Do not run multiple roadmap writes in
  parallel.
- Preserve the existing repo-local and device-local storage boundaries.
- Update status, priority, summary, and next action so the card reflects the current
  phase of work.
- Update linked docs when the work changes the spec or plan.
- Create a separate plan doc only when the work is complex enough to need one.
- If a tool result shows stale signals for a card you own or touch, re-read it and fix
  it in the same mutation batch.

### Post-mutation handoff

After a successful user-requested Planban creation or material mutation, wait until
the complete logical mutation sequence has finished, then resolve the verified Board
URL once: take it from the last mutation result's `userReply`, and call
`planban_launch_board` once only if that result has `boardUrlVerified: false`. Make
one bounded attempt to open or focus that URL through the adapter for this host under
**Host adapters**. Always include the exact verified URL as a clickable Markdown link
in the final response.

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
repo (elsewhere, replace `npm run planban --` with the `planban` command described
under Online authority):

When an agent creates a Group, provide a concise Group objective by default. Omit it
only when the owner explicitly asks for no objective or when the larger outcome is
genuinely unresolved; do not invent a specific objective from weak context. The UI
may leave the objective blank and add or edit it later.

On an online board, add `--base-revision <revision>` to each edit (the `revision`
from `get-card` or `query-cards`) and `--expected-mtime <mtimeMs>` to `write-doc`
(the `mtimeMs` from `read-doc`).

```bash
npm run planban -- status --cwd /path/to/repo -o json
npm run planban -- get-card <card-id> --cwd /path/to/repo -o json
npm run planban -- move-card <card-id> --status in-progress --cwd /path/to/repo -o json
npm run planban -- create-group "Larger outcome" --summary "Outcome these Items achieve together" --item <card-id> --item <card-id> --cwd /path/to/repo -o json
npm run planban -- update-card <group-id> --summary "Refined Group objective" --cwd /path/to/repo -o json
npm run planban -- move-card <card-id> --parent <group-id> --cwd /path/to/repo -o json
npm run planban -- move-card <card-id> --board --cwd /path/to/repo -o json
npm run planban -- read-doc <card-id> spec --cwd /path/to/repo -o json
npm run planban -- demo -o json
```

## Planban references

Copy Reference in the Board puts one line on the clipboard: `“<title>” · planban:<board>/<item>`. The `planban:` token is the identity; the quoted title is display context.

Reading a reference:

- `planban:<board>/<item>` names an Item or Group: `<board>` is the registered repo id and `<item>` is the card id. Resolve it with `planban_get_card` using `repoId` and `cardId`, or through the CLI `get-card`.
- `planban:<board>` names a Board. Resolve it with `planban_status` or `planban_get_board` using `repoId`.
- Trust the id over the title. If the resolved card's title differs from the quoted title, proceed with the id and mention the mismatch.

Writing a reference: when citing or handing off an Item in a reply, prompt, or document, use the same one-line form. Do not invent longer labelled formats or absolute paths.

## Agent handoff prompts

Planban handoff prompts for a new agent thread or session should include enough
context to begin without rediscovery:

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
