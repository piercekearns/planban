---
name: planban-feedback
description: Package Planban feedback for the project. Use when the user wants to report a bug, request a feature, share feedback, or send product feedback about Planban.
---

# Planban Feedback

Package user feedback using Planban's feedback flow.

## Gather

Capture the user's rough feedback. If needed, ask one concise follow-up question.

Classify the feedback where useful:

- bug
- feature request
- usability issue
- documentation/onboarding issue
- praise
- other

Include local context when available:

- Planban version
- plugin version
- current board URL or repo id
- relevant browser/app behavior
- reproduction steps for bugs

## Route

Use the same standards as the in-app feedback button. Prepare a concise GitHub issue or project feedback payload for `piercekearns/planban` unless the local feedback flow provides a more specific route.

If GitHub tooling is available and the user has clearly authorized submitting feedback, create the issue. Otherwise, draft the issue text for review.

Keep the response clear: confirm what feedback was captured, where it is going, and whether anything still needs user approval.
