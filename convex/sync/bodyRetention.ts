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
const BATCH_SIZE = 500; // Bounds DB writes per cron tick.

export const stripOldBodies = internalAction({
  args: {},
  handler: async (ctx) => {
    const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const deleted: number = await ctx.runMutation(
      internal.sync.bodyRetention._stripBatch,
      { cutoffMs, batchSize: BATCH_SIZE },
    );
    // More bodies left to strip — keep going. Tight enough loop that a heavy
    // initial backlog gets processed within a few hours instead of waiting
    // 24 h between batches.
    if (deleted >= BATCH_SIZE) {
      await ctx.scheduler.runAfter(
        30_000,
        internal.sync.bodyRetention.stripOldBodies,
        {},
      );
    }
    return { deleted };
  },
});

// Mutation that does the actual work. Picks one batch of emailBodies whose
// parent email is older than `cutoffMs`, then deletes the body rows. Storage
// blobs referenced by inline attachments are NOT touched — those live in a
// separate table that the user controls via the regular attachment lifecycle.
export const _stripBatch = internalMutation({
  args: { cutoffMs: v.number(), batchSize: v.number() },
  handler: async (ctx, { cutoffMs, batchSize }) => {
    // We don't have an index on emailBodies by parent receivedAt. The cheapest
    // viable scan: walk emailBodies in insertion order, check the parent
    // email row, delete when old enough. Stop after we've examined `batchSize`
    // candidates (NOT after `batchSize` deletes) so we don't get stuck on a
    // run of already-stripped rows.
    const candidates = await ctx.db.query("emailBodies").take(batchSize);
    let deleted = 0;
    for (const body of candidates) {
      const email = await ctx.db.get(body.emailId);
      if (!email) {
        // Orphaned body row — the email was deleted but the body lingered.
        // Drop it.
        await ctx.db.delete(body._id);
        deleted++;
        continue;
      }
      if (email.receivedAt < cutoffMs) {
        await ctx.db.delete(body._id);
        deleted++;
      }
    }
    return deleted;
  },
});
