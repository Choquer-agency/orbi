// ─────────────────────────────────────────────────────────────────────────────
// bodyRetention.ts — Strip email bodies older than the retention window.
//
// Why: the lazy-body sync (convex/sync/onDemandBody.ts) stops fetching bodies
// for new mail, but every email already in the DB still has its full body
// stored in `emailBodies`. This cron retroactively shrinks the table by
// deleting body rows whose parent email is older than 14 days. The
// `emails` row (subject, from, snippet) stays intact — list views still
// show everything. If the user opens an old message the existing
// `ensureEmailBody` action re-fetches the body from Gmail/Outlook on
// demand and re-inserts it.
//
// Idempotent + batched. Runs nightly via convex/crons.ts. Always-on (unlike
// the harder cleanup cron that deletes whole emails).
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";

// 14 days is the sweet spot for an agency workflow: active threads still
// have instant-open bodies; mail older than two weeks is rare to revisit and
// fast-enough to re-fetch when needed.
const RETENTION_DAYS = 14;
// emailBodies rows can be 100-500 KB each (full marketing-email HTML), so a
// 500-row take() trivially blows Convex's 16 MB byte cap. Keep this small
// and reschedule aggressively until the backlog clears.
const BATCH_SIZE = 25;

export const stripOldBodies = internalAction({
  args: {},
  handler: async (ctx) => {
    const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const deleted: number = await ctx.runMutation(
      internal.sync.bodyRetention._stripBatch,
      { cutoffMs, batchSize: BATCH_SIZE },
    );
    // Always reschedule until a batch returns 0 — even when this batch hit
    // the BATCH_SIZE cap. We tick every 5 seconds during backlog burn-down
    // so 3000+ legacy bodies get cleared within ~15-20 minutes.
    if (deleted > 0) {
      await ctx.scheduler.runAfter(
        5_000,
        internal.sync.bodyRetention.stripOldBodies,
        {},
      );
    }
    return { deleted };
  },
});

// Walks `emails` by ascending receivedAt — i.e. oldest first — looking up
// the sibling emailBodies row and deleting any that fall outside the
// retention window. Also drops legacy in-row body fields on the parent
// (`emails.bodyHtml` etc) which were left around by the migration.
//
// We can't query `emailBodies` directly because its _creationTime reflects
// the migration timestamp, not the email's age. The emails table has a
// proper index on receivedAt that we use here.
export const _stripBatch = internalMutation({
  args: { cutoffMs: v.number(), batchSize: v.number() },
  handler: async (ctx, { cutoffMs, batchSize }) => {
    // Find candidate email rows — accountId is the leading index field, so
    // we have to iterate per account. Each account scan reads at most
    // batchSize rows worth of bytes; emails table is tiny once bodies are
    // moved off.
    const accounts = await ctx.db.query("mailAccounts").collect();
    let deleted = 0;
    for (const acc of accounts) {
      if (deleted >= batchSize) break;
      const oldEmails = await ctx.db
        .query("emails")
        .withIndex("by_account_receivedAt", (q) =>
          q.eq("accountId", acc._id).lt("receivedAt", cutoffMs),
        )
        .order("asc")
        .take(Math.min(batchSize - deleted, 50));
      for (const email of oldEmails) {
        const body = await ctx.db
          .query("emailBodies")
          .withIndex("by_email", (q) => q.eq("emailId", email._id))
          .unique();
        if (body) {
          await ctx.db.delete(body._id);
          deleted++;
        }
        // Also clear any legacy in-row body fields the migration left behind.
        if (
          email.bodyHtml ||
          email.bodyText ||
          email.bodyHtmlClean ||
          email.bodyHtmlTrimmed
        ) {
          await ctx.db.patch(email._id, {
            bodyHtml: undefined,
            bodyText: undefined,
            bodyHtmlClean: undefined,
            bodyHtmlTrimmed: undefined,
          });
          // Count the legacy-clear as work too so the scheduler keeps
          // ticking. Otherwise an account with all bodies-in-row but no
          // sibling rows would stop after one pass.
          if (!body) deleted++;
        }
      }
    }
    return deleted;
  },
});
