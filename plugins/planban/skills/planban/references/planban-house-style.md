# Planban house style

Policy version: **Owner-approved draft v2, approved on 2026-08-30.**

## Name and intent

Call this the **Planban house style**. It is informed by useful controlled-English principles but does not claim ASD-STE100 compliance.

The style has two goals:

1. Let an owner understand current work quickly and accurately.
2. Preserve everything an agent needs for safe execution, verification, rollback, and resumption.

It is not a general instruction to shorten content. It assigns each kind of information an authoritative home and uses progressive disclosure.

## Product terms

- **Status** is the Item or Group's board column: In Progress, Up Next, Pending, Complete, or Archived. Technical model documentation may call this **Workflow Status** to distinguish it from Placement.
- **Placement** says whether an Item is on the Main Board or inside one Group. It is independent of Status.
- **Group progress** is a derived summary of the direct Items in a Group, such as completed Items out of total Items. Technical model documentation may call this a **Rollup**. Group progress does not automatically set the Group's own Status.

Ordinary owner-facing prose should use **Status** and **Group progress**. The more technical terms are useful only where their distinctions matter.

Terms such as **portfolio**, **programme**, **wave**, **tranche**, or **slice** may describe the role or delivery structure of an Item, but they are not additional Planban Work Item types. When one is useful, say explicitly that the record is an Item or Group and make its actual Status, ownership, and activation condition clear.

## Information locations and ownership

| Location | Kind | Authoritative responsibility | Must not become |
| --- | --- | --- | --- |
| Title | Visible card field | Stable, recognizable outcome | A status report, implementation ledger, or slogan |
| Summary | Visible card field | Fast current truth, scope, and remaining/gated work | A restatement of the title or a compressed Spec |
| Next action | Visible card field | Immediate executable step, gate, and stopping condition | A backlog, historical recap, or vague “continue” instruction |
| Group objective | Visible Group field | Why the Items belong together and the larger outcome they produce | A list of child titles |
| Spec | Document | Purpose, target/delivered outcome, current decisions, invariants, scope, acceptance, and exact agent reference | A chronological execution diary or ambiguous aspiration |
| Plan | Document | Current delivery phase, next gate, stopping condition, and deterministic runbook | A duplicate Spec or second card summary |
| Evidence and history | Existing records | Exact chronological proof, revisions, commands, releases, test results, and provenance | The only place current state can be understood |
| Tags and metadata | Structured fields | Stable controlled vocabulary and machine-readable state | Narrative prose |
| Agent handoff context | Generated context | Exact resumption context and safety protocol supplied when an agent starts or resumes work | Owner-facing product copy |

This table does not prescribe tabs or new UI. It maps information to existing card fields, documents, history, structured data, and generated agent context. A dedicated evidence ledger is an optional future feature, not part of this first delivery.

## Required rules

### All owner-facing prose

- Use current owner-facing Planban terms consistently: Item, Group, Status, Group progress, Spec, and Plan. Reserve Workflow Status, Placement, and Rollup for technical model explanations where those distinctions matter.
- State uncertainty, approval gates, safety boundaries, and unresolved work truthfully.
- Use explicit lifecycle tense. Distinguish intended, in-progress, delivered, superseded, and historical states.
- Do not use a bare `Outcome` heading when it is unclear whether the outcome is a target or an achieved result.
- Do not delete technical detail merely to make prose shorter; move it to the field, document, record, or generated context that owns it.
- Do not duplicate the same narrative across card, Spec, and Plan unless a short overlap is necessary for safe standalone use.

### Authority and conflict resolution

- Every Spec and Plan must identify its current authoritative section. Label older execution sections as historical or superseded when they could be mistaken for current instructions.
- A later explicit owner-accepted, delivered, or closeout record overrides earlier aspirational or execution prose in the same document.
- When an existing document has no identifiable current section, use the latest explicit owner-accepted, delivered, or closeout record as the provisional orientation and add a dated **Current state** or **Delivered outcome** section before relying on the document for execution. If no such record exists, report the authority gap rather than inferring one.
- Current card fields provide the owner-facing lifecycle orientation. They may clarify older prose, but they must not silently override a current safety boundary, accepted decision, or execution contract.
- Board Status supplies the lifecycle classification, but contradictory completion, review, or implementation metadata must be corrected or explicitly labelled stale in the same maintenance change.
- When current card fields, current accepted documents, or structured metadata materially conflict, surface and reconcile the conflict before execution. Do not silently choose the most convenient source.
- Unchecked historical gates do not represent remaining work after a later authoritative acceptance or closeout record. Preserve them as history, but explicitly mark their disposition or supersession rather than relying on a new opening to neutralize them.

### Title

- Name one stable product, user, or technical outcome.
- Use familiar language when it preserves precision.
- Retain domain vocabulary when it is the clearest durable name for the work.
- Avoid embedding temporary status, evidence, branch names, SHAs, or next steps unless they define the outcome itself.

### Summary

Answer these questions in order when relevant:

1. What is true now?
2. What scope does that truth cover?
3. What remains, blocks closure, or moved to another Item?

- Do not rely on the Status column or Priority to communicate actual progress.
- Scope completion precisely. Prefer `No work remains in this Item; production promotion remains in X` over `No work remains`.
- Include exact evidence only when it changes an owner decision, proves a critical boundary, or enables recovery.

### Next action

