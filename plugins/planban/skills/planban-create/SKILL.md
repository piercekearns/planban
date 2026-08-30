---
name: planban-create
description: Create Planban boards or roadmap items from rough user intent. Use when the user wants to create, initialize, import, or derive Planban planning items without filling structured fields manually.
---

# Planban Create

Turn rough planning intent into Planban structure.

Before drafting any Title, Summary, Next action, Group objective, Spec, or Plan, read
`../planban/references/planban-house-style.md` completely. It is the authority for
owner-facing writing and information placement. Keep this skill focused on creation
and structure.

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

Use the Planban domain model deliberately:

- Create an **Item** for one outcome that can be prioritized, completed, and reviewed independently.
- Create a **Group** only when several Items contribute to a larger outcome and need their own internal status and priority list.
- Decide that structure before creating the Work Item: if the proposed scope already contains several independently deliverable outcomes, create the Group and its Items instead of putting a latent backlog into one Item's Spec or Plan.
- Treat Markdown checklists in Specs and Plans as execution notes or evidence, not as uncreated Work Items.
- Keep Groups on the Main Board. A Group may own Items only; it cannot own another Group.
- An Item may be standalone or owned by one Group. It never owns work or becomes a Group.
- Create a Group as a distinct Work Item with its own title, Workflow Status, and evidence. Its Group-level purpose may be supplied at creation or refined later. When grouping existing root Items, create the Group and place them inside it atomically without changing their identities or context.
- As an agent, supply a concise Group objective by default. Leave it blank only when the user explicitly requests that or the larger outcome is genuinely unresolved; never fabricate one from weak context. UI-created Groups may add or edit the objective later.
- Preserve Workflow Status during Placement changes unless the user asks otherwise, and choose the destination Group Rank explicitly.

## Useful Commands

For a simple card:

```bash
npm run planban -- create-card "Title" --summary "..." --next-action "..." --cwd /path/to/repo -o json
```

For a structured card with placement and docs:

```bash
npm run planban -- create-card "Title" --status pending --position top --tag audit --metadata-json '{"source":"notes"}' --spec-file ./spec.md --plan-file ./plan.md --cwd /path/to/repo -o json
```

For a Group around existing Items:

```bash
npm run planban -- create-group "Larger outcome" --summary "Outcome these Items achieve together" --item <first-id> --item <second-id> --cwd /path/to/repo -o json
```

For board setup:

```bash
npm run planban -- init --cwd /path/to/repo
```

When creating several items or linked docs, inspect existing board state first and use structured operations.
