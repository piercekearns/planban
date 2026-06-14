# Planban Public Website

The public website lives in `src/site` and builds as a static Vite site.

## Local commands

```sh
npm run site:build
npm run site:preview -- --host 127.0.0.1 --port 4320
```

The production artifact is `dist/site`.

## Hosting

Cloudflare Pages is the current recommended path because it is agent-friendly for this project:

- GitHub-connected deploys can publish ordinary edits automatically.
- Wrangler can deploy prebuilt assets from the command line when direct agent-driven deploys are useful.
- The email capture endpoint can live beside the static site as a Pages Function.
- DNS for `planban.ai`, the Pages custom domain, and Resend verification records can all live in Cloudflare.

Production domain:

- `https://planban.ai/`

Cloudflare Pages settings:

- Build command: `npm run site:build`
- Build output directory: `dist/site`
- Functions directory: `functions`
- Production branch: whichever branch is used for the public website repo
- Production custom domain: `planban.ai`

Recommended setup:

1. Add `planban.ai` as a Cloudflare zone if it is not already managed there.
2. Point the registrar nameservers for `planban.ai` to Cloudflare.
3. Create a Cloudflare Pages project connected to the GitHub repo.
4. Use the settings above.
5. Add `planban.ai` under Pages > Custom domains. Cloudflare should create the needed DNS record automatically when the zone is in the same account.
6. Add `www.planban.ai` only if wanted, then redirect it to the apex domain.

Important: create the project through **Pages > Connect to Git** first. Do not create the initial Pages project with `wrangler pages project create`, because that creates a Direct Upload project and Cloudflare does not let Direct Upload projects switch to Git integration later.

Manual deploy fallback after the Git-connected Pages project exists:

```sh
npm run site:build
npx wrangler pages deploy dist/site --project-name planban-public-website
```

The site can still move to Vercel, Netlify, or GitHub Pages. If it moves to GitHub Pages, email capture needs a separate backend endpoint because GitHub Pages cannot run the `/api/subscribe` function.

## Email Capture

The footer form posts to `VITE_PLANBAN_SIGNUP_ENDPOINT` when configured. For Cloudflare Pages, set:

```sh
VITE_PLANBAN_SIGNUP_ENDPOINT=/api/subscribe
RESEND_API_KEY=<Resend API key>
RESEND_SEGMENT_ID=<Resend segment id>
```

`VITE_PLANBAN_SIGNUP_ENDPOINT` is a public build-time variable. `RESEND_API_KEY` and `RESEND_SEGMENT_ID` are private Pages Function environment variables/secrets.

The Pages Function creates or reuses a Resend Contact, then adds that contact to `RESEND_SEGMENT_ID` when configured. Resend Audiences are deprecated; use Contacts and Segments for the website update list.

Before publishing:

1. Secure the Planban domain.
2. Add and verify a sending domain in Resend. Prefer a purpose-specific subdomain such as `updates.planban.ai` for product updates.
3. Create a Resend segment for website updates, for example `Planban Website Updates`.
4. Create a scoped Resend API key.
5. Add the variables above to the hosting provider.
6. Submit a real email through the deployed site and confirm the contact appears in Resend and in the website updates segment.

Useful Resend CLI checks once the domain exists:

```sh
resend domains list
resend api-keys create --name "Planban Public Website"
resend api-keys list
resend contacts list
```

Use the Resend dashboard or API to create/confirm the segment id if the local CLI does not expose segment creation.

## Social Links

The footer always shows GitHub. X defaults to the claimed Planban handle:

```sh
VITE_PLANBAN_X_URL=https://x.com/planbanai
```

YouTube stays hidden unless this build-time variable is set:

```sh
VITE_PLANBAN_YOUTUBE_URL=https://youtube.com/@<handle>
```

## Remaining Launch Inputs

- Final Planban logo / icon SVG.
- Cloudflare zone and DNS for `planban.ai`.
- Hosting provider confirmation.
- Resend domain, segment, and API key.
- Optional YouTube account.
- Social preview image once the logo and domain exist.
