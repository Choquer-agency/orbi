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
    const skip = (Math.max(page, 1) - 1) * cappedLimit;

    // Pull all and slice in memory — notifications are user-scoped and small.
    const all = await ctx.db
      .query("notifications")
      .withIndex("by_user_isRead", (q) => q.eq("userId", userId))
      .collect();
    all.sort((a, b) => b._creationTime - a._creationTime);

    const total = all.length;
    const data = all.slice(skip, skip + cappedLimit);
    const unreadCount = all.filter((n) => !n.isRead).length;

    return {
      data,
      total,
      unreadCount,
      page,
      limit: cappedLimit,
      hasMore: skip + cappedLimit < total,
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

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_isRead", (q) =>
        q.eq("userId", userId).eq("isRead", false),
      )
      .collect();
    for (const n of unread) await ctx.db.patch(n._id, { isRead: true });
    return { success: true };
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
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_isRead", (q) =>
        q.eq("userId", userId).eq("isRead", false),
      )
      .collect();
    return { count: unread.length };
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
