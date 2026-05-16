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

export default crons;
