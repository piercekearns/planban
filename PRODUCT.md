# Planban Product Constitution

This document defines the durable product principles for Planban. It guides product decisions, roadmap design, agent guidance, user experience, and contributions. Detailed strategy, commercial thinking, release sequencing, and unreleased research may remain private, but they extend this constitution rather than replace it.

## What Planban Is

Planban is a durable, agent-native planning system shared by humans and agents. Its Board is the primary human surface. Skills, MCP, APIs, CLIs, and other interfaces provide faithful access to the same planning authority.

Planban is primarily for an individual directing meaningful, continuing project work with one or more agents. It starts with software builders, but its underlying concepts should remain useful for design, research, writing, operations, and other project work.

Planban is not primarily a team-management suite, enterprise workflow engine, autonomous-agent control plane, or generic personal task manager.

## Primary Job: Sight

Planban's primary job is to give the human immediate, holistic sight of agentic project work.

People often drive projects through conversations with agents: describing ideas, setting goals, asking for work, refining scope, checking progress, and changing direction. Planban makes the resulting project state visible, coherent, inspectable, and easy to steer across conversations, agents, and time.

The Board should quickly answer:

- What work exists?
- What does it relate to?
- Where is it up to?
- What matters next?
- What can proceed in parallel?
- What needs attention or a human decision?

Direct controls such as moving, hiding, reprioritising, editing, completing, and archiving work support this sight. They do not define the product. The human may drive most outcomes through agentic conversation while using the Board to understand the whole and intervene directly when useful.

## Product Principles

### 1. Sight before administration

Planban should make a project easier to understand, not create another process to maintain. Visible state must help the human orient, decide, or act. Do not ask the human to maintain information mainly for the system's convenience.

### 2. One shared planning truth

Humans and agents work with the same durable planning authority. Agents should keep planning state current as work changes so the human does not have to transcribe their progress. Uncertainty, conflicts, stale context, and incomplete work must remain truthful rather than being smoothed into tidy but misleading state.

The human owns project intent, priority, and acceptance. Agents are trusted editors and operators within the authority they have been given; they do not silently redefine the project or declare consequential outcomes accepted.

### 3. Strong semantics, light process

Planban is opinionated about what Items, Groups, Status, summaries, next actions, Specs, Plans, history, and authority mean. It is flexible about the user's methodology, project type, sequence, number of agents, and way of working.

Planban should help many kinds of individual project workflow without becoming Linear, Jira, Basecamp, Notion, or a configurable enterprise process builder.

### 4. Human clarity above, execution detail below

The shallowest view should be immediately understandable. Technical depth should appear progressively as the work requires it or the human asks for it.

Agents should maintain this layering automatically:

- Board and card surfaces provide concise owner orientation.
- Item details explain current context and decisions.
- Specs define purpose, scope, invariants, and acceptance.
- Plans provide deterministic execution and verification when complexity justifies them.
- History and evidence preserve what happened without overwhelming the current view.

Planban governs the shape and clarity of planning artifacts represented in Planban. It does not govern every artifact an agent produces while performing the underlying work.

### 5. Lower human friction; require agent precision

Human interactions should remain helpful, reversible, and low-ceremony. Planban should infer, suggest, and prefill when it can do so safely.

Agents may carry additional invisible obligations: structured reasons, revisions, attribution, evidence, verification, reconciliation, and exact handoff context. Those obligations should improve reliability without leaking into tedious forms or repeated confirmations for the human.

Human confirmation remains appropriate for genuinely consequential, destructive, irreversible, ownership, or authority-changing actions—not routine bookkeeping.

### 6. Calm, proportional attention

Planban should be calm by default. It should call attention only to information that changes what the human should understand or do now, and its intensity should match the consequence.

Relationships, future constraints, and distant Pending work remain quiet. Active blockage, stale planning authority, failed operations, and required human decisions become visible without implying that the product itself has broken. Prominent states must explain the condition and provide a clear route forward. Do not rely on colour alone, alarm imagery, animation, or anxiety-inducing notification patterns.

### 7. Earn visible complexity

A visible feature must materially improve project sight or steering. It should make current state clearer, clarify what is next or parallel, improve resumption, preserve intent or authority, or provide a meaningfully faster or safer human action.

Defer, reject, or keep a capability agent-side when it mainly copies an adjacent project-management product, duplicates an adequate prompt or existing structure, adds persistent noise for an occasional edge case, or turns Planban into process administration.

### 8. Belong to the user and project, not the host

Planban's planning identity and concepts should survive movement across agents, chats, devices, repository locations, and interfaces.

Local Mode remains a complete permanent choice. Online Mode adds remote availability rather than replacing Local Mode. A Board has one clear writable authority at a time. Host integrations are progressive enhancements, not product forks. Missing capabilities degrade honestly to portable references, prompts, links, or structured operations.

### 9. Earn trust through truthful boundaries

Planban should make authority, capability, managed-content boundaries, uncertainty, and recovery behavior understandable.

It must not silently upload, synchronize, share, delete, or transfer authority. Agents and convenience interfaces cannot bypass authorization or human-owned consequential decisions. Important changes preserve useful history and recovery where practical. Stale, pending, or inferred state must not be presented as authoritative.

## Product Boundaries

Planban should not become:

- a full team or enterprise project-management suite;
- a Linear, Jira, Basecamp, Trello, or Notion clone;
- a general-purpose workspace or database builder;
- a sprint, reporting, role-matrix, or management-surveillance system;
- a generic productivity, calendar, habit, or personal-task application;
- an AI wrapper, model gateway, or autonomous-agent fleet manager.

Team, collaboration, calendar, notification, reporting, and workflow features are not forbidden. They must earn their place by serving Planban's primary individual, agentic project-work purpose without pulling the product toward those categories.

## Feature Decision Test

Before materially adding or changing a feature, ask:

1. How does this improve the human's sight or steering of project work?
2. Does it clarify current state, next work, parallel work, resumption, intent, or authority?
3. Is the visible human surface the right home, or can agent tooling carry the complexity?
4. Does it preserve strong semantics while allowing different workflows?
5. Is the attention it requests proportional and actionable?
6. Can the user already achieve the outcome adequately with prompts, Markdown, or existing Planban structures?
7. Are we solving an observed Planban problem, or copying an adjacent product's feature set?
8. Does it work honestly across supported Local, Online, and host capabilities?
9. What human burden does it add, and can an agent or the product safely absorb that burden instead?
10. What would Planban become if this pattern were repeated?

If a proposal conflicts with this constitution, the proposal must identify the conflict and justify an explicit amendment. Product drift must not happen through a sequence of individually convenient features.

## Applying This Constitution

Agents and contributors should consult this document before creating or materially reshaping Planban features, domain semantics, visible information hierarchy, platform/cloud behavior, roadmap structure, onboarding, positioning, or product guidance.

Routine Board operations and execution of an already accepted Plan do not require rereading it. The constitution guides product decisions; it should not become ceremony for ordinary use.
