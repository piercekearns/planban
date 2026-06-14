# Planban Public Release Checklist

This repository is the private working source of truth. Do not publish it directly.
Every public release must be generated as a clean release bundle and pushed from that
bundle only.

## Release Rule

Only publish `tmp/planban-public-release` after it has been regenerated and passed
preflight. Never run a broad `git add .` from the private working repo for the public
GitHub repository.

## Required Preflight

Run:

```sh
npm run release:preflight
```

That command must pass before creating a public commit or GitHub release. It runs:

- TypeScript typecheck.
- Full test suite.
- Web build.
- Public website build and public-content audit.
- Clean public release bundle generation.
- Public release audit.
- Version consistency checks across `package.json`, `release/latest.json`, and the
  Codex plugin manifest.

For website-only changes or a Cloudflare Pages deploy, run:

```sh
npm run site:preflight
```

Do not deploy the website with a raw `wrangler pages deploy` command. Use
`npm run site:deploy` so the site build and public-content audit run first.

## Manual Review

Before pushing the generated release bundle, manually inspect:

- `tmp/planban-public-release/README.md`
- `tmp/planban-public-release/LICENSE.md`
- `tmp/planban-public-release/release/latest.json`
- `tmp/planban-public-release/plugins/planban/.codex-plugin/plugin.json`
- `tmp/planban-public-release/.agents/plugins/marketplace.json`

Before publishing website changes, manually inspect:

- `src/site/components/PlanbanPublicWebsite.tsx`
- `functions/api/subscribe.ts`
- `dist/site/index.html`

Confirm:

- The public README describes the current install path and first-run behavior.
- The release manifest version, summary, release notes URL, and update prompt match
  the release being shipped.
- The plugin manifest version matches `release/latest.json`.
- No private Planban board state, roadmap planning docs, local agent instructions,
  screenshots, transcripts, or machine-local paths are present.
- No API keys, tokens, `.env` files, private local paths, or temporary debugging
  artifacts are present.
- Website copy does not mention private feedback sources, private customer names,
  private project names, unreleased vulnerability details, or internal incident
  history.

## Forbidden In Public Releases

The generated public bundle must not include:

- `.planban/`
- `.codex/`
- `.claude/`
- `.cursor/`
- `AGENTS.md`
- `CLAUDE.md`
- `CLOUD.md` or `cloud.md`
- `.env*`
- `node_modules/`
- `dist/`
- `tmp/`
- private screenshots or attachment exports
- private board contents or roadmap docs
- local paths under `/Users/piercekearns`
- launch tokens or API keys

## Publishing Pattern

1. Update the private repo.
2. Set the intended release version and release metadata.
3. Run `npm run release:preflight`.
4. Inspect `tmp/planban-public-release`.
5. Copy or sync only that generated bundle into the public GitHub repo.
6. Commit and push from the public repo.
7. Create the matching GitHub release tag and release notes.
8. Install or update from the public repo in a local Codex instance to verify the user
   update path.

If any step feels ambiguous, stop and re-run the public bundle audit before pushing.

## Public Website Deploy Pattern

1. Make the site change in `src/site` or `functions`.
2. Run `npm run site:preflight`.
3. Inspect the generated `dist/site` pages that changed.
4. Deploy with `npm run site:deploy`.
5. Visit the production URL and verify the changed pages, signup behavior when relevant,
   mobile layout, and browser console.

If GitHub-connected Pages deploys are enabled, require CI to pass before merging site
changes into the production branch. A GitHub-connected deploy should not be used to
skip `npm run site:preflight`.
