// ─────────────────────────────────────────────────────────────────────────────
// legacySweep.ts — two one-time cost burn-downs (2026-07-10 spend incident).
//
// 1. sweepLegacyBodies: pre-migration email rows still carry bodyHtml/bodyText
//    IN-ROW (~77KB/doc vs ~1KB lean). Every read of such a doc — list
//    hydration, search enrichment, AI context, classification joins — paid
//    those bytes, forever. This walk preserves the content (searchText for
//    AI search; emailBodies row when inside the 90-day display window; the
//    provider refetch covers older display) and clears the in-row copies.
//
// 2. backfillClassifications: stamp accountId/threadId/receivedAt onto
//    emailClassifications rows so the category list paths never join through
//    the email doc. Run AFTER sweepLegacyBodies so this walk reads lean docs.
//
// Both are batched cursor walks that self-reschedule (storageSweep pattern).
// Kick off:
//   npx convex run sync/legacySweep:sweepLegacyBodies '{}' --prod
//   npx convex run sync/legacySweep:backfillClassifications '{}' --prod
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { upsertEmailSearchText } from "../lib/searchText";
import { computeInboxStamp } from "../lib/inboxStamp";

// Fat rows: keep batches small for the 16MB per-mutation read cap.
const BODY_BATCH = 20;
const DISPLAY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export const sweepLegacyBodies = internalAction({
  args: {
    cursor: v.optional(v.number()),
    totals: v.optional(v.object({ scanned: v.number(), cleared: v.number() })),
  },
  handler: async (ctx, { cursor, totals }) => {
    const res: { scanned: number; cleared: number; nextCursor?: number } =
      await ctx.runMutation(internal.sync.legacySweep._sweepBodyBatch, {
        cursor,
      });
    const running = {
      scanned: (totals?.scanned ?? 0) + res.scanned,
      cleared: (totals?.cleared ?? 0) + res.cleared,
    };
    if (res.scanned > 0 && res.nextCursor !== undefined) {
      await ctx.scheduler.runAfter(
        1_000,
        internal.sync.legacySweep.sweepLegacyBodies,
        { cursor: res.nextCursor, totals: running },
      );
      return { status: "continuing", ...running };
    }
    console.log(
      `[legacySweep] bodies done: ${running.scanned} scanned, ${running.cleared} in-row bodies cleared`,
    );
    return { status: "done", ...running };
  },
});

export const _sweepBodyBatch = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, { cursor }) => {
    const rows = await ctx.db
      .query("emails")
      .withIndex("by_creation_time", (q) =>
        cursor !== undefined ? q.gt("_creationTime", cursor) : q,
      )
      .order("asc")
      .take(BODY_BATCH);

    let cleared = 0;
    for (const e of rows) {
      if (!e.bodyHtml && !e.bodyText) continue; // already lean
      // Rows the send/draft pipelines still need in-row stay untouched:
      // drafts (compose edits read them) and unsent outbound (retry needs
      // the body). Rows without a providerMessageId aren't refetchable from
      // the provider, so their body is the only copy — keep it.
      if (e.isDraft) continue;
      if (e.sendStatus && e.sendStatus !== "SENT") continue;
      if (!e.providerMessageId) continue;

      // Preserve every word for AI search before clearing.
      await upsertEmailSearchText(ctx, {
        emailId: e._id,
        accountId: e.accountId,
        threadId: e.threadId,
        receivedAt: e.receivedAt,
        subject: e.subject,
        bodyText: e.bodyText,
        bodyHtml: e.bodyHtml,
      });

      // Recent mail keeps a display copy in emailBodies (the viewer reads
      // that table); older mail falls back to on-demand provider refetch.
      if (Date.now() - e.receivedAt < DISPLAY_WINDOW_MS) {
        const existingBody = await ctx.db
          .query("emailBodies")
          .withIndex("by_email", (q) => q.eq("emailId", e._id))
          .first();
        if (!existingBody) {
          await ctx.db.insert("emailBodies", {
            emailId: e._id,
            bodyText: e.bodyText,
            bodyHtml: e.bodyHtml,
          });
        }
      }

      await ctx.db.patch(e._id, { bodyHtml: undefined, bodyText: undefined });
      cleared++;
    }

    return {
      scanned: rows.length,
      cleared,
      nextCursor: rows.length > 0 ? rows[rows.length - 1]._creationTime : undefined,
    };
  },
});

// ── Inbox-stamp backfill (2026-07-10 read-cost fix) ─────────────────────────
// Stamps inboxAt/unreadInboxAt on every existing thread so the indexed inbox
// query can take over. New/updated threads are stamped by patchThread /
// stampedThreadInsert at write time.

const STAMP_BATCH = 250;

export const backfillInboxStamps = internalAction({
  args: {
    cursor: v.optional(v.number()),
    totals: v.optional(v.object({ scanned: v.number(), stamped: v.number() })),
  },
  handler: async (ctx, { cursor, totals }) => {
    const res: { scanned: number; stamped: number; nextCursor?: number } =
      await ctx.runMutation(internal.sync.legacySweep._stampBatch, { cursor });
    const running = {
      scanned: (totals?.scanned ?? 0) + res.scanned,
      stamped: (totals?.stamped ?? 0) + res.stamped,
    };
    if (res.scanned > 0 && res.nextCursor !== undefined) {
      await ctx.scheduler.runAfter(
        500,
        internal.sync.legacySweep.backfillInboxStamps,
        { cursor: res.nextCursor, totals: running },
      );
      return { status: "continuing", ...running };
    }
    console.log(
      `[legacySweep] inbox stamps done: ${running.scanned} scanned, ${running.stamped} stamped`,
    );
    return { status: "done", ...running };
  },
});

