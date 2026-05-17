// ─────────────────────────────────────────────────────────────────────────────
// cleanup.ts — Periodic deletion of mail older than the retention window.
//
// The user's mail still lives in Gmail / Outlook on the provider. We're only
// purging it from Convex so the DB stays small and the data-egress bill stays
// bounded. Mirrors the 3-year cap that historical sync uses for the initial
// pull, so a freshly connected account and a long-lived account converge to
// the same set of stored mail.
//
// Gated by env var ENABLE_OLD_EMAIL_CLEANUP=true. Off by default — flip on
// after confirming the rest of the egress reductions are stable.
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";

const RETENTION_YEARS = 3;
const BATCH_SIZE = 500; // Bounds DB writes per cron tick.

export const purgeOldEmails = internalAction({
  args: {},
  handler: async (ctx) => {
    if (process.env.ENABLE_OLD_EMAIL_CLEANUP !== "true") {
      return { skipped: true, reason: "cleanup disabled" };
    }
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - RETENTION_YEARS);
    const cutoffMs = cutoff.getTime();

    const deleted: number = await ctx.runMutation(
      internal.sync.cleanup._purgeBatch,
      { cutoffMs, batchSize: BATCH_SIZE },
    );

    // If we hit the batch cap there's likely more to delete. Schedule another
    // tick a minute out instead of stuffing it all into one mutation.
    if (deleted >= BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        60_000,
        internal.sync.cleanup.purgeOldEmails,
        {},
      );
    }
    return { deleted };
  },
});

export const _purgeBatch = internalMutation({
  args: { cutoffMs: v.number(), batchSize: v.number() },
  handler: async (ctx, { cutoffMs, batchSize }) => {
    // Scan by createdAt-ish using the receivedAt-indexed table. We scan a
    // bounded slice ordered by receivedAt ascending and stop at the first
    // row >= cutoffMs.
    const oldEmails = await ctx.db
      .query("emails")
      .withIndex("by_account_receivedAt")
      .order("asc")
      .filter((q) => q.lt(q.field("receivedAt"), cutoffMs))
      .take(batchSize);

    if (oldEmails.length === 0) return 0;

    const touchedThreadIds = new Set<Id<"threads">>();
    for (const email of oldEmails) {
      touchedThreadIds.add(email.threadId);

      // Sibling tables that reference this email.
      const body = await ctx.db
        .query("emailBodies")
        .withIndex("by_email", (q) => q.eq("emailId", email._id))
        .unique();
      if (body) await ctx.db.delete(body._id);

      const attachments = await ctx.db
        .query("attachments")
        .withIndex("by_email", (q) => q.eq("emailId", email._id))
        .collect();
      for (const a of attachments) {
        // Best-effort delete of the storage blob too.
        if (a.storageId) {
          try {
            await ctx.storage.delete(a.storageId);
          } catch {
            // Storage delete is best-effort; the row goes either way.
          }
        }
        await ctx.db.delete(a._id);
      }

      const classification = await ctx.db
        .query("emailClassifications")
        .withIndex("by_email", (q) => q.eq("emailId", email._id))
        .unique();
      if (classification) await ctx.db.delete(classification._id);

      await ctx.db.delete(email._id);
    }

    // Drop any thread that no longer has remaining emails. Keep threads
    // around if even one email survived the cutoff (the thread might span
    // years).
    for (const threadId of touchedThreadIds) {
      const remaining = await ctx.db
        .query("emails")
        .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", threadId))
        .first();
      if (!remaining) {
        // No emails left — purge thread + thread-scoped siblings.
        const thread = await ctx.db.get(threadId);
        if (thread) await ctx.db.delete(threadId);
        const comments = await ctx.db
          .query("threadComments")
          .withIndex("by_thread", (q) => q.eq("threadId", threadId))
          .collect();
        for (const c of comments) await ctx.db.delete(c._id);
      }
    }

    return oldEmails.length;
  },
});
