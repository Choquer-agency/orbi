// ─────────────────────────────────────────────────────────────────────────────
// notifications.ts — port of routes/notifications + the cross-cutting
// `createNotificationIfAllowed` utility from services/notifications.ts.
//
// The internal helper `createIfAllowed` checks the per-type toggle before
// inserting. Other Convex modules (handoffs, comments, classifier, sync
// workers, etc.) call this rather than `ctx.db.insert` directly.
//
// `recordPushDelivery` increments the `pushDeliveryCounters` table — the
// dashboard reads via `by_user_date` instead of aggregating logs at runtime.
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";
import { internal } from "./_generated/api";

const notificationType = v.union(
  v.literal("NEW_EMAIL"),
  v.literal("MENTION"),
  v.literal("COMMENT"),
  v.literal("ASSIGNMENT"),
  v.literal("SLA_WARNING"),
  v.literal("SLA_BREACH"),
  v.literal("SNOOZE_REMINDER"),
);

const TYPE_TO_PREF: Record<string, keyof Doc<"notificationPreferences">> = {
  NEW_EMAIL: "enableNewEmail",
  MENTION: "enableMention",
  COMMENT: "enableComment",
  ASSIGNMENT: "enableAssignment",
  SLA_WARNING: "enableSlaWarning",
  SLA_BREACH: "enableSlaBreach",
  SNOOZE_REMINDER: "enableSnoozeReminder",
};

// ─────────────────────────────────────────────────────────────────────────────
// Public queries / mutations
// ─────────────────────────────────────────────────────────────────────────────

export const list = query({
  args: {
    page: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { page = 1, limit = 20 }) => {
    const userId = await requireUser(ctx);
    const cappedLimit = Math.min(Math.max(limit, 1), 50);
    const cappedPage = Math.max(page, 1);
    // We can't .collect() this anymore — accounts can easily have 30k+
    // notifications after a historical sync, which trips the per-call
    // 32k-doc cap. Read just enough rows to satisfy the requested page
    // (plus one to detect hasMore). `by_user_isRead` orders by userId,
    // isRead, then _creationTime; .order("desc") + .take() walks newest-first.
    const skip = (cappedPage - 1) * cappedLimit;
    const upTo = skip + cappedLimit + 1;
    // Cap the page we'll serve so a runaway client can't force us to read
    // an arbitrary number of rows.
    const HARD_READ_CAP = 500;
    const toTake = Math.min(upTo, HARD_READ_CAP);
    const slice = await ctx.db
      .query("notifications")
      .withIndex("by_user_isRead", (q) => q.eq("userId", userId))
      .order("desc")
      .take(toTake);
    const data = slice.slice(skip, skip + cappedLimit);
    const hasMore = slice.length > skip + cappedLimit;
    // `total` and `unreadCount` are intentionally lower bounds — the
    // notifications drawer doesn't display them precisely (the badge uses the
    // dedicated unreadCount query, which is capped at 100). Anything past
    // `HARD_READ_CAP` is just reported as "at least this many".
    const total = slice.length;
    const unreadCount = slice.filter((n) => !n.isRead).length;

    return {
      data,
      total,
      unreadCount,
      page: cappedPage,
      limit: cappedLimit,
      hasMore,
    };
  },
});

export const markRead = mutation({
  args: { id: v.id("notifications") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const n = await ctx.db.get(id);
    if (!n || n.userId !== userId) throw new Error("Notification not found");
    await ctx.db.patch(id, { isRead: true });
    return await ctx.db.get(id);
  },
});

const MARK_ALL_READ_BATCH = 500;

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    // Patch the first batch synchronously so the badge updates immediately
    // for the user, then hand the rest off to a background sweeper that
    // re-schedules itself until the unread set is drained. We can't `collect`
    // 30k+ rows in one mutation — that hits the per-call doc cap.
    const slice = await ctx.db
      .query("notifications")
      .withIndex("by_user_isRead", (q) =>
        q.eq("userId", userId).eq("isRead", false),
      )
      .take(MARK_ALL_READ_BATCH);
    for (const n of slice) await ctx.db.patch(n._id, { isRead: true });
    if (slice.length === MARK_ALL_READ_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.notifications._markAllReadChunk,
        { userId },
      );
    }
    return { success: true, patched: slice.length };
  },
});

