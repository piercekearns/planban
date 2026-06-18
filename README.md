# Planban

Planban is a local, Codex-native Kanban-style planning board for agent-led software work.

It gives you a simple roadmap board, keeps your planning state local, and helps Codex start work from the right card, spec, and project context.

## What Planban Does

- Opens local project boards from Codex with `/pb` or `/planban`.
- Keeps live planning state on your machine, separate from your source repo.
- Gives agents stable board, card, spec, plan, and next-action context.
- Supports board creation, duplication, archiving, restoring, card movement, docs, history, and feedback flows.
- Ships CLI, local API, and MCP tools so Codex can work with Planban through structured local actions.

## Install With Codex

Ask Codex:

```text
Install Planban from piercekearns/planban. Follow the Install With Codex details in the public GitHub README exactly, verify the plugin and MCP tools work, open the interactive tutorial in the Codex in-app browser, then ask whether I want to set up Planban for a local project.
```

### Install With Codex details

These details are written for Codex to follow. If you want to run the commands yourself, use Manual Install below.

Planban installs as a Git-backed Codex plugin marketplace. Codex should:

1. Check whether Node.js and npm are available. Planban requires Node.js `>=22.12.0` so its local runtime and build tooling stay inside supported dependency ranges. If Node.js or npm is missing or too old, explain that Planban runs locally and requires a modern Node.js LTS release. Ask before installing or upgrading Node.js. If approved, install Node.js LTS using the safest method for the machine, then verify `node --version` and `npm --version` before continuing.
2. Add the Planban marketplace.
3. Locate the installed marketplace root.
4. Run `npm install` there.
5. Configure the Planban MCP runtime.
6. Install the Planban plugin.
7. Verify the plugin and MCP tools are available.
8. Open the interactive Planban tutorial in the Codex in-app browser.
9. Ask whether to set up Planban for one of the user's local projects.

## Manual Install

Use this path only if you prefer to install without asking Codex to perform the setup.

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

For this first public release, fresh installs should start with the interactive tutorial in the Codex in-app browser. If you used an earlier private or preview build, use Codex-guided update or reinstall from this public repository so your local plugin marketplace points at the clean public release.

Planban does not silently update itself and does not send private board contents, repo paths, logs, or project details as part of update checks.

## Local Storage

Planban keeps live planning state on your machine:

- repo discovery files: `.planban/project.json` and `.planban/agent-context.md`
- local board state: `~/.planban/repos/<repo-id>/roadmap.json`
- local card docs: `~/.planban/repos/<repo-id>/items/<card-id>/spec.md` and `plan.md`

Do not commit `~/.planban` state to your project repo.

## License

Planban is source-available for local evaluation. It is not open source. See `LICENSE.md`.
