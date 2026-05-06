# Deployment — Orbi Mail backend (Railway)

The Mac app, iOS app, and web client all connect to a single hosted Fastify backend. Postgres + Redis run as Railway plugins.

## Why Railway

- Managed Postgres + Redis with one-click setup.
- Auto-deploys from git pushes.
- Good enough for a single-tenant / small-team internal tool.
- Background workers (BullMQ) run in the same process as the API, so one Railway service covers everything.

## First deploy

1. **Create Railway project**: <https://railway.app/new> → Deploy from GitHub repo.
2. **Add plugins**:
   - `+ New` → Database → PostgreSQL
   - `+ New` → Database → Redis
3. **Link variables**. Railway auto-injects `DATABASE_URL` and `REDIS_URL` when you reference the plugins. In your web service's Variables tab, click `Add Reference` for both.
4. **Set required env vars** on the backend service:

   ```
   JWT_SECRET                   (generate: openssl rand -hex 32)
   TOKEN_ENCRYPTION_KEY         (generate: openssl rand -hex 32)
   ANTHROPIC_API_KEY            sk-ant-...
   GOOGLE_CLIENT_ID             from Google Cloud Console
   GOOGLE_CLIENT_SECRET         from Google Cloud Console
   GOOGLE_REDIRECT_URI          https://<your-railway-domain>/api/accounts/oauth/gmail/callback
   MICROSOFT_CLIENT_ID          from Azure portal
   MICROSOFT_CLIENT_SECRET      from Azure portal
   MICROSOFT_REDIRECT_URI       https://<your-railway-domain>/api/accounts/oauth/microsoft/callback
   MICROSOFT_TENANT_ID          common
   TRACKING_BASE_URL            https://<your-railway-domain>
   FRONTEND_URL                 https://<your-frontend-domain> (or same Railway URL if not split)
   CORS_ORIGINS                 https://<your-frontend-domain>,capacitor://localhost,ionic://localhost
   NODE_ENV                     production
   PORT                         $PORT   (Railway provides this automatically — leave unset or reference)
   ```

5. **Deploy**. Railway uses the repo's `Dockerfile` (pointed at by `railway.json`). First build runs `prisma migrate deploy` before starting the server.

6. **Custom domain** (optional, recommended):
   - Railway service → Settings → Networking → Custom Domain → `api.orbimail.com`
   - Add a CNAME at your DNS provider pointing to Railway's target.
   - Update `packages/frontend/.env.electron` so the Mac app points at the custom domain.

## OAuth redirect URIs

When you move from localhost to a Railway domain, **add** (don't replace) the production redirect URIs in Google Cloud Console and Azure Portal. Do not remove the localhost ones — you still need them for local dev.

## Updating the app after deploy

- **Backend**: push to `main`, Railway rebuilds. Migrations run on startup; you don't need to run them manually.
- **Mac app**: run `npm run package:mac` and share the new `.dmg`. There is no auto-updater wired up yet — if you want one, add `@electron-forge/publisher-github` to `forge.config.cjs` and `update-electron-app` to the main process.
- **iOS app**: `npm run sync:ios` → open Xcode → archive → distribute.

## Cost note

Expect ~$5-20/month for a small internal team with Railway Hobby plan (Postgres + Redis + one service). Background workers mean the service stays "always on" — don't enable scale-to-zero or you'll miss scheduled sends and follow-ups.

## Going beyond Railway

If you outgrow Railway:
- Fly.io — cheaper at scale, more control.
- Render — similar DX, slightly different pricing.
- Own VPS + docker compose — cheapest if you already manage infra.

The `Dockerfile` is the portable unit; replace `railway.json` with the target platform's equivalent.