export const _markAllReadChunk = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const slice = await ctx.db
      .query("notifications")
      .withIndex("by_user_isRead", (q) =>
        q.eq("userId", userId).eq("isRead", false),
      )
      .take(MARK_ALL_READ_BATCH);
    for (const n of slice) await ctx.db.patch(n._id, { isRead: true });
    if (slice.length === MARK_ALL_READ_BATCH) {
      await ctx.scheduler.runAfter(
        0,
        internal.notifications._markAllReadChunk,
        { userId },
      );
    }
    return { patched: slice.length };
  },
});

export const markThreadRead = mutation({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const userId = await requireUser(ctx);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_isRead", (q) =>
        q.eq("userId", userId).eq("isRead", false),
      )
      .collect();
    const matching = unread.filter((n) => {
      const data = n.data as { threadId?: unknown } | undefined;
      return String(data?.threadId ?? "") === String(threadId);
    });
    for (const n of matching) await ctx.db.patch(n._id, { isRead: true });
    return { success: true, count: matching.length };
  },
});

export const unreadCount = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    // The badge UI only differentiates 0, 1-99, and "99+", so we never need
    // an exact count past 100. Collecting the entire unread set used to read
    // 30k+ documents per call after a historical sync — the index already
    // narrows to the unread slice, so this is just a stop-at-100 short read.
    const MAX_BADGE_COUNT = 100;
    const slice = await ctx.db
      .query("notifications")
      .withIndex("by_user_isRead", (q) =>
        q.eq("userId", userId).eq("isRead", false),
      )
      .take(MAX_BADGE_COUNT);
    return { count: slice.length };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper used everywhere a notification might be created
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Insert a notification only if the user's preferences allow it.
 * Returns the notification id, or null if suppressed.
 *
 * Suppression rules (matches the source services/notifications.ts):
 *   1. Per-type toggle is OFF (`prefs.enable<Type>` === false).
 *
 * TODO: enforce quiet hours — quietHoursStart/quietHoursEnd/quietHoursTimezone
 * exist on `notificationPreferences` but were never enforced in the running
 * Fastify app, so we preserve that behavior here.
 */
export const createIfAllowed = internalMutation({
  args: {
    userId: v.id("users"),
    type: notificationType,
    title: v.string(),
    body: v.optional(v.string()),
    data: v.optional(v.any()),
  },
  handler: async (ctx, args): Promise<Id<"notifications"> | null> => {
    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();

    if (prefs) {
      const prefKey = TYPE_TO_PREF[args.type];
      if (prefKey && prefs[prefKey] === false) return null;
    }

    const notificationId = await ctx.db.insert("notifications", {
      userId: args.userId,
      type: args.type,
      title: args.title,
      body: args.body,
      data: args.data,
      isRead: false,
    });

    // Fan out push delivery (Phase 4). We delegate to a V8 trigger mutation
    // so the wiring stays in one place; that mutation then schedules the
    // Node-runtime APNs action that performs the real delivery.
    await ctx.scheduler.runAfter(
      0,
      internal.push.onNotification.triggerOnInsert,
      { notificationId, userId: args.userId },
    );

    return notificationId;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Push delivery counter increment (called by the push delivery worker — Phase 4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Increment `pushDeliveryCounters` for the given (userId, status, date) bucket.
 * The push-health dashboard reads these counters directly via `by_user_date`
 * instead of aggregating `pushDeliveryLogs` at runtime.
 *
 * `date` must be a "YYYY-MM-DD" string in UTC (caller's responsibility).
 * `status` is one of: "sent" | "failed" | "token_invalid" | "rate_limited".
 */
export const recordPushDelivery = internalMutation({
  args: {
    userId: v.id("users"),
    status: v.string(),
    date: v.string(),
  },
  handler: async (ctx, { userId, status, date }) => {
    const all = await ctx.db
      .query("pushDeliveryCounters")
      .withIndex("by_user_date", (q) => q.eq("userId", userId).eq("date", date))
      .collect();
    const existing = all.find((c) => c.status === status);
    if (existing) {
      await ctx.db.patch(existing._id, { count: existing.count + 1 });
      return existing._id;
    }
    return await ctx.db.insert("pushDeliveryCounters", {
      userId,
      status,
      date,
      count: 1,
    });
  },
});
