# Planban

Planban is a local, Codex-native Kanban-style planning board for agent-led software work.

It gives you a simple roadmap board, keeps your planning state local, and helps Codex start work from the right card, spec, and project context.

## Install With Codex

Ask Codex:

```text
Install Planban from the GitHub repo piercekearns/planban. Add it as a Codex plugin marketplace source, install the Planban plugin, verify the plugin and MCP tools are available, open the Planban Demo board, and then ask me whether I want to set up Planban for one of my local projects.
```

## Manual Install

```bash
git clone https://github.com/piercekearns/planban.git
cd planban
npm install
node scripts/configure-local-plugin.mjs
codex plugin marketplace add "$PWD"
codex plugin add planban@planban
codex plugin list --marketplace planban
node plugins/planban/scripts/launch-planban.mjs --demo
```

Then open the printed local board URL. In Codex, ask your agent to open it in the in-app browser.

## First Run

Planban creates a `Planban Demo` board so you can try the product immediately.

Use it to:

- drag cards between columns
- open a roadmap item in Codex
- mark a card Complete when you are done
- send feedback from the toolbar
- ask Codex to create roadmap items from your existing plans

When you are ready to use Planban with a real project, ask Codex:

```text
Set up Planban for my local project at /path/to/project. If it is not initialized yet, ask me before initializing it. Then open the board and help me create roadmap items from the current repo docs, issues, notes, or my description of what I am building.
```

You can also give Codex planning context from Notion, Jira, Linear, GitHub Issues, copied notes, or a plain-language project update. Ask it to turn that context into draft Planban roadmap items for review.

## Feedback With Codex

Planban uses GitHub Issues for bugs, feature requests, and product feedback.

Feedback is welcome. If you want to share a bug, request, rough edge, or reaction, select the feedback button in the board toolbar, describe what happened, then choose whether to open a Codex draft thread or copy the prompt. Your agent will help turn the feedback into the right issue format before anything is filed publicly.

Ask Codex:

```text
I want to give feedback on Planban. Turn the feedback below into a concise GitHub issue for piercekearns/planban. Choose whether it is a bug, feature request, or general feedback. Ask me one clarifying question if needed. Do not include private repo paths, board contents, logs, screenshots, or personal project details unless I explicitly approve them.

Feedback:
<paste your feedback here>
```

Codex can then help you review the issue draft and file it through GitHub. You can also open the issue chooser directly:

https://github.com/piercekearns/planban/issues/new/choose

## Local Storage

Planban keeps live planning state on your machine:

- repo discovery files: `.planban/project.json` and `.planban/agent-context.md`
- local board state: `~/.planban/repos/<repo-id>/roadmap.json`
- local card docs: `~/.planban/repos/<repo-id>/items/<card-id>/spec.md` and `plan.md`

Do not commit `~/.planban` state to your project repo.

## License

Planban is source-available for local evaluation. It is not open source. See `LICENSE.md`.
