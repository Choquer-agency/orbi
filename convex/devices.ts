// ─────────────────────────────────────────────────────────────────────────────
// devices.ts — port of routes/devices + routes/devices/push-health.
//
// Device tokens are upserted by `(userId, token)`. Token rows reassign on
// re-register, matching source behavior (the device physically belongs to
// whoever's currently logged in).
//
// Push-health admin dashboard reads `pushDeliveryCounters` (populated by the
// push delivery worker via internal.notifications.recordPushDelivery). No
// runtime aggregation over `pushDeliveryLogs`.
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./lib/auth";

const devicePlatform = v.union(v.literal("IOS"), v.literal("ANDROID"));

/**
 * POST /api/devices/register — upsert a token for the current user.
 * If the token already exists for any user, it's reassigned to the current
 * user (re-register / account switch).
 */
export const register = mutation({
  args: {
    token: v.string(),
    platform: devicePlatform,
    bundleId: v.optional(v.string()),
    sandbox: v.optional(v.boolean()),
    appVersion: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    if (!args.token) throw new Error("token is required");

    const existing = await ctx.db
      .query("deviceTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        userId,
        platform: args.platform,
        sandbox: args.sandbox ?? existing.sandbox ?? false,
        appVersion: args.appVersion,
        bundleId: args.bundleId ?? existing.bundleId,
        lastUsedAt: now,
      });
      return {
        id: existing._id,
        token: args.token,
        platform: args.platform,
      };
    }

    const id = await ctx.db.insert("deviceTokens", {
      userId,
      token: args.token,
      platform: args.platform,
      bundleId: args.bundleId ?? "",
      sandbox: args.sandbox ?? false,
      appVersion: args.appVersion,
      lastUsedAt: now,
    });
    return { id, token: args.token, platform: args.platform };
  },
});

/**
 * List the current user's registered device tokens.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    return await ctx.db
      .query("deviceTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
  },
});

/**
 * DELETE /api/devices/unregister — remove one token (e.g. on logout).
 */
export const unregister = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userId = await requireUser(ctx);
    if (!token) return { success: true };
    const existing = await ctx.db
      .query("deviceTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (existing && existing.userId === userId) {
      await ctx.db.delete(existing._id);
    }
    return { success: true };
  },
});

/**
 * DELETE /api/devices/unregister-all — wipe all this user's tokens.
 */
export const unregisterAll = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const all = await ctx.db
      .query("deviceTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const t of all) await ctx.db.delete(t._id);
    return { success: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Push health — admin only
// ─────────────────────────────────────────────────────────────────────────────

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * GET /api/admin/push-health — last 24h delivery stats.
 *
 * Reads `pushDeliveryCounters` (populated by the delivery worker) instead of
 * aggregating `pushDeliveryLogs` rows at query time.
 */
export const pushHealth = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const me = await ctx.db.get(userId);
    if (!me || me.role !== "ADMIN") {
      throw new Error("Admin access required");
    }

    // Last 24h ≈ today's bucket + yesterday's bucket (UTC). The cron-driven
    // counter table groups by date, so we sum across these two buckets.
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dates = [ymd(yesterday), ymd(now)];

    // Pull counters for all users (admin-only endpoint, dataset is small).
    // If this grows, add a `by_date` index and query per-date directly.
    const all = await ctx.db.query("pushDeliveryCounters").collect();
    const recent = all.filter((c) => dates.includes(c.date));

    const stats: Record<string, number> = {
      sent: 0,
      failed: 0,
      token_invalid: 0,
      rate_limited: 0,
    };
    for (const c of recent) {
      stats[c.status] = (stats[c.status] ?? 0) + c.count;
    }

    const totalSent =
      stats.sent + stats.failed + stats.token_invalid + stats.rate_limited;
    const successRate =
      totalSent > 0 ? `${((stats.sent / totalSent) * 100).toFixed(1)}%` : "N/A";

    const activeTokens = (await ctx.db.query("deviceTokens").collect()).length;

    return {
      apnsConfigured: false, // wired up Phase 4 once we have the env helper.
      last24h: {
        total: totalSent,
        sent: stats.sent,
        failed: stats.failed,
        tokenInvalid: stats.token_invalid,
        rateLimited: stats.rate_limited,
        successRate,
      },
      activeDeviceTokens: activeTokens,
      tokensInvalidated24h: stats.token_invalid,
    };
  },
});
