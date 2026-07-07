// ─────────────────────────────────────────────────────────────────────────────
// bodyRetention.ts — Strip email display HTML older than the retention window.
//
// Display HTML is a short-lived cache: 17GB of stored bodies (up to 4 copies
// each, kept 2 years) is what got the team's free plan disabled on 2026-07-06.
// Searchability does NOT depend on this window — every email's plain text
// lives permanently in `emailSearchText`, captured here right before the
// delete. If the user opens an old message, `ensureEmailBody` re-fetches the
// HTML from Gmail/Outlook in ~1s and re-inserts it (until the next sweep).
//
// Shape: a cursor walk. Each nightly run starts at {accountIdx: 0} and
// advances (accountIdx, afterReceivedAt) across every account's sub-cutoff
// mail via self-reschedules until the whole backlog is visited. The previous
// version restarted at the oldest emails every pass and stopped on the first
// empty batch — so bodies past the first body-less stretch were never
// reached.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { upsertEmailSearchText } from "../lib/searchText";

const RETENTION_DAYS = 90;
// Lean email rows scanned per mutation (a few KB each — cheap).
const SCAN_LIMIT = 150;
// Body rows deleted per mutation. These are the byte-heavy reads (100KB–1MB+
// each), so keep the per-mutation total far below Convex's 16MB read cap.
const MAX_DELETES = 8;

export const stripOldBodies = internalAction({
  args: {
    accountIdx: v.optional(v.number()),
    afterReceivedAt: v.optional(v.number()),
  },
  handler: async (ctx, { accountIdx = 0, afterReceivedAt }) => {
    const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const res: {
      done: boolean;
      deleted: number;
      accountDone: boolean;
      nextAfter?: number;
    } = await ctx.runMutation(internal.sync.bodyRetention._stripBatch, {
      cutoffMs,
      accountIdx,
      afterReceivedAt,
    });
    if (res.done) {
      // Phase B: on-demand refetches re-insert body rows for mail BEHIND the
      // watermark. Sweep emailBodies rows created in the last 48h (tiny set)
      // and strip any whose parent email is older than the cutoff.
      await ctx.scheduler.runAfter(
        1_000,
        internal.sync.bodyRetention._stripRecentRefetches,
        {},
      );
      return { done: true };
    }
    if (res.accountDone) {
      await ctx.scheduler.runAfter(
        2_000,
        internal.sync.bodyRetention.stripOldBodies,
        { accountIdx: accountIdx + 1 },
      );
    } else {
      await ctx.scheduler.runAfter(
        2_000,
        internal.sync.bodyRetention.stripOldBodies,
        { accountIdx, afterReceivedAt: res.nextAfter },
      );
    }
    return { deleted: res.deleted };
  },
});

export const _stripBatch = internalMutation({
  args: {
    cutoffMs: v.number(),
    accountIdx: v.number(),
    afterReceivedAt: v.optional(v.number()),
  },
  handler: async (ctx, { cutoffMs, accountIdx, afterReceivedAt }) => {
    const accounts = await ctx.db.query("mailAccounts").collect();
    if (accountIdx >= accounts.length) {
      return { done: true, deleted: 0, accountDone: true };
    }
    const acc = accounts[accountIdx];
    // Watermark: everything below bodyStripBefore was confirmed stripped on
    // a previous night — start there instead of re-walking the entire
    // sub-cutoff history every run. (On-demand refetches of old mail create
    // body rows BEHIND the watermark; those are handled by the recent-rows
    // sweep in _stripRecentRefetches, not by moving the watermark back.)
    const startAt = afterReceivedAt ?? acc.bodyStripBefore ?? undefined;
    const rows = await ctx.db
      .query("emails")
      .withIndex("by_account_receivedAt", (q) => {
        const base = q.eq("accountId", acc._id);
        const withLower =
          startAt !== undefined ? base.gt("receivedAt", startAt) : base;
        return withLower.lt("receivedAt", cutoffMs);
      })
      .order("asc")
      .take(SCAN_LIMIT);

    let deleted = 0;
    let lastReceivedAt: number | undefined;
    let scanned = 0;
    for (const email of rows) {
      scanned++;
      lastReceivedAt = email.receivedAt;
      const body = await ctx.db
        .query("emailBodies")
        .withIndex("by_email", (q) => q.eq("emailId", email._id))
        .unique();
      if (body) {
        // Last chance to distill the searchable text before the HTML goes.
        await upsertEmailSearchText(ctx, {
          emailId: email._id,
          accountId: email.accountId,
          threadId: email.threadId,
          receivedAt: email.receivedAt,
          subject: email.subject,
          bodyText: body.bodyText,
          bodyHtml: body.bodyHtml,
        });
        await ctx.db.delete(body._id);
        deleted++;
      }
      // Clear any legacy in-row body fields the migration left behind.
      if (
        email.bodyHtml ||
        email.bodyText ||
        email.bodyHtmlClean ||
        email.bodyHtmlTrimmed
      ) {
        if (!body) {
          await upsertEmailSearchText(ctx, {
            emailId: email._id,
            accountId: email.accountId,
            threadId: email.threadId,
            receivedAt: email.receivedAt,
            subject: email.subject,
            bodyText: email.bodyText,
            bodyHtml: email.bodyHtml,
          });
        }
        await ctx.db.patch(email._id, {
          bodyHtml: undefined,
          bodyText: undefined,
          bodyHtmlClean: undefined,
          bodyHtmlTrimmed: undefined,
        });
        deleted++;
      }
      if (deleted >= MAX_DELETES) break;
    }

    const accountDone = scanned === rows.length && rows.length < SCAN_LIMIT;
    if (accountDone) {
      // Everything below tonight's cutoff is now confirmed stripped —
      // remember it so tomorrow's walk only covers one new day of mail.
      // (Once-nightly account write; no cache concern.)
      if ((acc.bodyStripBefore ?? 0) < cutoffMs) {
        await ctx.db.patch(acc._id, { bodyStripBefore: cutoffMs });
      }
    }
    return {
      done: false,
      deleted,
      accountDone,
      nextAfter: lastReceivedAt,
    };
  },
});

