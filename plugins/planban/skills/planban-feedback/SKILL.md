---
name: planban-feedback
description: Package Planban feedback for the project. Use when the user wants to report a bug, request a feature, share feedback, or send product feedback about Planban.
---

# Planban Feedback

Package user feedback using Planban's feedback flow.

## Gather

Capture the user's rough feedback, then gather enough diagnostic context for the
Planban maintainer to understand why the issue is surfacing, reproduce it where
possible, and decide whether it belongs as a bug, feature request, PR, security
report, or general product feedback.

Do not jump straight from rough feedback to a public issue. Treat feedback capture
as a short diagnostic conversation:

1. Restate what you think the user is reporting.
2. Identify the likely feedback route.
3. Ask the minimum useful follow-up questions before drafting if key information is
   missing.
4. Package the proposed title/body/context back to the user.
5. Recommend the route, for example: "I'd recommend raising this as a bug issue"
   or "This looks more like a focused PR proposal."
6. Let the user decide whether, where, and how to send it.

Classify the feedback where useful:

- bug
- feature request
- usability issue
- documentation/onboarding issue
- proposed fix or pull request idea
- private security concern
- praise
- other

Include local context when available:

- Planban version
- plugin version
- current board URL or repo id
- relevant browser/app behavior
- reproduction steps for bugs
- what the user expected to happen
- what actually happened
- whether the issue is repeatable
- whether it happens on a fresh board/project/thread or only a specific board
- relevant host app and permission/setup context, such as Codex version, browser
  mode, plugin install shape, update path, and OS when the user knows them
- screenshots, logs, board contents, local URLs, local file paths, or project
  details only after the user explicitly approves including or summarizing them

For bugs, prioritize maintainer-useful detail:

- clear steps to reproduce
- observed result
- expected result
- frequency and scope
- likely trigger or recent change
- relevant environment
- any workaround the user found

For feature requests, prioritize:

- the user's underlying job or pain
- why current Planban behavior is insufficient
- the smallest useful version of the request
- examples of when the user would use it

For PR or fix ideas, prioritize:

- what the change would alter
- why it is safe and focused
- whether an issue should be opened first
- what checks or tests would be expected

## Route

Use the same standards as the in-app feedback button. Prepare a concise GitHub issue, pull request outline, or project feedback payload for `piercekearns/planban` unless the local feedback flow provides a more specific route.

Use public GitHub Issues for bugs, feature requests, usability issues, documentation issues, and general product feedback. If the user has a concrete code or docs change, help them shape it as a focused pull request proposal and remind them to keep the change small unless an issue has been discussed first.

Do not route private security concerns to public issues. If the feedback describes a vulnerability, secret exposure, unsafe local file access, or another sensitive security concern, point the user to `SECURITY.md` and draft a private report instead.

Before any public action, present the draft and recommendation back to the user:

- recommended route
- concise reason for that route
- proposed title
- proposed body
- any context intentionally omitted for privacy
- any open questions that would make the report more useful

If GitHub tooling is available and the user has clearly authorized submitting the
exact draft to the exact destination, create the issue. Otherwise, draft the issue
text for review.

Keep the response clear: confirm what feedback was captured, where it is going, and whether anything still needs user approval.
