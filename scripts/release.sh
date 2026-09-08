#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# release.sh — rebuild the NATIVE Mac shell (.dmg).
#
# You rarely need this. The shell is a thin window that streams the UI from
# Vercel, so day-to-day changes ship with `npm run ship` and teammates just
# press Cmd+R. Only rebuild here when packages/electron/ itself changes, or to
# onboard someone new.
#
#   npm run release
#
# ── One-time setup for notarization (strongly recommended) ───────────────────
# Without it macOS shows "Apple could not verify this app" on first launch and
# each teammate has to approve it manually. To fix that permanently:
#
#   1. Create an app-specific password at https://appleid.apple.com
#      (Sign-In and Security → App-Specific Passwords)
#   2. Store it in the keychain — this is the only time you type it:
#        xcrun notarytool store-credentials orbi \
#          --apple-id "hello@choquer.agency" \
#          --team-id VAC2837QGB \
#          --password "<the app-specific password>"
#   3. Add to your shell profile:
#        export APPLE_ID="hello@choquer.agency"
#        export APPLE_TEAM_ID="VAC2837QGB"
#        export APPLE_APP_SPECIFIC_PASSWORD="<the same password>"
#
# After that every release is notarized and installs with no warning at all.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

export APPLE_SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-Developer ID Application: Bryce Choquer (VAC2837QGB)}"

if [ -z "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]; then
  echo "⚠️  APPLE_APP_SPECIFIC_PASSWORD not set — building SIGNED but NOT notarized."
  echo "   Teammates will see a Gatekeeper warning on first launch."
  echo "   See the header of this script to fix that permanently."
  echo ""
fi

echo "▸ Type-checking…"
npm run typecheck

echo "▸ Building the Mac app (arm64)…"
npm run package:mac:arm64

DMG="packages/electron/out/make/Orbi Mail.dmg"
if [ -f "$DMG" ]; then
  cp "$DMG" ~/Desktop/"Orbi Mail.dmg"
  echo ""
  echo "✅ Built: ~/Desktop/Orbi Mail.dmg"
  echo "   Share that file with the team. They only install it ONCE —"
  echo "   every later change reaches them through 'npm run ship'."
else
  echo "✋ No .dmg produced — check the output above."
  exit 1
fi