// Phase B of the nightly walk: emailBodies rows CREATED recently (on-demand
// refetches of old mail, body-on-arrival rows for mail that just aged past
// the cutoff) sit behind the per-account watermark, so the main walk never
// revisits them. This sweep covers them by creation time instead — the last
// 48h of body-row inserts is a small, bounded set.
export const _stripRecentRefetches = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, { cursor }) => {
    const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const windowStart = cursor ?? Date.now() - 48 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("emailBodies")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", windowStart))
      .order("asc")
      .take(MAX_DELETES);
    let deleted = 0;
    let reachedGrace = false;
    // Grace period: leave bodies fetched in the last 24h alone — the user is
    // probably still reading that thread; it gets stripped tomorrow night.
    // Rows are creation-ordered, so everything past the boundary is fresher:
    // stop instead of scanning (each row here is a full fat body read).
    const graceBefore = Date.now() - 24 * 60 * 60 * 1000;
    for (const body of rows) {
      if (body._creationTime > graceBefore) {
        reachedGrace = true;
        break;
      }
      const email = await ctx.db.get(body.emailId);
      if (email && email.receivedAt < cutoffMs) {
        await upsertEmailSearchText(ctx, {
          emailId: email._id,
          accountId: email.accountId,
          threadId: email.threadId,
          receivedAt: email.receivedAt,
          subject: email.subject,
          bodyText: body.bodyText,
          bodyHtml: body.bodyHtml,
        });
        await ctx.db.delete(body._id);
        deleted++;
      }
    }
    if (!reachedGrace && rows.length === MAX_DELETES) {
      await ctx.scheduler.runAfter(
        1_000,
        internal.sync.bodyRetention._stripRecentRefetches,
        { cursor: rows[rows.length - 1]._creationTime },
      );
    }
    return { deleted };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Attachment-blob retention (same philosophy as bodies): bytes cached into
// Convex storage on first view are a re-fetchable cache — Gmail/Outlook hold
// the original. Free caches older than the window, but ONLY when
// providerAttachmentId exists (without it, e.g. our own sent uploads, the
// blob is the only copy — never delete those). Nightly batched walk of the
// lean attachments table.
// ─────────────────────────────────────────────────────────────────────────────

const ATTACHMENT_RETENTION_DAYS = 90;
const ATTACHMENT_BATCH = 50;

export const stripOldAttachmentBlobs = internalMutation({
  args: { cursor: v.optional(v.number()) },
  handler: async (ctx, { cursor }) => {
    const cutoffMs = Date.now() - ATTACHMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("attachments")
      .withIndex("by_creation_time", (q) =>
        cursor !== undefined ? q.gt("_creationTime", cursor) : q,
      )
      .order("asc")
      .take(ATTACHMENT_BATCH);
    let freed = 0;
    for (const att of rows) {
      if (!att.storageId) continue;
      if (!att.providerAttachmentId) continue; // not re-fetchable — keep
      const cachedAt = att.storageCachedAt ?? att._creationTime;
      if (cachedAt >= cutoffMs) continue;
      try {
        await ctx.storage.delete(att.storageId);
      } catch {
        /* already gone */
      }
      await ctx.db.patch(att._id, {
        storageId: undefined,
        storageCachedAt: undefined,
      });
      freed++;
    }
    if (rows.length === ATTACHMENT_BATCH) {
      await ctx.scheduler.runAfter(
        2_000,
        internal.sync.bodyRetention.stripOldAttachmentBlobs,
        { cursor: rows[rows.length - 1]._creationTime },
      );
    }
    return { freed };
  },
});
