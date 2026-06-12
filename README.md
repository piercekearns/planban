# Planban

Planban is a local, Codex-native Kanban-style planning board for agent-led software work.

It gives you a simple roadmap board, keeps your planning state local, and helps Codex start work from the right card, spec, and project context.

## Install With Codex

Ask Codex:

```text
Install Planban from piercekearns/planban as a Git-backed Codex plugin marketplace.

First check whether Node.js and npm are available. If either is missing, explain that Planban runs locally and requires Node.js, which normally includes npm. Ask me before installing Node.js. If I approve, install Node.js LTS using the safest method for this machine, then verify node --version and npm --version before continuing.

Then add the Planban marketplace, locate the installed marketplace root, run npm install there, configure the Planban MCP runtime, install the Planban plugin, verify the plugin and MCP tools are available, open the interactive Planban tutorial in the Codex in-app browser, and ask me whether I want to set up Planban for one of my local projects.
```

## Manual Install

Recommended Git-backed marketplace install:

```bash
codex plugin marketplace add piercekearns/planban
PLANBAN_ROOT="$(codex plugin marketplace list | awk '$1 == "planban" { print $2 }')"
cd "$PLANBAN_ROOT"
npm install
node scripts/configure-local-plugin.mjs "$PWD"
codex plugin add planban@planban
codex plugin list --marketplace planban
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

Then open the printed local tutorial URL. In Codex, ask your agent to open it in the in-app browser.

Local clone fallback:

```bash
git clone https://github.com/piercekearns/planban.git
cd planban
npm install
node scripts/configure-local-plugin.mjs "$PWD"
codex plugin marketplace add "$PWD"
codex plugin add planban@planban
node plugins/planban/scripts/launch-planban.mjs --tutorial
```

## First Run

Planban opens a short local tutorial and creates a `Planban Demo` board so you can try the product immediately.

Use it to:

- learn how `/PB`, `/Planban`, and `Planban Tutorial` work inside Codex
- drag cards between columns
- open a roadmap item in Codex
- inspect roadmap item details and specs
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

## Updates

Planban checks public version metadata from GitHub while the local board is open. If an update is available, the board shows a small update notice.

When Planban can prove your install is safe to update directly, choose `Update now`. Planban will show progress, refresh the local install, restart the local server, and reopen the board you were viewing.

If the install shape is ambiguous, dependencies are missing, a migration is needed, or local files make direct update unsafe, choose `Update with Codex` instead. That opens a draft prompt asking your agent to inspect the install, update Planban safely, verify the plugin and MCP tools, and open the right post-update surface.

For the first tutorial release, the post-update surface is the interactive tutorial in the Codex in-app browser. Future releases may open the board with a concise "what changed" modal instead.

Planban does not silently update itself and does not send private board contents, repo paths, logs, or project details as part of update checks.

## Local Storage

Planban keeps live planning state on your machine:

- repo discovery files: `.planban/project.json` and `.planban/agent-context.md`
- local board state: `~/.planban/repos/<repo-id>/roadmap.json`
- local card docs: `~/.planban/repos/<repo-id>/items/<card-id>/spec.md` and `plan.md`

Do not commit `~/.planban` state to your project repo.

## License

Planban is source-available for local evaluation. It is not open source. See `LICENSE.md`.
