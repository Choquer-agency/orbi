<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

For production deploys, use `docs/convex-deployment.md`. The production deployment is
`careful-warbler-543`; deploys require `CONVEX_DEPLOY_KEY` and should not rely on the
logged-in Convex account on this machine.

<!-- convex-ai-end -->

## Electron macOS release rule

When the user asks to build/upload/share a macOS app release, always follow `docs/electron-auto-updates.md` exactly:

1. Build a **universal** macOS release (`npm run package:mac:universal`) so one DMG works on Apple Silicon and Intel Macs.
2. Upload the universal DMG/ZIP to Cloudflare R2 under `darwin/universal/`.
3. Upload the same `manual.json` to `darwin/universal/`, `darwin/arm64/`, and `darwin/x64/`, with all manifests pointing to the universal DMG/ZIP.
4. Share the universal public install link: `https://pub-85d769e6aabd49f98c7cb117f4091639.r2.dev/darwin/universal/Orbi%20Mail-<version>.dmg`.
5. Verify uploaded URLs return HTTP 200 before telling the user it is ready.
