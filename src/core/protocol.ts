import { basename } from "node:path";

export const PLANBAN_INSTALL_URL = "https://github.com/piercekearns/planban#install";

export function buildAgentContext(input: {
  planningRoot: string;
  roadmapPath: string;
  manifestPath: string;
  /** Board id used in the canonical Board URL. Defaults to the planning root folder name. */
  repoId?: string | undefined;
}): string {
  const repoId = input.repoId ?? basename(input.planningRoot);
  return `# Planban Agent Context

This repo uses Planban.

Canonical live planning state for this device is not branch-local. Read and write the live roadmap at:

- ${input.roadmapPath}

Repo-local manifest:

- ${input.manifestPath}

Device-local planning root:

- ${input.planningRoot}

Board URL (the port can differ; verify it through \`planban_launch_board\` before sharing it):

- http://127.0.0.1:4317/boards/${repoId}

## Planban tools

Planban is exposed as MCP tools whose names end in \`planban_<operation>\`: status, list_boards, launch_board, get_board, query_cards, get_card, read_doc, create_card, create_cards, create_group, move_card, update_card, write_doc. Pass \`cwd\` as this repo's absolute path. Linked git worktrees resolve to the main checkout's board automatically, so pass the worktree path when working in one.

## If Planban tools are not available in this session

- Tell the user once, in one sentence, that this project tracks work in Planban but Planban is not installed for this host, and link ${PLANBAN_INSTALL_URL} for the per-host install steps.
- Continue the requested work.
- When Planban state must change, use the Planban CLI from a Planban checkout (\`node <planban-checkout>/bin/planban.mjs <command> --cwd <this repo> -o json\`), or tell the user which Planban updates are pending. Every required Planning update is either applied or reported.

## Handoff

After opening the Board or completing a logical batch of Planning changes, include the clickable Board URL from the tool result in the reply and, if the host has an in-app browser, show the Board there once.

## Updating the roadmap

When the user asks to update the roadmap:

- update the roadmap item's status
- update priority when ordering changes within a column
- update the card summary and next action so they match the current phase of work
- update linked specs, and only create or update separate implementation plans when the work is complex enough to need one
- before creating or materially editing owner-facing Planban content, follow the installed Planban protocol and Planban house style
- do not create or prefer ROADMAP.md

Roadmap status protocol for agent work:

- if the user explicitly asks an agent to start implementing a roadmap item, or the agent proceeds to implementation work for that item, move it to In Progress when it is not already there
- do not move a card to In Progress merely because an agent thread or session was opened, context was read, or planning/discussion happened
- when the agent finishes its own implementation and verification, leave the card In Progress and update summary and next action to say it is ready for user review/testing
- move a card to Complete only when the user explicitly asks, manually confirms completion after testing/review, or clearly waives user-side verification
- agent-side tests and verification are enough to update the next action for user review/testing; they are not enough by themselves to self-complete the roadmap item
- a landing is a card event: whoever merges a PR, pushes to a release branch or retires a branch updates every In Progress Item that names it, before reporting the landing
`;
}
