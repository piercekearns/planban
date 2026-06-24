# Contributing to Planban

Thanks for taking a look at Planban.

Planban is early. The best contributions right now are small, focused fixes that
make the local Codex plugin, board UI, docs, install flow, or feedback flow more
reliable and easier to understand.

## Contribution Policy

Planban does not use a CLA or enforced DCO at launch.

By submitting a pull request, you agree that your contribution is licensed under
the MIT License.

## What Is Welcome

- Bug reports with clear reproduction steps.
- Small docs improvements.
- Small focused bug fixes.
- Small reliability or install-flow fixes.
- Tests that cover a concrete bug or behavior change.
- UI polish with before/after screenshots.

## Open an Issue First

Please open an issue before working on:

- new product features;
- host support beyond Codex;
- broad refactors;
- storage or migration changes;
- public API, MCP, or CLI contract changes;
- changes that alter install, update, or security behavior.

Opening an issue first does not guarantee the work will be accepted, but it avoids
wasting your time on a direction that may not fit the current roadmap.

## Pull Request Expectations

Keep pull requests small and focused.

Explain:

- what changed;
- why it should exist;
- how you tested it;
- what risks or follow-up work remain.

For UI changes, include before/after screenshots. For motion, drag/drop, browser
opening, onboarding, or other interaction changes, include a short screen recording
or describe exactly how to verify the behavior.

## AI-Assisted Contributions

AI-assisted contributions are welcome, but please say so in the pull request.

If Codex, Claude, Cursor, or another agent helped, include enough context for a
reviewer to understand the change:

- what the agent was asked to do;
- what you reviewed manually;
- what tests or checks passed;
- any areas where you are uncertain.

You are responsible for understanding and validating the contribution before
submitting it.

## Local Checks

Run the relevant checks before asking for review:

```bash
npm run typecheck
npm test
npm run build
```

For release or install-path changes, also run:

```bash
npm run release:preflight
```

## Privacy

Do not include private board contents, local project paths, logs, screenshots, API
keys, tokens, or personal project details in public issues or pull requests unless
you intentionally sanitize and approve them.

Use the security route for vulnerabilities or sensitive install/update behavior.