- For active work, identify the immediate action, relevant actor when needed, gate, and stopping condition.
- For owner-gated work, identify what the owner is reviewing and what happens after acceptance or rejection.
- A trigger-gated Item may truthfully say `Do not start work until X; then activate one bounded Item or slice`. Do not invent immediate work. If the Item has no continuing coordination role while it waits, consider Pending instead of In Progress.
- Keep one executable path. Split unrelated outcomes into separate Items or deeper reference.
- For completed work, do not manufacture an active action. State a scoped reopening or monitoring condition only when it is genuinely useful.
- Prefer `No active action in this Item` for completed work. Add monitoring, reopening, or external-ownership language only when it helps the next decision; otherwise the field may be empty if the product permits it.
- When related work belongs to another Item, name its stable Item identifier where available and state that this Item grants no authority to act on it.
- Distinguish routine observation from unfinished implementation.

### Spec

Use lifecycle-appropriate sections:

- **Purpose** — why the Item exists.
- **Target outcome** — the future success condition, while work is incomplete.
- **Delivered outcome** — the achieved result, after acceptance.
- **Current state** — what is actually true now.
- **Remaining work** — work still owned by this Item.
- **Related work elsewhere** — successor, production, programme, or residual work that does not keep this Item open.

Then preserve an explicit agent reference containing the applicable scope, decisions, invariants, constraints, edge cases, acceptance criteria, verification, rollback, and authoritative links.

- Identify which section is authoritative for current execution.
- Historical text must not silently override a newer accepted decision.
- A short Spec may combine sections, but purpose and lifecycle state must remain unambiguous.
- Preserve a lossless agent reference appropriate to the work. When applicable, retain scope boundaries, decisions and rationale, invariants, safety and authority constraints, compatibility behavior, edge cases, acceptance criteria, verification evidence, deployment and rollback identifiers, residual ownership, and authoritative links.
- Before a destructive document rewrite, make a retention map that ties every omitted exact fact to a surviving section or linked authoritative record.

### Plan

Begin with a compact **Plan status** block containing only:

- current phase;
- completed phases, compactly;
- next gate;
- stopping or owner-review condition.

Use this block whenever a document is linked through `planDoc`, including a programme or portfolio index, unless Planban explicitly classifies it as another document type. Use it after completion too. A completed Plan may say `Current phase: Complete` and `Next gate: None in this Item; related work is owned by <Item id>`.

Then provide the agent runbook:

- ordered phases or steps;
- one checkable completion criterion per phase;
- exact verification and rollback where required;
- explicit approval and authority boundaries;
- a rollback disposition: the exact rollback path when it remains usable, or an explicit statement that rollback requires a new scoped decision;
- a clear distinction between completed history and remaining commands.

Do not repeat the Spec's purpose, target outcome, product decisions, or acceptance criteria unless the Plan must operate safely without a Spec.

## Recommended rules

- Put the most decision-relevant sentence first.
- Prefer one primary idea per sentence when it improves comprehension.
- Prefer active voice when the actor or authority matters.
- Use bullets for parallel facts, criteria, and steps; use prose for reasoning and trade-offs.
- Keep exact IDs, SHAs, releases, and test counts out of the opening unless they explain current state, rollback, or a decision.
- Summarize extensive evidence and retain the exact record in existing history, Spec or Plan reference sections, or linked authoritative sources. A future evidence ledger is optional.
- Treat deployment identities, test results, and environment checks as dated evidence. Require fresh verification before later operational action when current external state matters.
- Let short, simple Items use proportionally short Specs and Plans.
- Preserve natural prose for product reasoning, design rationale, and persuasion where controlled language would flatten meaning.

## Candidate lint or preview checks

These are candidates for later validation, not implementation commitments.

- Warn when an active Item has no summary or no next action.
- Warn on unqualified phrases such as `No work remains`, `Complete`, or `Done` when related work is named elsewhere.
- Warn when a Spec uses `Outcome` without lifecycle qualification.
- Warn when a Plan has no identifiable current phase or next gate.
- Warn when completed checklist history appears before any current-state explanation in a long Plan.
- Warn when unchecked historical gates conflict with a later acceptance or closeout section.
- Warn when Complete Status conflicts with pending-acceptance metadata or a current Plan status block.
- Warn when card fields, the identified current document section, and structured metadata materially disagree.
- Preview likely duplication when substantially identical prose appears across summary, Spec opening, and Plan opening.
- Never auto-rewrite safety-critical or evidence-heavy material without review.

## Agent judgment

Agents decide, within the required contract:

- the natural wording of titles and prose;
- how much technical vocabulary the domain requires;
- whether a short Spec needs separate headings;
- which evidence is decision-relevant enough for the card;
- whether a one-sentence Plan orientation is needed for standalone safety;
- when design reasoning or explanatory prose is more useful than controlled brevity.

The goal is consistent function and information placement, not identical sentences across models.

## Evidence storage without new UI

This policy does not require an Evidence tab, evidence-ledger feature, metadata UI, or agent-context UI. For the first delivery:

- decisions and their reasoning remain in the current accepted Spec or related decision documentation;
- exact chronological proof remains in existing history, Spec or Plan reference sections, or linked authoritative sources;
- tags and metadata remain structured fields; and
- agent handoff context is generated when an agent starts or resumes work.

A decision record explains **what was decided and why**. An evidence record proves **what happened, when, and through which exact artifact or verification**. A dedicated evidence ledger could separate that chronological proof from current documents later, but it is separate product work that should require demonstrated need.

## Validation record

Before installation, this policy passed these gates:

1. It was applied to unseen active and completed Items from Planban and Revival.
2. It was tested with two supported models.
3. The tests compared factual retention, lifecycle accuracy, terminology, evidence placement, and card usability.
4. Agents resumed representative work from the resulting Specs and Plans.
5. Rules that caused ambiguity were revised.
6. The owner approved the exact policy on 2026-08-30.
