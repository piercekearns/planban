---
name: planban
description: Use when the user mentions Planban, a Planban board, roadmap item, card spec, card plan, card docs, board state, or asks Codex to start, update, review, or complete work tracked in Planban.
---

# Planban

Planban is a local, Codex-native planning board. Use this skill whenever Planban is part of the task.

## Default Invocation Behavior

When the user invokes the primary Planban skill with no extra instruction, such as selecting `Planban` from the `/planban` slash menu, treat that as a request to open the best matching Planban board.

Use the same fast-open behavior as `PB`, including the same in-app browser expectations and fallbacks:

1. If the current workspace/repo has `.planban/project.json`, open that repo's Planban board.
2. Else if there is exactly one registered Planban board, open it.
3. Else open the all-boards selector.

Prefer the Planban MCP tool `planban_launch_board` when it is available, then open the returned URL in the Codex in-app browser. If the Browser plugin path from earlier thread context is stale after a Codex update, rediscover the current Browser runtime and retry. Do not stop at a clickable URL unless in-app browser automation has actually failed or Browser is unavailable.

After navigating, verify the in-app browser state before replying: the in-app browser should be visible or shown, and a tab should be open at the resolved Planban URL. If the selected/current tab is not at that URL, navigate it or open a new in-app browser tab and verify again. Do not say the board is open until the URL check succeeds.

Keep the response short. Do not merely report that Planban instructions are loaded unless the user asked for protocol/status context.

## Command-Like Skills

This plugin also includes focused command-like skills. Use or recommend them when they match the user's intent:

- `pb`: fast-open the best matching Planban board.
- `planban-help`: show Planban commands, common prompts, and a short getting-started guide.
- `planban-tutorial`: open the interactive first-run Planban tutorial.
- `planban-create`: create boards or roadmap items from rough user intent.
- `planban-feedback`: package Planban feedback.

Natural prompts remain first-class. Users can still say "Open my Planban board." or mention `@planban`.

## First Reads

When working inside a repository that uses Planban, read these before changing roadmap state:

- `.planban/project.json`
- `.planban/agent-context.md`
- Any linked card `spec.md` or `plan.md`

Opening a board is not a roadmap mutation. For a plain open request, do not spend time reading linked card docs unless needed to resolve the board.

The repo-local files are discovery files. The canonical live roadmap state for the device is listed in `.planban/agent-context.md`, usually under `~/.planban/repos/<repo-id>/roadmap.json`.

## Local Storage Model

Planban deliberately separates repo discovery from live local state:

- Repo-local discovery: `.planban/project.json` and `.planban/agent-context.md`
- Device-local roadmap: `~/.planban/repos/<repo-id>/roadmap.json`
- Device-local card docs: `~/.planban/repos/<repo-id>/items/<card-id>/spec.md` and `plan.md`

Do not create or prefer `ROADMAP.md`.

## Launching The Board

If the user asks to open or view a Planban board, opening the board in the Codex in-app browser is the expected outcome, not an optional enhancement. Use the Codex in-app browser for the board URL when that browser is available. If the Browser plugin is available, first load its current `browser:control-in-app-browser` skill/instructions and use that browser surface to navigate to the local Planban URL.

Codex updates can move the Browser plugin to a new versioned cache path. Do not rely on a stale Browser skill path from earlier thread context. If loading Browser instructions or `browser-client.mjs` fails because a path no longer exists, rediscover the current Browser plugin/skill/runtime and retry before falling back to a plain URL.

Do not use the OS URL handler, `open`, an external browser, or a clickable URL as the first response when the user specifically wants the board visible beside the Codex thread. Those are only fallbacks if the in-app browser is unavailable, browser automation has actually failed after retrying with the current Browser runtime, or the user asks for an external browser.

After navigating, verify the in-app browser state before replying:

1. Confirm the in-app browser is visible or has been shown.
2. Confirm a browser tab is open at the resolved Planban URL.
3. If the selected/current tab is not at that URL, navigate it or open a new in-app browser tab and verify again.

Do not say the board is open until the in-app browser URL check succeeds. If the URL check still fails after retrying, return the clickable URL and explain briefly that the user can open it in the Codex in-app browser.

For this local plugin bundle, the helper script can start the local app from the repo checkout:

If the Planban MCP tool `planban_launch_board` is available, prefer calling it with the current workspace `cwd`, then open the returned URL in the Codex in-app browser.

Otherwise, run the helper script:

```bash
node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo
```

The script prints the board URL. Open that URL in the in-app browser when the user wants the board visible.

For first-run or install verification, create or reuse the demo board:

```bash
node plugins/planban/scripts/launch-planban.mjs --demo
```

The demo board is safe local sample data. Use it when a user wants to see Planban working before choosing a real project. For real projects, ask the user which repo to set up and do not initialize an arbitrary current directory silently.

For first-run onboarding, create or reuse the demo board and open the tutorial:

```bash
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

Open the printed `/tutorial?mode=first-run` URL in the Codex in-app browser.

## Roadmap Status Protocol

Follow this protocol exactly:

- Opening or linking a Codex thread is not enough to change status.
- Planning, reading context, or discussing approach is not enough to change status.
- If the user asks an agent to start implementation, or you proceed to implementation work, move the card to In Progress when it is not already there.
- When agent-side implementation and verification are done, keep the card In Progress.
- At that point, update the summary and next action to say the work is ready for user review/testing.
- Move a card to Complete only when the user explicitly asks, manually confirms completion after testing/review, or clearly waives user-side verification.
- Agent-side tests are evidence for readiness to review. They are not permission to self-complete the card.

## Updating Roadmap State

When changing roadmap state:

- Serialize mutations for the same board. Do not run multiple roadmap writes in parallel.
- Preserve the existing repo-local and device-local storage boundaries.
- Update status, priority, summary, and next action so the card reflects the current phase of work.
- Update linked docs when the work changes the spec or plan.
- Create a separate plan doc only when the work is complex enough to need one.

When Planban MCP tools are available, prefer them for structured board, card, and document reads/writes. Use shell commands or direct file edits only as a fallback when the tools are unavailable or insufficient for the task.

Prefer the Planban CLI or API when available. Example CLI operations from the Planban repo:

```bash
npm run planban -- status --cwd /path/to/repo -o json
npm run planban -- get-card <card-id> --cwd /path/to/repo -o json
npm run planban -- move-card <card-id> --status in-progress --cwd /path/to/repo -o json
npm run planban -- read-doc <card-id> spec --cwd /path/to/repo -o json
npm run planban -- demo -o json
```

## Codex Thread Prompts

Planban thread prompts should include enough context to begin without rediscovery:

- repository path
- board URL
- card id
- current status
- linked spec and plan doc paths
- launch token when present
- this status protocol

Do not depend on unresolved `@Planban` mentions for local MVP prompts. Say to use the Planban plugin or skill if available.
