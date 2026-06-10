---
name: planban-help
description: Show Planban commands, common prompts, and a short getting-started guide.
---

# Planban Help

Return a succinct Planban help guide for end users.

## Response Shape

Keep the answer brief and practical. Lead with what users actually see in Codex:

- In Codex, type `/planban`, then choose one of the Planban actions from the `/` menu.
- `/PB` or `/Planban`: open the best matching Planban board.
- `/Planban Help`: show this help guide.
- `/Planban Tutorial`: open the interactive first-run tutorial.
- `/Planban Create`: create boards or roadmap items from rough notes.
- `/Planban Feedback`: send Planban feedback.
- `@planban Open my Planban board` also works as a plugin mention.
- Natural prompts work too when they name Planban clearly.

Do not lead with `$planban:*` unless the user specifically asks about `$` skill mentions.

Then include this short framing before the getting-started steps:

Planban is a local Codex-native Kanban planning board for keeping human and agent planning in sync. Use each board as a project second brain: plans, ideas, rough notes, future features, priorities, and what to work on next. You can shape the roadmap in the board, Codex can read and update it while working, and both sides stay aligned around the same cards, specs, status, and next actions.

Then include a short getting-started guide:

1. Open Planban with `/PB`, `/Planban`, or `Open my Planban board.`
2. If you do not have a board yet, ask Codex to set up Planban for your local project.
3. If you already track plans in repo docs, issues, Notion, Linear, Jira, or plain notes, paste or point Codex at that context and ask it to create Planban roadmap items from it.
4. Use the board to store and scan plans, ideas, roadmap cards, priorities, specs, and next actions.
5. Move cards between columns as your work changes, and click a card to view its details, spec, plan, and current next action.
6. Start work from a card when you want Codex to pick up the full planning context.
7. In a new thread, reopen Planban with `/PB`, `/Planban`, or `Open my Planban board.`

For a guided product tour, choose `/Planban Tutorial` from the slash menu. It opens the local tutorial in the Codex in-app browser.

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

Use specific Planban wording so Codex does not have to guess:

- `Open my Planban board.`
- `Show all my Planban boards.`
- `Summarize this project's Planban roadmap state.`
- `Start work on the Planban roadmap item called <title or id>.`
- `Create Planban roadmap items from these notes: <notes>.`
- `Send Planban feedback: <feedback>.`
- `Check whether Planban has updates.`

For update checks, inspect Planban's local update status endpoint or the board's update UI when available, and compare the installed version with the published latest metadata.
