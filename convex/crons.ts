import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// ── Email sync ──────────────────────────────────────────────────────────────
// Both providers do an incremental delta sync every minute.
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

// ── Scheduled-send dispatch ─────────────────────────────────────────────────
// Picks up scheduledEmails with status="SCHEDULED" and sendAt <= now.
crons.interval(
  "scheduled-send-dispatch",
  { minutes: 1 },
  internal.scheduledEmails.processDueScheduledEmails,
  {},
);

// ── Follow-up scan ──────────────────────────────────────────────────────────
// Hourly scan of followUpWatches: detect replies, advance steps, draft
// follow-ups via Claude when needed.
crons.interval(
  "follow-up-scan",
  { hours: 1 },
  (internal.followUps as any).processFollowUpScans,
  {},
);

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

// ── Orphan thread repair ────────────────────────────────────────────────────
// Self-heal: every 10 min, finds threads that ended up with 0 email rows
// (sync chunk hiccups, parser failures, etc.) and refetches them from Gmail.
// Bounded to ORPHAN_REPAIR_BATCH per run so it never starves other crons.
crons.interval(
  "orphan-thread-repair",
  { minutes: 10 },
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
  { minutes: 5 },
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

export default crons;
