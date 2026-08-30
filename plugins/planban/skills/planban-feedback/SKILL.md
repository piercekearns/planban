---
name: planban-feedback
description: Investigate and package Planban bugs, feature requests, usability problems, and product feedback. Use when the user wants to report feedback or appears to be experiencing a Planban problem.
---

# Planban Feedback

Turn the user's existing context into a maintainer-useful report with as little
additional effort from the user as possible. Diagnose and route the feedback before
asking the user to approve any public action.

## Start From Available Context

Treat the current conversation, recent tool output, and relevant workspace state as
the user's initial account. Do not ask them to repeat facts already available there.

For a bug, reconstruct:

- what the user was trying to do;
- expected and observed behavior;
- errors, screenshots, or logs already shared;
- whether the problem appears repeatable; and
- any workaround or local code change already attempted.

Ask only short, high-value questions whose answers cannot be safely discovered and
would materially improve the diagnosis or routing. Forgotten details never block a
report: record them as unknown.

## Investigate Before Routing

Use targeted, read-only inspection when it is available and relevant. Prefer facts
from Planban's own installation and current workspace, such as:

- Planban and plugin versions;
- OS version and architecture;
- host app, install method, and update path;
- Planban service status and relevant configuration; and
- narrowly relevant, sanitized Planban errors or logs.

Do not stop for separate permission before ordinary in-scope read-only checks. Ask
before a write, a consequential reproduction, or access to sensitive material.

Do not inspect secrets, unrelated machine state, private board contents, or project
documents merely to enrich a report. Never publish board names, repo ids, local URLs,
paths, logs, screenshots, or project details without the user's approval. Tell the
user what categories of local information you inspected.

After understanding the problem, search open and closed issues, pull requests,
recent releases, and the latest available default-branch source in
`piercekearns/planban`. Record the source ref or freshness when it affects the
diagnosis. Determine whether a result is a strong match, a possible match, already
fixed upstream, or unrelated. Explain the evidence for that classification rather
than handing raw search results to the user.

## Build The Bug Capsule

Package bugs with:

- one-sentence impact;
- best-known reproduction steps;
- expected and actual behavior;
- automatically observed environment and version facts;
- minimal sanitized evidence;
- frequency and scope;
- diagnosis, clearly separating confirmed cause from inference;
- workaround or local change, if any;
- same-machine before/after result when available;
- matching issues, pull requests, releases, or competing work;
- unknown facts and why they could not be recovered; and
- the agent/model/harness that investigated or implemented the work.

Classify facts as observed automatically, reported by the user, inferred, or unknown
when that distinction affects confidence.

## Recommend One Route

Give the user a directed recommendation and prepare the corresponding exact draft:

- For a strong existing match, recommend adding the new environment or reproduction
  evidence to that issue instead of filing a duplicate.
- For a possible match, explain the uncertainty and recommend either a distinguishing
  comment or a new issue.
- When no credible match exists, recommend a new bug issue.
- When a newer release likely fixes the problem, recommend updating and retesting
  before filing. If it persists, return to the matching issue or new-issue route.
- Route feature requests, usability issues, documentation issues, and general product
  feedback to the appropriate public issue format.
- Route vulnerabilities, secret exposure, or unsafe local file access through
  `SECURITY.md`, never a public issue.

Do not present an unexplained menu and make the user determine the route. They decide
whether to approve the recommended public action after seeing its destination and
exact text.

## Pull Request Eligibility

A reported bug is not itself a reason to recommend a pull request. Recommend a PR
only when inspection of the conversation and workspace confirms that the user or
their agent already:

1. investigated this specific bug;
2. implemented a concrete code or documentation change;
3. retested the original failing scenario successfully;
4. applied or reproduced the change against current Planban `main`;
5. added proportionate regression coverage where practical;
6. passed the relevant checks; and
7. produced a focused change without unresolved dependencies or known blockers.

A hypothesis, proposed edit, configuration workaround, unverified local patch, or
one-time disappearance of the symptom is not PR-eligible. Record it in the issue as
an attempted fix or workaround. Do not recommend that the user ask an agent to file
a PR for a fix that has not already been implemented and verified.

When the existing local fix is PR-eligible, link it to the strong matching issue when
one exists. Otherwise, normally recommend a new bug issue plus a linked PR. A tiny
self-contained correction may go directly to a PR only when its body carries the
complete bug capsule. Include root cause, scope, tests, platform or interaction
evidence, residual risk, and agent assistance in the PR package.

Do not silently expand feedback capture into implementation work. When no verified
fix exists, file the report first; the user may separately ask an agent to work on it.

## Approval And Handoff

Before posting, commenting, or opening a PR, show:

- the recommended route and why;
- the exact destination;
- the proposed title and body;
- what local information was inspected;
- what was omitted or redacted; and
- any remaining uncertainty.

Perform the external action only after the user explicitly approves the exact action
or has already clearly authorized it. Then confirm what was submitted and link it.
