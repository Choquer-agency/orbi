# Orbi — Cost & UX Fix Plan (2026-06-15)

Built via the grill-me method. Goal: **Orbi's marginal Convex cost ≤ $10/mo (target ~$2–3), staying on Pro, with zero feature loss**, and kill the "Re-fetch from Gmail" annoyance.

## Root-cause recap (what we proved)
- The bill problem was **Database I/O (bandwidth)**, never storage. Storage is 17/50 GB ($0).
- ~88% of Orbi's I/O was **one runaway cron** (`orphan-thread-repair` → `_listOrphanThreads`) blind-scanning 500 threads/account every 10 min → ~102 GB. **Already disabled + deployed.**
- The 1-minute sync poll was never the cost (~$1–2/mo); it was wrongly slowed then restored.
- Convex Pro = $25/mo base; overage is I/O $0.20/GB, storage $0.20/GB. Orbi's marginal cost is essentially its I/O × $0.20.

## Decisions locked (grill-me answers)
1. **Sync cadence:** keep the **1-min poll** (cheap). Push deferred — it's a *speed* upgrade (instant vs 60s), not a cost fix, and adds permanent Google Cloud Pub/Sub + watch-renewal ops. Revisit later.
2. **Mail freshness target:** instant was the ideal, but accepted 1-min for now given cost is already solved.
3. **Body loading:** **store the full body on arrival for ALL new mail** (~$0.02/mo total) → re-fetch button gone for anything going forward.
4. **Body retention:** **strip after 2 years** (storage is cheap; this is just a long-term cap). Old pre-migration mail (already body-less) **auto-loads on open** — replace the manual button with an automatic spinner.
5. **Orphan-repair:** **rebuild cheap, flag-based** — flag a thread at sync time if it lands with 0 messages; repair only flagged threads (indexed lookup), never a full scan.
6. **Cost tripwire:** **Convex dashboard spend alert + hard ceiling** so any project's runaway is caught in days, not weeks.
7. **Reliability:** keep a **slow safety-net poll** concept (already satisfied by the 1-min poll; if push is ever added, a 15–30 min catch-up poll stays).

## Workstreams (priority order = impact ÷ effort)

### 1. Body-on-arrival + auto-load-on-open  (HIGH value, LOW effort) — partly built
- **Backend (started, uncommitted):** `convex/sync/onDemandBody.ts` now has internal `fetchBodyForNewEmail`; `convex/sync/gmail.ts` schedules it for each new email. **TODO:** mirror in `convex/sync/microsoft.ts` (after its `_onNewEmailInserted` dispatch, ~line 466-478). Deploy.
- **Frontend:** in the email viewer, when an email has no body, **auto-call `ensureEmailBody` with a spinner** instead of rendering the "Re-fetch from Gmail" button. (Find the `(No body content yet)` / `Re-fetch from Gmail` component.)
- **Retention:** change `convex/sync/bodyRetention.ts` `RETENTION_DAYS` 14 → **730** (2 years).
- **Cost:** ~$0.02/mo. **Outcome:** no re-fetch button, ever; all mail renders instantly.

### 2. Cost tripwire  (HIGH value, ~0 effort) — Bryce, dashboard
- Convex dashboard → team → Usage/Billing → set a **spend alert** (email at ~$30/mo) and a **hard spending limit** (ceiling so it can never blow past, e.g. $50).
- Code rule going forward: **no unbounded table scans** in any cron or sync path (this is what orphan-repair violated).

### 3. Hot-path query audit  (MED value, MED effort) — OPTIONAL polish
- `convex/threads.ts` `list` fans out per thread (emails + comments + classification) and is **reactive** — it re-runs on every sync write while the app is open. Currently small (~0.9 GB/period) but it's the next-biggest I/O once sync is tamed.
- **Fix:** denormalize what the list needs onto the `threads` row (latest-email preview fields, primary classification, comment count, hasDraft) so the list query reads **only thread rows** — no per-thread fan-out. Update sync to maintain those denormalized fields.
- Only needed if post-fix I/O is still above target; likely we're already under $10 without it.

### 4. Orphan-repair, flag-based rebuild  (LOW value, LOW-MED effort)
- Add `needsRepair: v.optional(v.boolean())` to `threads` schema + an index `by_account_needsRepair`.
- In sync (`persistGmailThread` / `syncOneThread`), set `needsRepair: true` when a thread upserts with 0 email rows; clear it when emails land.
- New cron `orphan-thread-repair` (hourly) queries only `needsRepair == true` threads (indexed) and re-fetches just those. O(broken), not O(mailbox).

### 5. Push-based sync  (FUTURE — speed upgrade, not cost)
- Gmail `users.watch` → Google Cloud Pub/Sub topic → Convex HTTP webhook (`convex/http.ts`) → sync changed thread; Microsoft Graph `subscriptions` → webhook; watch/subscription **renewal cron** (Gmail ~7d, Graph ~3d expiry). Requires GCP Pub/Sub setup in Bryce's Google Cloud project.
- Deliver only if 1-min feels too slow after living with it.

## Cost projection after workstreams 1–2 (the minimum)
| Line | Cost/mo |
|---|---|
| Convex Pro base | $25.00 |
| Orbi Database I/O (1-min poll + body writes + queries) | **~$2–3** |
| Storage (within 50 GB) | $0 |
| **Orbi marginal Convex cost** | **~$2–3 ✓ (< $10)** |
| Anthropic API (classify + follow-ups) — separate, accepted | ~$5 |

## Features preserved (the no-sacrifice guarantee)
Team comments / @mentions / handoffs / shared threads; AI classify / follow-up / chat / drafts / needs-response / triage; full 60k-email history + search (free at rest); scheduled + undo send; open/click tracking; snooze; signatures; snippets; person system; OOO/vacation; multi-account; mobile + desktop + web. **None touched.** History stays because at-rest data drives ~no I/O.

## Risks & verification
- **Verify tomorrow (Jun 16):** the orphan-repair-off + 1-min-restore should show Orbi's daily I/O collapse on the usage chart. That's the proof the cost is solved before we build more.
- **Body fix risk:** fetching all new-mail bodies slightly increases writes — quantified at ~$0.02/mo, negligible.
- **CLI access:** dev deployment was deleted, so local CLI is unlinked from the project; prod changes go via the `CONVEX_DEPLOY_KEY` (revoke after). Re-link or fix `.env.local` for normal local dev later.
