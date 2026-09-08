# Orbi — team setup & daily workflow

## How updates work (read this first)

The Mac app is a **thin window around the live web app**. It loads the UI from
`https://orbi-mail.vercel.app` every time it starts.

That means:

- **Bryce ships a change in ~90 seconds** with `npm run ship`.
- **Teammates get it by pressing Cmd+R.** No re-download, no reinstall.
- Within two minutes of a deploy an **"Update ready — click to reload"** badge
  appears bottom-left. Clicking it reloads.
- The bottom-left corner always shows the build you are on, e.g.
  `v0.1.13 · Sep 8, 10:07 AM`. When someone reports a bug, that label says
  exactly which build they were running.

The `.dmg` is only reinstalled when the **native shell** changes, which is rare.

---

## For the team: installing Orbi (once)

1. Bryce sends you **`Orbi Mail.dmg`**.
2. Open it and drag **Orbi Mail** into **Applications**.
3. Open it from Applications.
4. **First launch only:** macOS may say *"Apple could not verify this app."*
   Click **Done**, then go to  **System Settings → Privacy & Security**, scroll
   down, and click **Open Anyway** next to Orbi Mail. Confirm once.
   (This happens because the build is signed but not yet notarized. It only
   ever happens on the first launch.)
5. Sign in, then connect your mailbox: **Add account → Gmail**.

### Day to day

- **Cmd+R** — pull the newest version. Do this whenever Bryce says he shipped
  something, or whenever the "Update ready" badge appears.
- **Report bugs in Slack.** Include roughly when it happened. You do **not**
  need to copy any logs — Orbi records what happened in your window and Bryce
  can look it up directly.

---

## For Bryce: shipping

```bash
npm run ship -- "Fix the compose bar"
```

Typechecks, deploys the Convex backend, deploys the UI to Vercel, then commits
and pushes. About 90 seconds end to end. The team gets it on their next Cmd+R.

```bash
npm run release
```

Rebuilds the native `.dmg` (only when `packages/electron/` changes, or to
onboard someone new). See the header of `scripts/release.sh` for the one-time
notarization setup that removes the Gatekeeper warning for good.

---

## Reading what a teammate hit

Orbi records each session: clicks, view changes, failed requests and thrown
errors, stamped with the exact UI build. It never records what anyone types —
no email bodies, subjects or recipients. Recordings are deleted after 7 days.

Who was active, on which build, and how many errors they hit:

```bash
npx convex run telemetry:_debugSessions '{"sinceHours":24}'
```

Only sessions that hit errors:

```bash
npx convex run telemetry:_debugSessions '{"sinceHours":24,"onlyErrors":true}'
```

The full event stream for one person, or one session:

```bash
npx convex run telemetry:_debugEvents '{"email":"lauren@choquer.agency","sinceHours":3}'
npx convex run telemetry:_debugEvents '{"sessionId":"mtsx8bfx-ruxhcksq"}'
npx convex run telemetry:_debugEvents '{"email":"johnny@choquer.agency","onlyErrors":true}'
```

Paste a Slack report into Claude Code and it can run these itself.
