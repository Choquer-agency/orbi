// One-shot two-phase refresh:
//   Phase 1 — dismiss every open needsResponseSignal whose underlying email
//             is older than 90 days. (Effectively "don't bother me about old
//             stuff.")
//   Phase 2 — for every inbound email received in the last 90 days, queue a
//             rescore so the smarter, alias-aware scorer gets a fresh look.
// Both phases self-chain via the scheduler so a giant inbox doesn't blow
// any per-call limit.

import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

// ─── Phase 1: dismiss old open signals ─────────────────────────────────────

const DISMISS_BATCH = 100;

export const _dismissOldChunk = internalMutation({
  args: { cutoff: v.number(), afterCreationTime: v.optional(v.number()) },
  handler: async (ctx, { cutoff, afterCreationTime }) => {
    const all = await ctx.db.query("needsResponseSignals").take(DISMISS_BATCH * 3);
    let processed = 0;
    let dismissed = 0;
    let lastCreation = afterCreationTime ?? 0;
    for (const s of all) {
      if (afterCreationTime !== undefined && s._creationTime <= afterCreationTime) continue;
      processed++;
      lastCreation = s._creationTime;
      if (s.dismissedAt !== undefined) continue;
      const email = await ctx.db.get(s.emailId);
      if (!email) {
        // Orphan: just delete.
        await ctx.db.delete(s._id);
        dismissed++;
      } else if (email.receivedAt < cutoff) {
        await ctx.db.patch(s._id, { dismissedAt: Date.now() });
        dismissed++;
      }
      if (processed >= DISMISS_BATCH) break;
    }
    return {
      scanned: processed,
      dismissed,
      lastCreation,
      done: processed < DISMISS_BATCH,
    };
  },
});

export const _dismissOldLoop = internalAction({
  args: { cutoff: v.number() },
  handler: async (ctx, { cutoff }): Promise<{ totalDismissed: number }> => {
    let cursor: number | undefined = undefined;
    let totalDismissed = 0;
    let rounds = 0;
    while (rounds < 200) {
      const r = (await ctx.runMutation(
        internal.admin.refresh3Months._dismissOldChunk,
        { cutoff, afterCreationTime: cursor },
      )) as { scanned: number; dismissed: number; lastCreation: number; done: boolean };
      totalDismissed += r.dismissed;
      rounds++;
      if (r.done || r.scanned === 0) break;
      cursor = r.lastCreation;
    }
    return { totalDismissed };
  },
});

// ─── Phase 2: rescore recent emails ────────────────────────────────────────
// Scheduled in chunks of 25 with 1.5s spacing per email to stay under
// Anthropic rate limits. Self-reschedules across days of receivedAt.

const RESCORE_BATCH = 25;
const SPACING_MS = 1500;

export const _findRecentInbound = internalQuery({
  args: {
    userId: v.id("users"),
    sinceReceivedAt: v.number(),
    beforeReceivedAt: v.optional(v.number()),
    limit: v.number(),
  },
  handler: async (ctx, { userId, sinceReceivedAt, beforeReceivedAt, limit }) => {
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
      // Index supports eq+lt; the sinceReceivedAt lower bound is enforced
      // in JS after the index read since chaining gte after lt isn't part
      // of the IndexRange shape.
      const emails = await ctx.db
        .query("emails")
        .withIndex("by_account_receivedAt", (q) =>
          beforeReceivedAt !== undefined
            ? q.eq("accountId", a._id).lt("receivedAt", beforeReceivedAt)
            : q.eq("accountId", a._id),
        )
        .order("desc")
        .take(remaining * 4);
      for (const e of emails) {
        if (e.receivedAt < sinceReceivedAt) continue;
        if (selfEmails.has(e.fromAddress.toLowerCase().trim())) continue;
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

export const _rescoreRecentChunk = internalAction({
  args: {
    userId: v.id("users"),
    sinceReceivedAt: v.number(),
    beforeReceivedAt: v.optional(v.number()),
  },
  handler: async (ctx, { userId, sinceReceivedAt, beforeReceivedAt }) => {
    const targets = (await ctx.runQuery(
      internal.admin.refresh3Months._findRecentInbound,
      { userId, sinceReceivedAt, beforeReceivedAt, limit: RESCORE_BATCH },
    )) as Array<{ emailId: Id<"emails">; receivedAt: number }>;
    if (targets.length === 0) return { queued: 0, more: false };
    for (let i = 0; i < targets.length; i++) {
      await ctx.scheduler.runAfter(
        i * SPACING_MS,
        internal.ai.needsResponse.rescoreEmail,
        { emailId: targets[i].emailId, userId },
      );
    }
    const nextCursor = targets[targets.length - 1].receivedAt;
    await ctx.scheduler.runAfter(
      targets.length * SPACING_MS + 4_000,
      internal.admin.refresh3Months._rescoreRecentChunk,
      { userId, sinceReceivedAt, beforeReceivedAt: nextCursor },
    );
    return { queued: targets.length, more: true };
  },
});

// ─── Entry point ───────────────────────────────────────────────────────────

export const start = action({
  args: { userId: v.optional(v.id("users")) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    phase1Dismissed: number;
    rescoreQueued: boolean;
    cutoffIso: string;
  }> => {
    const userId =
      args.userId ??
      ((await ctx.runQuery(internal.admin.refresh3Months._firstUser, {})) as
        | Id<"users">
        | null);
    if (!userId) throw new Error("No user found");

    const cutoff = Date.now() - THREE_MONTHS_MS;

    // Phase 1: synchronously clear out everything stale before kicking off
    // the rescore loop. Phase 1 is DB-only and finishes in a few seconds.
    const { totalDismissed } = (await ctx.runAction(
      internal.admin.refresh3Months._dismissOldLoop,
      { cutoff },
    )) as { totalDismissed: number };

    // Phase 2: queue the first rescore chunk; it self-reschedules until done.
    await ctx.scheduler.runAfter(
      0,
      internal.admin.refresh3Months._rescoreRecentChunk,
      { userId, sinceReceivedAt: cutoff, beforeReceivedAt: undefined },
    );

    return {
      phase1Dismissed: totalDismissed,
      rescoreQueued: true,
      cutoffIso: new Date(cutoff).toISOString(),
    };
  },
});
