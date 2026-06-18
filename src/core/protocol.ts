export function buildAgentContext(input: {
  planningRoot: string;
  roadmapPath: string;
  manifestPath: string;
}): string {
  return `# Planban Agent Context

This repo uses Planban.

Canonical live planning state for this device is not branch-local. Read and write the live roadmap at:

- ${input.roadmapPath}

Repo-local manifest:

- ${input.manifestPath}

Device-local planning root:

- ${input.planningRoot}

When the user asks to update the roadmap:

- update the roadmap item's status
- update priority when ordering changes within a column
- update the card summary and next action so they match the current phase of work
- update linked specs, and only create or update separate implementation plans when the work is complex enough to need one
- do not create or prefer ROADMAP.md

Roadmap status protocol for agent work:

- if the user explicitly asks an agent to start implementing a roadmap item, or the agent proceeds to implementation work for that item, move it to In Progress when it is not already there
- do not move a card to In Progress merely because a Codex thread was opened, context was read, or planning/discussion happened
- when the agent finishes its own implementation and verification, leave the card In Progress and update summary and next action to say it is ready for user review/testing
- move a card to Complete only when the user explicitly asks, manually confirms completion after testing/review, or clearly waives user-side verification
- agent-side tests and verification are enough to record "ready for review"; they are not enough by themselves to self-complete the roadmap item
`;
}
