---
name: planban-create
description: Create Planban boards or roadmap items from rough user intent. Use when the user wants to create, initialize, import, or derive Planban planning items without filling structured fields manually.
---

# Planban Create

Turn rough planning intent into Planban structure.

## Intent Routing

Infer whether the user wants:

- a new Planban board or project setup
- one new roadmap item/card on an existing board
- multiple roadmap items derived from pasted docs, issues, notes, Notion/Linear/Jira exports, or repo planning text

If the target board or intent is ambiguous, ask one short clarifying question or open/show the all-boards selector.

## Agent-Native Creation

Do not force the user to supply Planban internals. The agent should structure:

- title
- status
- summary
- next action
- spec detail
- plan detail when useful

Prefer Planban MCP tools, CLI commands, or API routes over raw file edits. Preserve Planban's review/testing protocol:

- Move a card to In Progress only when implementation starts.
- Leave agent-completed work In Progress with review/testing next action.
- Move to Complete only when the user explicitly confirms or waives review.

## Useful Commands

For a simple card:

```bash
npm run planban -- create-card "Title" --summary "..." --next-action "..." --cwd /path/to/repo -o json
```

For a structured card with placement and docs:

```bash
npm run planban -- create-card "Title" --status pending --position top --tag audit --metadata-json '{"source":"notes"}' --spec-file ./spec.md --plan-file ./plan.md --cwd /path/to/repo -o json
```

For board setup:

```bash
npm run planban -- init --cwd /path/to/repo
```

When creating several items or linked docs, inspect existing board state first and use structured operations.
