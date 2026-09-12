import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("refresh-erp-clients", { minutes: 15 }, internal.clientWorkflow.refreshDirectories, {});

// ── Email sync ──────────────────────────────────────────────────────────────
// Both providers do an incremental delta sync every minute, for fast mail.
// This is CHEAP: an empty/near-empty delta poll only reads the account doc +
// sync cursor (~tens of MB/day total across accounts, ~$1-2/month). The
// runaway cost on 2026-06-15 was NOT this poll — it was the orphan-repair
// cron blind-rescanning 500 threads/account (~102GB), now disabled. So fast
// sync stays; the waste is gone.
// Each invocation enumerates active accounts and schedules a per-account
// sync chunk. Chunks self-reschedule via scheduler.runAfter when more pages
// exist (action time limit ~10 min; we stay well under).
crons.interval(
  "gmail-incremental-sync",
  { minutes: 1 },
  internal.sync.gmail.syncAllActiveAccounts,
  {},
);
crons.interval(
  "microsoft-incremental-sync",
  { minutes: 1 },
  internal.sync.microsoft.syncAllActiveAccounts,
  {},
);

// ── Gmail real-time push ────────────────────────────────────────────────────
// Accounts with a live users.watch registration get mail via Pub/Sub →
// /gmail/push in seconds and are SKIPPED by the 1-min poll above. The 10-min
// fallback here re-polls watched accounts in case a Pub/Sub message was
// dropped; the hourly renewal keeps watches alive (~7-day expiry, renewed
// when <24h left). No GMAIL_PUSH_TOPIC env → renewal no-ops and every
// account simply polls like before.
crons.interval(
  "gmail-watched-fallback-sync",
  { minutes: 10 },
  internal.sync.gmail.syncAllActiveAccounts,
  { watchedOnly: true },
);
crons.interval(
  "gmail-watch-renewal",
  { hours: 1 },
  internal.sync.gmailPush.renewWatches,
  {},
);

// ── Scheduled-send dispatch ─────────────────────────────────────────────────
// Picks up scheduledEmails with status="SCHEDULED" and sendAt <= now.
crons.interval(
  "scheduled-send-dispatch",
  { minutes: 1 },
  internal.scheduledEmails.processDueScheduledEmails,
  {},
);

// ── Stuck-send sweeper ──────────────────────────────────────────────────────
// Sends must never be silently lost. Every 10 min: emails stuck in SENDING
// past the stale window are marked FAILED (user sees the error and can
// retry); PENDING_SEND rows whose undo-window job was lost are re-dispatched
// (safe — actuallySend's atomic claim dedupes); scheduledEmails rows in
// SENDING are reconciled with their linked email.
crons.interval(
  "sweep-stuck-sends",
  { minutes: 10 },
  internal.emails.sweepStuckSends,
  {},
);

// ── Follow-up scan ──────────────────────────────────────────────────────────
// DISABLED 2026-07-08: runaway token burn — the scan re-drafted follow-ups
// continuously (~$0.005/draft, thousands of drafts within hours of the
// Anthropic balance being topped up; it had been failing silently on the
// empty balance before that). Re-enable only after the re-draft loop is
// fixed and per-run spend is capped.
// crons.interval(
//   "follow-up-scan",
//   { hours: 1 },
//   (internal.followUps as any).processFollowUpScans,
//   {},
// );

// ── AI cost alert ──────────────────────────────────────────────────────────
// Every 15 minutes, check per-feature spend over the last hour. If any feature
// exceeds the configured threshold an `aiCostAlerts` row is inserted (the UI
// surfaces these as a banner; out-of-band notifications are optional).
crons.interval(
  "ai-cost-alert-check",
  { minutes: 15 },
  internal.ai.costAlerts.runCheck,
  {},
);