export const _stampBatch = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, { cursor }) => {
    const rows = await ctx.db
      .query("threads")
      .withIndex("by_creation_time", (q) =>
        cursor !== undefined ? q.gt("_creationTime", cursor) : q,
      )
      .order("asc")
      .take(STAMP_BATCH);
    let stamped = 0;
    for (const t of rows) {
      const stamp = computeInboxStamp(t);
      if (
        (t.inboxAt ?? undefined) !== stamp.inboxAt ||
        (t.unreadInboxAt ?? undefined) !== stamp.unreadInboxAt
      ) {
        await ctx.db.patch(t._id, stamp);
        stamped++;
      }
    }
    return {
      scanned: rows.length,
      stamped,
      nextCursor: rows.length > 0 ? rows[rows.length - 1]._creationTime : undefined,
    };
  },
});

// Sanity check before/after switching queries to the sticker indexes: counts
// threads whose stored stamp disagrees with a fresh computation. Must be 0.
//   npx convex run sync/legacySweep:_verifyStamps '{}' --prod
export const _verifyStamps = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("threads").order("desc").take(2000);
    let mismatched = 0;
    let inboxCount = 0;
    for (const t of rows) {
      const stamp = computeInboxStamp(t);
      if (
        (t.inboxAt ?? undefined) !== stamp.inboxAt ||
        (t.unreadInboxAt ?? undefined) !== stamp.unreadInboxAt
      ) {
        mismatched++;
      }
      if (stamp.inboxAt !== undefined) inboxCount++;
    }
    return { checked: rows.length, mismatched, inboxCount };
  },
});

// ── Classification purge (2026-07-10: category feature deleted) ─────────────
// Deletes every emailClassifications row. The classifier no longer runs on
// new mail, list paths no longer read the table, and the UI is removed —
// this clears the stored data per Bryce's "delete it altogether".

const PURGE_BATCH = 400;

export const purgeClassifications = internalAction({
  args: {
    totals: v.optional(v.object({ deleted: v.number() })),
  },
  handler: async (ctx, { totals }) => {
    const res: { deleted: number } = await ctx.runMutation(
      internal.sync.legacySweep._purgeClsBatch,
      {},
    );
    const running = { deleted: (totals?.deleted ?? 0) + res.deleted };
    if (res.deleted > 0) {
      await ctx.scheduler.runAfter(
        500,
        internal.sync.legacySweep.purgeClassifications,
        { totals: running },
      );
      return { status: "continuing", ...running };
    }
    console.log(`[legacySweep] classifications purged: ${running.deleted} rows`);
    return { status: "done", ...running };
  },
});

export const _purgeClsBatch = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("emailClassifications")
      .withIndex("by_creation_time", (q) => q)
      .order("asc")
      .take(PURGE_BATCH);
    for (const r of rows) {
      await ctx.db.delete(r._id);
    }
    return { deleted: rows.length };
  },
});

// ── Classification denorm backfill ──────────────────────────────────────────
// OBSOLETE (2026-07-10): superseded by purgeClassifications the same day the
// backfill shipped — the category feature was deleted outright. Kept so an
// in-flight chained run terminates cleanly (it stops once rows are gone).

const CLS_BATCH = 100;

export const backfillClassifications = internalAction({
  args: {
    cursor: v.optional(v.number()),
    totals: v.optional(v.object({ scanned: v.number(), stamped: v.number() })),
  },
  handler: async (ctx, { cursor, totals }) => {
    const res: { scanned: number; stamped: number; nextCursor?: number } =
      await ctx.runMutation(internal.sync.legacySweep._backfillClsBatch, {
        cursor,
      });
    const running = {
      scanned: (totals?.scanned ?? 0) + res.scanned,
      stamped: (totals?.stamped ?? 0) + res.stamped,
    };
    if (res.scanned > 0 && res.nextCursor !== undefined) {
      await ctx.scheduler.runAfter(
        1_000,
        internal.sync.legacySweep.backfillClassifications,
        { cursor: res.nextCursor, totals: running },
      );
      return { status: "continuing", ...running };
    }
    console.log(
      `[legacySweep] classifications done: ${running.scanned} scanned, ${running.stamped} stamped`,
    );
    return { status: "done", ...running };
  },
});

export const _backfillClsBatch = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, { cursor }) => {
    const rows = await ctx.db
      .query("emailClassifications")
      .withIndex("by_creation_time", (q) =>
        cursor !== undefined ? q.gt("_creationTime", cursor) : q,
      )
      .order("asc")
      .take(CLS_BATCH);

    let stamped = 0;
    for (const c of rows) {
      if (c.accountId && c.threadId && c.receivedAt !== undefined) continue;
      const email = await ctx.db.get(c.emailId);
      if (!email) continue;
      await ctx.db.patch(c._id, {
        accountId: email.accountId,
        threadId: email.threadId,
        receivedAt: email.receivedAt,
      });
      stamped++;
    }

    return {
      scanned: rows.length,
      stamped,
      nextCursor: rows.length > 0 ? rows[rows.length - 1]._creationTime : undefined,
    };
  },
});
