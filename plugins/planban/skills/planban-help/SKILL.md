---
name: planban-help
description: Show Planban commands, common prompts, and a short getting-started guide.
---

# Planban Help

Return a succinct Planban help guide for end users.

## Response Shape

Keep the answer brief and practical. Lead with the commands for the user's host. When
the host is known, show only its column.

| Action | Codex | Claude Code |
| --- | --- | --- |
| Open the best matching board | `/PB` or `/Planban` | `/planban:pb` or `/planban:planban` |
| Show this help | `/Planban Help` | `/planban:planban-help` |
| Open the interactive first-run tutorial | `/Planban Tutorial` | `/planban:planban-tutorial` |
| Create boards or roadmap items from rough notes | `/Planban Create` | `/planban:planban-create` |
| Send Planban feedback | `/Planban Feedback` | `/planban:planban-feedback` |

- In Codex, type `/planban`, then choose one of the Planban actions from the `/` menu. `@planban Open my Planban board` also works as a plugin mention.
- In Claude Code, type `/planban:` to list the Planban actions.
- In any host, natural prompts work when they name Planban clearly.
- Planban is installed separately in each host. Point users to https://github.com/piercekearns/planban#install for per-host install steps.

Do not lead with `$planban:*` unless the user specifically asks about `$` skill mentions.

Then include this short framing before the getting-started steps:

Planban is a local, agent-native Kanban planning board for keeping human and agent planning in sync. Use each board as a project second brain: plans, ideas, rough notes, future features, priorities, and what to work on next. You can shape the roadmap in the board, your agent can read and update it while working, and both sides stay aligned around the same cards, specs, status, and next actions.

Then include a short getting-started guide:

1. Open Planban with your host's open command from the table above, or `Open my Planban board.`
2. If you do not have a board yet, ask your agent to set up Planban for your local project.
3. If you already track plans in repo docs, issues, Notion, Linear, Jira, or plain notes, paste or point your agent at that context and ask it to create Planban roadmap items from it.
4. Use the board to store and scan plans, ideas, roadmap cards, priorities, specs, and next actions.
5. Move cards between columns as your work changes, and click a card to view its details, spec, plan, and current next action.
6. Start work from a card when you want your agent to pick up the full planning context.
7. In a new thread or session, reopen Planban with the same open command or `Open my Planban board.`

Then give this vocabulary when the user asks how to structure work:

- An **Item** is one independently trackable outcome. It can live on the Main Board or inside one Group.
- A **Group** is a Main Board card that groups Items and gives them an internal status and priority list.
- Groups do not nest, and Items do not turn into Groups. Grouping Items creates a distinct Group while keeping every Item intact.
- Moving an Item changes where it is planned; changing status changes its workflow stage. These are separate choices.

For a guided product tour, run the tutorial command from the table above. It opens the local tutorial in the host's in-app browser when the host supports one, and always returns the tutorial link.

Then list common actions:

- open the current Planban project board
- open the interactive Planban tutorial
- show/select Planban boards
- summarize this project's Planban roadmap state
- start work from a named Planban roadmap item or card id
- create Planban roadmap items from these notes
- send Planban feedback
- check whether Planban has updates
- archive/delete boards once available

## Suggested Natural Prompts

Use specific Planban wording so the agent does not have to guess:

- `Open my Planban board.`
- `Show all my Planban boards.`
- `Summarize this project's Planban roadmap state.`
- `Start work on the Planban roadmap item called <title or id>.`
- `Create Planban roadmap items from these notes: <notes>.`
- `Send Planban feedback: <feedback>.`
- `Check whether Planban has updates.`

For update checks, inspect Planban's local update status endpoint or the board's update UI when available, and compare the installed version with the published latest metadata.
