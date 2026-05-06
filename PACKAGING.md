# Packaging — Orbi Mail for macOS

Build a signed, notarized `.dmg` you can download and install like any other Mac app. The installed app is a thin client that connects to the hosted backend (see `DEPLOYMENT.md`).

## Prerequisites

1. **macOS dev machine** (must be macOS to build/sign the .dmg).
2. **Apple Developer account** ($99/yr) — required for signing + notarization.
3. **Developer ID Application certificate** installed in your Keychain. In Xcode: Settings → Accounts → your Apple ID → Manage Certificates → `+` → Developer ID Application.
4. **App-specific password** for notarization. Generate at <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords.
5. **Hosted backend URL** (e.g. `https://api.orbimail.com/api`). Update `packages/frontend/.env.electron` if yours differs.

## One-time setup

Set these environment variables (e.g. in `~/.zshrc`):

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="your@appleid.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
```

Find your signing identity: `security find-identity -v -p codesigning`

Find your Team ID: Apple Developer account page → Membership.

## Build

```bash
# From repo root
npm install                # once
npm run package:mac        # universal (arm64 + x64 arch on host)
# or
npm run package:mac:arm64  # Apple Silicon only
npm run package:mac:x64    # Intel only
```

The built `.dmg` appears in `packages/electron/out/make/`.

## Install

1. Open the `.dmg`.
2. Drag `Orbi Mail` → `Applications`.
3. First launch: right-click → Open (only needed if skipping notarization). If signed+notarized, double-click works normally.

## Updating the app icon

The build reads `packages/electron/assets/icon.icns`. To regenerate:

```bash
ASSETS=packages/electron/assets
ICONSET=$ASSETS/icon.iconset
SRC=/path/to/your-1024x1024.png
rm -rf "$ICONSET" && mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z $size $size "$SRC" --out "$ICONSET/icon_${size}x${size}.png" > /dev/null
  sips -z $((size*2)) $((size*2)) "$SRC" --out "$ICONSET/icon_${size}x${size}@2x.png" > /dev/null
done
cp "$SRC" "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o "$ASSETS/icon.icns"
sips -z 16 16 "$SRC" --out "$ASSETS/trayTemplate.png" > /dev/null
sips -z 32 32 "$SRC" --out "$ASSETS/trayTemplate@2x.png" > /dev/null
```

## Skipping signing (fast iteration)

Don't set `APPLE_SIGNING_IDENTITY` and `forge.config.cjs` will skip signing. Users will need to right-click → Open on first launch.

## Troubleshooting

- **"damaged and can't be opened"** — unsigned build blocked by Gatekeeper. Either sign+notarize, or run `xattr -cr "/Applications/Orbi Mail.app"`.
- **Notarization fails with "Invalid password"** — regenerate the app-specific password; Apple rotates these occasionally.
- **White screen on launch** — backend URL unreachable. Check DevTools (`View → Toggle Developer Tools`) → Network tab. Verify `VITE_API_URL` in `.env.electron` and that your Railway backend is up.
