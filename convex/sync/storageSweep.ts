// ─────────────────────────────────────────────────────────────────────────────
// storageSweep.ts — one-time storage burn-down for the emailBodies table.
//
// For every existing emailBodies row:
//   1. Distill subject + body into `emailSearchText` (the permanent
//      every-word search store) — free, no provider calls.
//   2. Drop the derived bodyHtmlClean / bodyHtmlTrimmed copies, which
//      roughly tripled row size. The viewer sanitizes client-side.
//
// The 90-day retention cron (bodyRetention.ts) then deletes whole rows past
// the window on its nightly walk. Together these take the 17.25GB table down
// to a rolling ~1-2GB.
//
// Batched cursor walk over emailBodies._creationTime; self-reschedules until
// done. Body rows are byte-heavy (100KB–1MB+), so batches stay small to
// respect Convex's 16MB per-mutation read cap. Kick off with:
//   npx convex run sync/storageSweep:sweepBodies '{}'
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { upsertEmailSearchText } from "../lib/searchText";

const BATCH_SIZE = 8;

export const sweepBodies = internalAction({
  args: {
    cursor: v.optional(v.number()),
    totals: v.optional(
      v.object({ processed: v.number(), copiesCleared: v.number() }),
    ),
  },
  handler: async (ctx, { cursor, totals }) => {
    const res: {
      processed: number;
      copiesCleared: number;
      nextCursor?: number;
    } = await ctx.runMutation(internal.sync.storageSweep._sweepBatch, {
      cursor,
    });
    const runningTotals = {
      processed: (totals?.processed ?? 0) + res.processed,
      copiesCleared: (totals?.copiesCleared ?? 0) + res.copiesCleared,
    };
    if (res.processed > 0 && res.nextCursor !== undefined) {
      await ctx.scheduler.runAfter(
        1_000,
        internal.sync.storageSweep.sweepBodies,
        { cursor: res.nextCursor, totals: runningTotals },
      );
      return { status: "continuing", ...runningTotals };
    }
    console.log(
      `[storageSweep] done: ${runningTotals.processed} bodies processed, ` +
        `${runningTotals.copiesCleared} derived copies cleared`,
    );
    return { status: "done", ...runningTotals };
  },
});

export const _sweepBatch = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, { cursor }) => {
    const rows = await ctx.db
      .query("emailBodies")
      .withIndex("by_creation_time", (q) =>
        cursor !== undefined ? q.gt("_creationTime", cursor) : q,
      )
      .order("asc")
      .take(BATCH_SIZE);

    let copiesCleared = 0;
    for (const row of rows) {
      const email = await ctx.db.get(row.emailId);
      if (email) {
        await upsertEmailSearchText(ctx, {
          emailId: email._id,
          accountId: email.accountId,
          threadId: email.threadId,
          receivedAt: email.receivedAt,
          subject: email.subject,
          bodyText: row.bodyText,
          bodyHtml: row.bodyHtml,
        });
      }
      if (
        row.bodyHtmlClean !== undefined ||
        row.bodyHtmlTrimmed !== undefined
      ) {
        await ctx.db.patch(row._id, {
          bodyHtmlClean: undefined,
          bodyHtmlTrimmed: undefined,
        });
        copiesCleared++;
      }
    }

    return {
      processed: rows.length,
      copiesCleared,
      nextCursor:
        rows.length > 0 ? rows[rows.length - 1]._creationTime : undefined,
    };
  },
});
