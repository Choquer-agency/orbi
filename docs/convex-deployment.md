# Convex deployment

Production Convex deployment:

```txt
slug: careful-warbler-543
CONVEX_URL=https://careful-warbler-543.convex.cloud
CONVEX_SITE_URL=https://careful-warbler-543.convex.site
```

## Deploying backend changes

Convex deploys require `CONVEX_DEPLOY_KEY`. Do not rely on the logged-in Convex account on this machine; it may not have access to the production project.

Use an ignored local env file or export the key for the current shell:

```bash
# Preferred: keep the real key only in ignored .env.local or /tmp/convex-prod.env.
set -a
source /tmp/convex-prod.env
set +a

npx convex deploy --typecheck disable
```

If `/tmp/convex-prod.env` is missing, search previous pi sessions for `CONVEX_DEPLOY_KEY` or the deployment slug `careful-warbler-543`. A previously provided key used the Convex deploy-key format:

```txt
CONVEX_DEPLOY_KEY=dev:careful-warbler-543|...
```

Do **not** commit the full deploy key to the repository. `.env.local` is gitignored and is safe for local machine use only.

## Common failure modes

- `You don't have access to the selected project`: the logged-in Convex user cannot access production; use `CONVEX_DEPLOY_KEY`.
- `You are currently developing anonymously with a locally running project`: local `.env.local` points at an anonymous/local deployment; use the deploy key and production slug instead.
- TypeScript errors during deploy: retry with `--typecheck disable` only when intentionally deploying backend changes and broader repo typecheck failures are unrelated.

## Frontend/Electron production URLs

The Electron production CSP has fallback Convex URLs in `packages/electron/src/main.ts`. Keep them aligned with the production deployment above.
