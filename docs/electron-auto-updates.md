# Electron updates via Cloudflare R2

Orbi Mail currently uses a free/unsigned update-notification flow: the app checks Cloudflare R2 for a newer version and opens the DMG/ZIP download for manual installation. True silent auto-install requires Apple Developer ID signing/notarization.

## One-time setup

1. Create a Cloudflare R2 bucket for app updates.
2. Expose it through a public/custom domain, e.g.:

   ```txt
   https://updates.example.com/orbi-mail
   ```

3. For the free/unsigned flow, no Apple Developer account is required, but users must manually replace the app when prompted.

The production app has the current R2 public URL built in as a fallback. Set this optional environment variable only if you need to point a build at a different update feed:

```bash
export ORBI_UPDATE_BASE_URL="https://updates.example.com/orbi-mail"
```

Optional signing/notarization variables, if/when you want true auto-install later:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: ..."
export APPLE_ID="..."
export APPLE_APP_SPECIFIC_PASSWORD="..."
export APPLE_TEAM_ID="..."
```

End users do not need to set environment variables. Keep the built-in fallback URL in `packages/electron/src/main.ts` current; older `0.1.4` builds did not successfully bake `ORBI_UPDATE_BASE_URL` into `package.json`, so they cannot discover updates automatically.

## Build release artifacts

Always bump `packages/electron/package.json` version first. For public releases, **build universal macOS artifacts** so one installer works on Apple Silicon and Intel Macs.

```bash
npm run package:mac:universal
```

Forge writes the universal artifacts under:

```txt
packages/electron/out/make/Orbi Mail.dmg
packages/electron/out/make/zip/darwin/universal/Orbi Mail-darwin-universal-<version>.zip
```

## Upload to Cloudflare R2

Production bucket/public base:

```txt
bucket: orbi-mail
public base: https://pub-85d769e6aabd49f98c7cb117f4091639.r2.dev
```

Upload the universal installer and zip:

```bash
VERSION="0.1.13" # set to packages/electron/package.json version
BASE="https://pub-85d769e6aabd49f98c7cb117f4091639.r2.dev"

npx wrangler r2 object put "orbi-mail/darwin/universal/Orbi Mail-${VERSION}.dmg" \
  --file "packages/electron/out/make/Orbi Mail.dmg" \
  --content-type application/x-apple-diskimage \
  --remote

npx wrangler r2 object put "orbi-mail/darwin/universal/Orbi Mail-darwin-universal-${VERSION}.zip" \
  --file "packages/electron/out/make/zip/darwin/universal/Orbi Mail-darwin-universal-${VERSION}.zip" \
  --content-type application/zip \
  --remote
```

Create `manual.json` with the universal URLs:

```json
{
  "version": "<version>",
  "name": "Orbi Mail <version>",
  "pub_date": "<UTC ISO timestamp>",
  "notes": "Short release notes.",
  "dmgUrl": "https://pub-85d769e6aabd49f98c7cb117f4091639.r2.dev/darwin/universal/Orbi%20Mail-<version>.dmg",
  "zipUrl": "https://pub-85d769e6aabd49f98c7cb117f4091639.r2.dev/darwin/universal/Orbi%20Mail-darwin-universal-<version>.zip"
}
```

Upload the same manifest to all three paths:

```bash
npx wrangler r2 object put "orbi-mail/darwin/universal/manual.json" --file manual.json --content-type application/json --remote
npx wrangler r2 object put "orbi-mail/darwin/arm64/manual.json" --file manual.json --content-type application/json --remote
npx wrangler r2 object put "orbi-mail/darwin/x64/manual.json" --file manual.json --content-type application/json --remote
```

Why three manifests? Existing apps check `/darwin/${process.arch}/manual.json` (`arm64` or `x64`). Both manifests should point at the universal DMG so every Mac downloads the same compatible installer.

## Clean R2 layout

Keep the bucket intentionally small and navigable. The expected live layout is only:

```txt
darwin/
  universal/
    Orbi Mail-<current-version>.dmg
    Orbi Mail-darwin-universal-<current-version>.zip
    manual.json
  arm64/
    manual.json   # points to universal DMG/ZIP
  x64/
    manual.json   # points to universal DMG/ZIP
```

Delete older versioned DMGs/ZIPs after verifying the current universal DMG works. Do **not** keep per-arch installers for normal releases; the per-arch folders only exist as compatibility manifest locations for older apps.

Public install link to share with everyone:

```txt
https://pub-85d769e6aabd49f98c7cb117f4091639.r2.dev/darwin/universal/Orbi%20Mail-<version>.dmg
```

Verify uploads before sharing:

```bash
curl -I "$BASE/darwin/universal/Orbi%20Mail-${VERSION}.dmg"
curl -I "$BASE/darwin/universal/manual.json"
curl -I "$BASE/darwin/arm64/manual.json"
curl -I "$BASE/darwin/x64/manual.json"
```

The unsigned/free update flow uses `manual.json` and opens the DMG URL. Signed auto-install would use the ZIP + `RELEASES.json` files.

## Important rollout note

Users must manually install one app version that contains working updater code. Version `0.1.4` contains the updater logic but lacks the update feed URL, so users on `0.1.4` must manually install `0.1.6` or later once. After that, future releases will be detected automatically, but unsigned builds still require the user to download and replace the app manually.
