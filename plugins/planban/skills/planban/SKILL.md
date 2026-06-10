---
name: planban
description: Use when the user mentions Planban, a Planban board, roadmap item, card spec, card plan, card docs, board state, or asks Codex to start, update, review, or complete work tracked in Planban.
---

# Planban

Planban is a local, Codex-native planning board. Use this skill whenever Planban is part of the task.

## First Reads

When working inside a repository that uses Planban, read these before changing roadmap state:

- `.planban/project.json`
- `.planban/agent-context.md`
- Any linked card `spec.md` or `plan.md`

The repo-local files are discovery files. The canonical live roadmap state for the device is listed in `.planban/agent-context.md`, usually under `~/.planban/repos/<repo-id>/roadmap.json`.

## Local Storage Model

Planban deliberately separates repo discovery from live local state:

- Repo-local discovery: `.planban/project.json` and `.planban/agent-context.md`
- Device-local roadmap: `~/.planban/repos/<repo-id>/roadmap.json`
- Device-local card docs: `~/.planban/repos/<repo-id>/items/<card-id>/spec.md` and `plan.md`

Do not create or prefer `ROADMAP.md`.

## Launching The Board

If the user asks to open or view a Planban board, use the Codex in-app browser for the board URL when that browser is available. If the Browser plugin is available, first load its `browser:control-in-app-browser` skill/instructions and use that browser surface to navigate to the local Planban URL.

Do not use the OS URL handler, `open`, or an external browser when the user specifically wants the board visible beside the Codex thread. Those are only fallbacks if the in-app browser is unavailable or the user asks for an external browser.

For this local plugin bundle, the helper script can start the local app from the repo checkout:

```bash
node plugins/planban/scripts/launch-planban.mjs --cwd /path/to/repo
```

The script prints the board URL. Open that URL in the in-app browser when the user wants the board visible.

For first-run or install verification, create or reuse the demo board:

```bash
node plugins/planban/scripts/launch-planban.mjs --demo
```

The demo board is safe local sample data. Use it when a user wants to see Planban working before choosing a real project. For real projects, ask the user which repo to set up and do not initialize an arbitrary current directory silently.

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
