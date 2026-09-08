#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# ship.sh — the daily driver. Push a change to the whole team in ~2 minutes.
#
#   npm run ship                      (message defaults to "Update")
#   npm run ship -- "Fix compose bar"
#
# The packaged Mac app loads its UI from Vercel, so once this finishes every
# teammate gets the new build by pressing Cmd+R (or clicking the "Update
# ready" badge that appears bottom-left within two minutes).
#
# Nobody re-downloads the app. That is only needed when the NATIVE shell
# changes — see scripts/release.sh.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

MSG="${1:-Update}"
BRANCH=$(git branch --show-current)

echo "▸ Type-checking backend…"
npx tsc -p convex/tsconfig.json --noEmit

echo "▸ Type-checking frontend…"
(cd packages/frontend && npx tsc -p tsconfig.app.json --noEmit)

echo "▸ Deploying Convex backend…"
npx convex deploy -y

echo "▸ Deploying UI to Vercel…"
npx vercel deploy --prod --yes

echo "▸ Committing + pushing ($BRANCH)…"
git add -A
git commit -m "$MSG" --allow-empty
git push origin "$BRANCH"

echo ""
echo "✅ Shipped. Team gets it with Cmd+R — or the badge bottom-left will"
echo "   offer 'Update ready' within two minutes."
