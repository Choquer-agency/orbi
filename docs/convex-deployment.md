# Convex deployment

Production Convex deployment:

```txt
slug: hallowed-shepherd-316
CONVEX_URL=https://hallowed-shepherd-316.convex.cloud
CONVEX_SITE_URL=https://hallowed-shepherd-316.convex.site
```

Verified on 2026-09-11 against the live Vercel bundle, the local deployment key's
target, and a read-only query of the Choquer workspace. Older instructions named
`careful-warbler-543`; that is not the backend the current app uses.

## Deploying backend changes

Convex deploys require `CONVEX_DEPLOY_KEY`. Do not rely on the logged-in Convex account on this machine; it may not have access to the production project.

Use an ignored local env file or export the key for the current shell:

```bash
# The ignored .env.local contains the production deploy key.
set -a
source .env.local
set +a

npx convex deploy --typecheck enable
```

Before deploying, verify the key targets `hallowed-shepherd-316` without printing
the secret. `CONVEX_DEPLOY_KEY` takes precedence over `CONVEX_DEPLOYMENT` and
`--prod`; the local development URL in the same file is not the production target.
If the key is missing, obtain a key for the verified production deployment.

Do **not** commit the full deploy key to the repository. `.env.local` is gitignored and is safe for local machine use only.

## Common failure modes

- `You don't have access to the selected project`: the logged-in Convex user cannot access production; use `CONVEX_DEPLOY_KEY`.
- `You are currently developing anonymously with a locally running project`: local `.env.local` points at an anonymous/local deployment; use the deploy key and production slug instead.
- TypeScript errors during deploy: retry with `--typecheck disable` only when intentionally deploying backend changes and broader repo typecheck failures are unrelated.

## Frontend/Electron production URLs

The Electron production CSP has fallback Convex URLs in `packages/electron/src/main.ts`. Keep them aligned with the production deployment above.
