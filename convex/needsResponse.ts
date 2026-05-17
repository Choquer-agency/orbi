// Public surface for the Needs Response folder. Wraps the internal scoring +
// dismiss infrastructure in convex/ai/needsResponse{,Data}.ts.

import { v } from "convex/values";
import {
  mutation,
  query,
  internalAction,
  internalQuery,
  internalMutation,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import type { Doc, Id } from "./_generated/dataModel";

const DEFAULT_RETENTION_DAYS = 45;
const DEFAULT_CONFIDENCE_FLOOR = 50;

// Effective ranking score: prefer the v2 displayScore (raw + deadline bonus
// − active-thread penalty), fall back to raw score for legacy rows that
// haven't been rescored yet.
function effectiveScore(s: Doc<"needsResponseSignals">): number {
  return s.displayScore ?? s.score;
}

// Lightweight per-thread check: does this thread have an open
// needsResponseSignal right now? Drives the "Done" button visibility in
// the email viewer toolbar.
export const hasOpenForThread = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);
    const sig = await ctx.db
      .query("needsResponseSignals")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .filter((q) => q.eq(q.field("dismissedAt"), undefined))
      .first();
    if (!sig || sig.userId !== userId) return { open: false };
    return {
      open: true,
      reason: sig.reason ?? null,
      score: sig.score,
    };
  },
});

// Manual "Done" / "Skip" button on a Smart Mail card. Marks every open
// signal for this thread as dismissed and records a "manual-done" feedback
// row so the scorer can learn from the dismissal pattern.
export const dismissThread = mutation({
  args: { threadId: v.id("threads") },
  handler: async (
    ctx,
    { threadId },
  ): Promise<{ dismissed: number }> => {
    const userId = await requireUser(ctx);
    const thread = await ctx.db.get(threadId);
    if (!thread) throw new Error("Thread not found");
    const account = await ctx.db.get(thread.accountId);
    if (!account || account.userId !== userId) {
      throw new Error("Thread not found");
    }
    return (await ctx.runMutation(
      internal.ai.needsResponseData._dismissOpenSignalsForThread,
      { threadId, kind: "manual-done" },
    )) as { dismissed: number };
  },
});

// Per-user settings for the Needs Response folder. Returns defaults when
// the user hasn't saved a row yet; the row is created lazily on first
// updateSettings call.
export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db
      .query("needsResponseSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return {
      retentionDays: row?.retentionDays ?? DEFAULT_RETENTION_DAYS,
      confidenceFloor: row?.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR,
      perAccountFilter: row?.perAccountFilter ?? null,
    };
  },
});

