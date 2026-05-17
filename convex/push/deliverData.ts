// ─────────────────────────────────────────────────────────────────────────────
// deliverData.ts — V8-runtime data layer for push delivery.
//
// `deliver.ts` runs in the Node runtime (uses the `apn` package) so it can't
// touch the DB directly; all reads/writes funnel through the helpers here.
// ─────────────────────────────────────────────────────────────────────────────

import { internalMutation, internalQuery } from "../_generated/server";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the notification + the user's effective push preferences in one call.
 * Returns null if the notification has been deleted between insertion and
 * delivery (race condition). Preferences may also be null — in that case the
 * caller treats them as "all enabled".
 */
export const _getNotificationForDelivery = internalQuery({
  args: { notificationId: v.id("notifications") },
  handler: async (ctx, { notificationId }) => {
    const notification = await ctx.db.get(notificationId);
    if (!notification) return null;
    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_user", (q) => q.eq("userId", notification.userId))
      .unique();
    // Compute current unread count for the badge. Cap at 100 — the badge UI
    // only displays "99+" for higher counts anyway. The previous unbounded
    // .collect() was the single most expensive query in the app (321 GB read
    // over 20 days) because every push delivery scanned every unread row,
    // including fat legacy email-body data referenced by the notification.
    const unreadSample = await ctx.db
      .query("notifications")
      .withIndex("by_user_isRead", (q) =>
        q.eq("userId", notification.userId).eq("isRead", false),
      )
      .take(100);
    return {
      notification: {
        _id: notification._id,
        userId: notification.userId,
        type: notification.type,
        title: notification.title,
        body: notification.body ?? null,
        data: notification.data ?? null,
      },
      prefs: prefs
        ? {
            pushEnabled: prefs.pushEnabled,
            soundEnabled: prefs.soundEnabled,
            showPreviewOnLock: prefs.showPreviewOnLock,
            quietHoursStart: prefs.quietHoursStart ?? null,
            quietHoursEnd: prefs.quietHoursEnd ?? null,
            quietHoursTimezone: prefs.quietHoursTimezone ?? null,
          }
        : null,
      badgeCount: unreadSample.length,
    };
  },
});

/**
 * List the device tokens registered for a user. Returned in stable order so
 * delivery logs sort sensibly.
 */
export const _listDeviceTokens = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const tokens = await ctx.db
      .query("deviceTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return tokens.map((t) => ({
      _id: t._id,
      token: t.token,
      platform: t.platform,
      bundleId: t.bundleId,
      sandbox: t.sandbox,
    }));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

const deliveryStatus = v.union(
  v.literal("sent"),
  v.literal("failed"),
  v.literal("token_invalid"),
  v.literal("rate_limited"),
);

/**
 * Persist a single push delivery attempt to `pushDeliveryLogs`.
 * Best-effort — never throws (the delivery loop logs on error).
 */
export const _recordDeliveryLog = internalMutation({
  args: {
    userId: v.id("users"),
    deviceTokenId: v.optional(v.id("deviceTokens")),
    notificationId: v.optional(v.id("notifications")),
    status: deliveryStatus,
    apnsId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    errorCode: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // The schema requires `deviceTokenId` to be present; if the call site
    // doesn't have one (e.g. APNs-not-configured short-circuit) we silently
    // skip the log row.
    if (!args.deviceTokenId) return null;
    return await ctx.db.insert("pushDeliveryLogs", {
      userId: args.userId,
      deviceTokenId: args.deviceTokenId,
      notificationId: args.notificationId,
      status: args.status,
      apnsId: args.apnsId,
      errorMessage: args.errorMessage,
      errorCode: args.errorCode,
    });
  },
});

/**
 * Increment `pushDeliveryCounters` for the (userId, status, date) bucket so
 * the admin dashboard can read aggregated counts without scanning logs.
 */
export const _incrementCounter = internalMutation({
  args: {
    userId: v.id("users"),
    status: v.string(),
    date: v.string(), // YYYY-MM-DD
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

/**
 * APNs returned BadDeviceToken / Unregistered → drop the token record so we
 * stop trying to deliver to it. Idempotent (delete-if-exists).
 */
export const _invalidateToken = internalMutation({
  args: { tokenId: v.id("deviceTokens") },
  handler: async (ctx, { tokenId }) => {
    const existing = await ctx.db.get(tokenId);
    if (!existing) return;
    await ctx.db.delete(tokenId);
  },
});
