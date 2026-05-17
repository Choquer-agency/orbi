// One-shot backfill: for every existing inbound email that doesn't yet
// have a needsResponseSignal, queue up scoring. Bounded per run; the action
// re-schedules itself if there's more to do. ~$0.40 to score 9k emails.

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const SCAN_BATCH = 50;
const SCORE_DELAY_SPACING_MS = 1500;

export const _findUnscoredInbound = internalQuery({
  args: {
    userId: v.id("users"),
    afterReceivedAt: v.optional(v.number()),
    limit: v.number(),
  },
  handler: async (ctx, { userId, afterReceivedAt, limit }) => {
    const accts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const selfEmails = new Set(
      accts.flatMap((a) => [
        a.email.toLowerCase().trim(),
        ...(a.aliases ?? []).map((al) => al.toLowerCase().trim()),
      ]),
    );

    const out: Array<{ emailId: Id<"emails">; receivedAt: number }> = [];
    for (const a of accts) {
      const remaining = limit - out.length;
      if (remaining <= 0) break;
      const emails = await ctx.db
        .query("emails")
        .withIndex("by_account_receivedAt", (q) =>
          afterReceivedAt !== undefined
            ? q.eq("accountId", a._id).lt("receivedAt", afterReceivedAt)
            : q.eq("accountId", a._id),
        )
        .order("desc")
        .take(remaining * 4);
      for (const e of emails) {
        if (selfEmails.has(e.fromAddress.toLowerCase().trim())) continue;
        const existing = await ctx.db
          .query("needsResponseSignals")
          .withIndex("by_email", (q) => q.eq("emailId", e._id))
          .unique();
        if (existing) continue;
        out.push({ emailId: e._id, receivedAt: e.receivedAt });
        if (out.length >= limit) break;
      }
    }
    return out;
  },
});

export const _firstUser = internalQuery({
  args: {},
  handler: async (ctx) => {
    const u = await ctx.db.query("users").take(1);
    return u[0]?._id ?? null;
  },
});

// Internal chunk processor — schedules SCAN_BATCH score jobs, then
// schedules itself again if there's more history to walk. Self-pacing.
export const _runChunk = internalAction({
  args: {
    userId: v.id("users"),
    afterReceivedAt: v.optional(v.number()),
  },
  handler: async (ctx, { userId, afterReceivedAt }) => {
    const targets = (await ctx.runQuery(
      internal.admin.backfillNeedsResponse._findUnscoredInbound,
      { userId, afterReceivedAt, limit: SCAN_BATCH },
    )) as Array<{ emailId: Id<"emails">; receivedAt: number }>;
    if (targets.length === 0) return { queued: 0, more: false };

    for (let i = 0; i < targets.length; i++) {
      await ctx.scheduler.runAfter(
        i * SCORE_DELAY_SPACING_MS,
        internal.ai.needsResponse.scoreEmail,
        { emailId: targets[i].emailId, userId },
      );
    }

    // Schedule the next chunk shortly after the last queued scoring slot
    // so we don't pile thousands of concurrent classifications.
    const nextCursor = targets[targets.length - 1].receivedAt;
    await ctx.scheduler.runAfter(
      targets.length * SCORE_DELAY_SPACING_MS + 5_000,
      internal.admin.backfillNeedsResponse._runChunk,
      { userId, afterReceivedAt: nextCursor },
    );
    return { queued: targets.length, more: true };
  },
});

// Public entry point — call this once from the CLI / a button to kick off
// the full backfill. The internal chunk processor handles the rest.
export const start = action({
  args: { userId: v.optional(v.id("users")) },
  handler: async (ctx, args): Promise<{ ok: true; userId: Id<"users"> }> => {
    const userId =
      args.userId ??
      ((await ctx.runQuery(
        internal.admin.backfillNeedsResponse._firstUser,
        {},
      )) as Id<"users"> | null);
    if (!userId) throw new Error("No user found");
    await ctx.scheduler.runAfter(
      0,
      internal.admin.backfillNeedsResponse._runChunk,
      { userId, afterReceivedAt: undefined },
    );
    return { ok: true, userId };
  },
});