// ── Old-mail purge ─────────────────────────────────────────────────────────
// Daily 3 AM UTC sweep of mail older than the retention window (3 years).
// Off by default — gated by env var ENABLE_OLD_EMAIL_CLEANUP=true inside the
// action so we can dry-run before enabling. Mail stays in Gmail/Outlook;
// only the local Convex copy is purged.
crons.daily(
  "purge-old-emails",
  { hourUTC: 3, minuteUTC: 0 },
  internal.sync.cleanup.purgeOldEmails,
  {},
);

// ── Orphan thread repair (flag-based, hourly) ───────────────────────────────
// Rebuilt 2026-06-15. Repairs ONLY threads flagged `needsRepair` (set when a
// thread row is created; cleared once email rows are confirmed), via the
// dedicated `by_account_needsRepair` index — no mailbox scan. The old version
// blind-scanned 500 threads/account every 10 min and cost ~102 GB I/O
// (≈60% of the whole team's budget); this touches only flagged threads.
crons.interval(
  "orphan-thread-repair",
  { minutes: 60 },
  internal.sync.gmail.repairOrphanThreads,
  {},
);

// ── Historical sync resume ─────────────────────────────────────────────────
// Self-heal: every 5 min, finds accounts whose historical backfill is stuck
// (IN_PROGRESS but lastBatchAt > 5 min old) and re-schedules the next chunk
// from the saved pageToken. Also kicks off the one-shot recipient-contact
// backfill for accounts whose historical sync has COMPLETED but contacts
// haven't been backfilled yet.
crons.interval(
  "historical-sync-resume",
  { minutes: 30 },
  internal.mailAccounts._resumeStalledHistorical,
  {},
);

// ── Retention purger ───────────────────────────────────────────────────────
// Daily sweep that hard-deletes threads past their per-user retention TTL
// in the Spam and Trash folders. Defaults are 30 days each; 0 = never.
crons.interval(
  "retention-purge",
  { hours: 24 },
  internal.retention._purgeAllExpired,
  {},
);

// ── Needs Response re-score ────────────────────────────────────────────────
// Daily sweep that re-scores open needsResponse signals older than 24h so
// stale items reflect any drift in urgency / deadlines. Bounded batch.
crons.interval(
  "needs-response-rescore",
  { hours: 24 },
  internal.needsResponse._rescoreStale,
  {},
);

// ── Body retention sweep ───────────────────────────────────────────────────
// Daily 2 AM UTC: drop emailBodies rows whose parent email is older than
// 14 days. Keeps subject/from/snippet so list views are untouched; bodies
// re-fetch lazily from Gmail/Outlook on open via ensureEmailBody. Always on —
// this is how we retroactively shrink the DB for mail synced before lazy
// bodies landed.
crons.daily(
  "strip-old-bodies",
  { hourUTC: 2, minuteUTC: 0 },
  internal.sync.bodyRetention.stripOldBodies,
  {},
);

// ── Attachment-blob retention ───────────────────────────────────────────────
// Daily 4 AM UTC: free attachment bytes cached into Convex storage more than
// 90 days ago, where the provider copy is re-fetchable. Same cache philosophy
// as strip-old-bodies.
crons.daily(
  "strip-old-attachment-blobs",
  { hourUTC: 4, minuteUTC: 0 },
  internal.sync.bodyRetention.stripOldAttachmentBlobs,
  {},
);

// ── ERP participant index ───────────────────────────────────────────────────
// Every 5 min: index new emails into emailParticipants (self-chains through
// backlog, so this also performs the one-time backfill). Powers the Choquer
// ERP client Vault email feed.
crons.interval(
  "erp-participant-index",
  { minutes: 5 },
  internal.erp.indexParticipants,
  {},
);


// ── Telemetry purge ────────────────────────────────────────────────────────
// Session recordings are a debugging aid, not an archive — drop anything past
// the retention window (7 days) so the table stays small and cheap.
crons.interval(
  "purge-telemetry",
  { hours: 24 },
  internal.telemetry.purgeOldTelemetry,
  {},
);

export default crons;
