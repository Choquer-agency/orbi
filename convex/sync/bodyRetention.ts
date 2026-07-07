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
    if (res.done) return { done: true };
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
    const rows = await ctx.db
      .query("emails")
      .withIndex("by_account_receivedAt", (q) => {
        const base = q.eq("accountId", acc._id);
        const withLower =
          afterReceivedAt !== undefined
            ? base.gt("receivedAt", afterReceivedAt)
            : base;
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

    return {
      done: false,
      deleted,
      // Whole page consumed and it was short → this account's backlog is
      // finished; move on. Broke early on MAX_DELETES → resume from cursor.
      accountDone: scanned === rows.length && rows.length < SCAN_LIMIT,
      nextAfter: lastReceivedAt,
    };
  },
});