export const updateSettings = mutation({
  args: {
    retentionDays: v.optional(v.number()),
    confidenceFloor: v.optional(v.number()),
    perAccountFilter: v.optional(
      v.union(v.array(v.id("mailAccounts")), v.null()),
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("needsResponseSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const next = {
      retentionDays: args.retentionDays ?? existing?.retentionDays ?? DEFAULT_RETENTION_DAYS,
      confidenceFloor:
        args.confidenceFloor ?? existing?.confidenceFloor ?? DEFAULT_CONFIDENCE_FLOOR,
      perAccountFilter:
        args.perAccountFilter === null
          ? undefined
          : args.perAccountFilter ?? existing?.perAccountFilter,
    };
    // Clamp to sane bounds.
    next.retentionDays = Math.max(7, Math.min(365, Math.round(next.retentionDays)));
    next.confidenceFloor = Math.max(0, Math.min(95, Math.round(next.confidenceFloor)));
    if (existing) {
      await ctx.db.patch(existing._id, next);
      return { ok: true };
    }
    await ctx.db.insert("needsResponseSettings", { userId, ...next });
    return { ok: true };
  },
});

// The Needs Response folder view: top 5 by displayScore, divider, next 5
// by recency. Always returns both arrays (either may be empty). The thread
// payloads match what threads.list returns so the existing ThreadItem
// renders unchanged.
export const list = query({
  args: {
    accountIds: v.optional(v.array(v.id("mailAccounts"))),
  },
  handler: async (ctx, { accountIds }) => {
    const userId = await requireUser(ctx);

    // Resolve account filter: explicit arg wins; otherwise settings.
    const settings = await ctx.db
      .query("needsResponseSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    const filterIds =
      accountIds && accountIds.length > 0
        ? accountIds
        : settings?.perAccountFilter && settings.perAccountFilter.length > 0
          ? settings.perAccountFilter
          : null;
    const filterSet = filterIds ? new Set(filterIds.map((id) => id as unknown as string)) : null;

    // Walk open signals via the compound index. We collect up to PAGE_LIMIT
    // candidates; for an active mailbox this is enough to surface a varied
    // top-10. If a user accumulates >500 open signals we should revisit.
    const PAGE_LIMIT = 500;
    const open = await ctx.db
      .query("needsResponseSignals")
      .withIndex("by_user_dismissedAt_score", (q) =>
        q.eq("userId", userId).eq("dismissedAt", undefined),
      )
      .order("desc")
      .take(PAGE_LIMIT);

    if (open.length === 0) {
      return { topUrgent: [], topRecent: [] };
    }

    // Apply per-account filter (if any) by checking each signal's email's
    // accountId. Threads inherit their account from the email, so this
    // gates the list to the selected mailboxes.
    let scoped = open;
    if (filterSet) {
      const checked = await Promise.all(
        open.map(async (s) => {
          const email = await ctx.db.get(s.emailId);
          return email && filterSet.has(email.accountId as unknown as string)
            ? s
            : null;
        }),
      );
      scoped = checked.filter((s): s is Doc<"needsResponseSignals"> => s !== null);
    }

    // Re-sort by effective score (displayScore ?? score) so deadline
    // bonuses and active-thread penalties actually influence ranking.
    // For legacy rows displayScore is undefined → effectiveScore === score.
    const ranked = scoped
      .slice()
      .sort((a, b) => effectiveScore(b) - effectiveScore(a));

    // Score-desc top 5, dedup'd by thread (a thread might have multiple
    // scored emails; we keep the highest-ranking one).
    const seenThread = new Set<string>();
    const byScore: typeof ranked = [];
    for (const s of ranked) {
      const key = s.threadId as unknown as string;
      if (seenThread.has(key)) continue;
      seenThread.add(key);
      byScore.push(s);
    }
    const topFive = byScore.slice(0, 5);
    const topFiveIds = new Set(topFive.map((s) => s._id as unknown as string));

    // For "Recent", sort by the underlying email's receivedAt (when the
    // sender actually wrote it) — not by computedAt (when the AI scored
    // it). Otherwise rescoring an old email today bumps it into Recent,
    // which surprises users when they see December emails in this list.
    const remainingPool = scoped.filter(
      (s) => !topFiveIds.has(s._id as unknown as string),
    );
    const withReceived = await Promise.all(
      remainingPool.map(async (s) => {
        const email = await ctx.db.get(s.emailId);
        return { signal: s, receivedAt: email?.receivedAt ?? s.computedAt };
      }),
    );
    withReceived.sort((a, b) => b.receivedAt - a.receivedAt);

    const seenRecent = new Set<string>();
    const recentFive: typeof open = [];
    for (const { signal: s } of withReceived) {
      const key = s.threadId as unknown as string;
      if (seenRecent.has(key) || seenThread.has(key)) continue;
      seenRecent.add(key);
      seenThread.add(key);
      recentFive.push(s);
      if (recentFive.length >= 5) break;
    }

    return {
      topUrgent: await hydrateRows(ctx, topFive),
      topRecent: await hydrateRows(ctx, recentFive),
    };
  },
});

// Daily cron: re-score signals older than 24h so deadlines that have
// approached or context that's drifted get reflected. Also auto-dismisses
// signals on emails older than the user's retention window — the steady-
// state replacement for the admin "refresh 3 months" script.
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const RESCORE_BATCH = 50;

export const _findStaleForRescore = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - STALE_THRESHOLD_MS;
    const candidates = await ctx.db
      .query("needsResponseSignals")
      .take(500);
    const stale = candidates
      .filter((s) => s.dismissedAt === undefined && s.computedAt < cutoff)
      .slice(0, RESCORE_BATCH);
    // For each candidate, decide rescore vs dismiss based on retention.
    // We need the email's receivedAt and the user's retention setting.
    const decisions: Array<{
      emailId: Id<"emails">;
      userId: Id<"users">;
      threadId: Id<"threads">;
      action: "rescore" | "dismiss-out-of-window";
    }> = [];
    const retentionByUser = new Map<string, number>();
    for (const s of stale) {
      const userKey = s.userId as unknown as string;
      let retentionDays = retentionByUser.get(userKey);
      if (retentionDays === undefined) {
        const settings = await ctx.db
          .query("needsResponseSettings")
          .withIndex("by_user", (q) => q.eq("userId", s.userId))
          .unique();
        retentionDays = settings?.retentionDays ?? DEFAULT_RETENTION_DAYS;
        retentionByUser.set(userKey, retentionDays);
      }
      const email = await ctx.db.get(s.emailId);
      if (!email) {
        decisions.push({
          emailId: s.emailId,
          userId: s.userId,
          threadId: s.threadId,
          action: "dismiss-out-of-window",
        });
        continue;
      }
      const ageDays = (Date.now() - email.receivedAt) / 86_400_000;
      decisions.push({
        emailId: s.emailId,
        userId: s.userId,
        threadId: s.threadId,
        action: ageDays > retentionDays ? "dismiss-out-of-window" : "rescore",
      });
    }
    return decisions;
  },
});

export const _rescoreStale = internalAction({
  args: {},
  handler: async (ctx) => {
    const targets = (await ctx.runQuery(
      internal.needsResponse._findStaleForRescore,
      {},
    )) as Array<{
      emailId: Id<"emails">;
      userId: Id<"users">;
      threadId: Id<"threads">;
      action: "rescore" | "dismiss-out-of-window";
    }>;
    let rescored = 0;
    let dismissed = 0;
    for (const t of targets) {
      if (t.action === "dismiss-out-of-window") {
        await ctx.runMutation(
          internal.ai.needsResponseData._dismissOpenSignalsForThread,
          { threadId: t.threadId, kind: "archived" },
        );
        dismissed++;
      } else {
        await ctx.scheduler.runAfter(0, internal.ai.needsResponse.rescoreEmail, {
          emailId: t.emailId,
          userId: t.userId,
        });
        rescored++;
      }
    }
    return { rescored, dismissed };
  },
});

// Re-scoring trigger when a mailbox's aliases change. The previous scoring
// pass may have flagged emails from those aliases as inbound external —
// rebuild the self-email set and either dismiss (now-outbound) or rescore
// (still-inbound, but with refreshed context) every open signal for the user.
export const _rescoreAfterConfigChange = internalAction({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const targets = (await ctx.runQuery(
      internal.needsResponse._collectOpenForUser,
      { userId },
    )) as Array<{
      emailId: Id<"emails">;
      threadId: Id<"threads">;
      fromAddress: string;
    }>;
    const selfSet = (await ctx.runQuery(
      internal.needsResponse._selfEmailsForUser,
      { userId },
    )) as string[];
    const selfSetLower = new Set(selfSet.map((s) => s.toLowerCase().trim()));
    let dismissed = 0;
    let rescored = 0;
    for (const t of targets) {
      if (selfSetLower.has(t.fromAddress.toLowerCase().trim())) {
        await ctx.runMutation(
          internal.ai.needsResponseData._dismissOpenSignalsForThread,
          { threadId: t.threadId, kind: "auto-other-acc" },
        );
        dismissed++;
      } else {
        await ctx.scheduler.runAfter(0, internal.ai.needsResponse.rescoreEmail, {
          emailId: t.emailId,
          userId,
        });
        rescored++;
      }
    }
    return { dismissed, rescored };
  },
});

export const _collectOpenForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const open = await ctx.db
      .query("needsResponseSignals")
      .withIndex("by_user_dismissedAt_score", (q) =>
        q.eq("userId", userId).eq("dismissedAt", undefined),
      )
      .take(500);
    const out: Array<{
      emailId: Id<"emails">;
      threadId: Id<"threads">;
      fromAddress: string;
    }> = [];
    for (const s of open) {
      const email = await ctx.db.get(s.emailId);
      if (!email) continue;
      out.push({
        emailId: s.emailId,
        threadId: s.threadId,
        fromAddress: email.fromAddress,
      });
    }
    return out;
  },
});

export const _selfEmailsForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const accts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return accts.flatMap((a) => [a.email, ...(a.aliases ?? [])]);
  },
});

// User-callable rescore: queues a sweep of all open signals through the v2
// scorer. Surfaced from the NeedsResponseSettings UI so a user who changes
// retention or confidence can immediately reflect that in the folder.
export const rescoreAllOpen = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    await ctx.scheduler.runAfter(0, internal.needsResponse._rescoreAfterConfigChange, {
      userId,
    });
    return { queued: true };
  },
});

// Internal helper retained for ergonomic test/admin invocation.
export const _patchSignalDismissedAt = internalMutation({
  args: {
    signalId: v.id("needsResponseSignals"),
    dismissedAt: v.number(),
  },
  handler: async (ctx, { signalId, dismissedAt }) => {
    await ctx.db.patch(signalId, { dismissedAt });
  },
});

async function hydrateRows(
  ctx: { db: any },
  signals: Array<Doc<"needsResponseSignals">>,
): Promise<Array<unknown>> {
  return await Promise.all(
    signals.map(async (s) => {
      const thread = (await ctx.db.get(s.threadId)) as Doc<"threads"> | null;
      if (!thread) return null;
      const email = (await ctx.db.get(s.emailId)) as Doc<"emails"> | null;
      return {
        ...thread,
        id: thread._id,
        // Match threads.list's `emails: [{ ... }]` shape so the existing
        // ThreadItem rendering picks up sender / snippet correctly.
        emails: email
          ? [
              {
                fromAddress: email.fromAddress,
                fromName: email.fromName,
                snippet: email.snippet,
                receivedAt: email.receivedAt,
                classification: null,
              },
            ]
          : [],
        _count: { comments: 0 },
        hasDraft: false,
        // Signal-specific extras the NeedsResponseList renders as a
        // hover-explainer tooltip and deadline pill.
        needsResponseScore: s.score,
        needsResponseDisplayScore: s.displayScore ?? s.score,
        needsResponseReason: s.reason ?? null,
        needsResponseDueBy: s.dueByHint ?? null,
        needsResponseUserIsCcd: s.userIsCcd ?? false,
        needsResponseSenderIsTeamInternal: s.senderIsTeamInternal ?? false,
      };
    }),
  ).then((rows) => rows.filter((r) => r !== null));
}
