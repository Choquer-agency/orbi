// ─────────────────────────────────────────────────────────────────────────────
// usage.ts — public queries for the AI cost dashboard.
//
// All admin queries call into `internal.ai.usageData.*`. Per-user "my usage"
// queries don't require admin and only ever return the caller's own rows.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";
import type { Id } from "./_generated/dataModel";

async function requireAdmin(ctx: { db: any; auth: any }): Promise<Id<"users">> {
  const userId = await requireUser(ctx as any);
  const user = await ctx.db.get(userId);
  if (!user || user.role !== "ADMIN") {
    throw new Error("Admin access required");
  }
  return userId as Id<"users">;
}

// ── Admin: global cost dashboard ────────────────────────────────────────────

export const globalCostWindow = query({
  args: {
    hours: v.optional(v.number()),
    feature: v.optional(v.string()),
  },
  handler: async (ctx, { hours, feature }) => {
    await requireAdmin(ctx);
    return await ctx.runQuery(internal.ai.usageData._featureWindow, {
      hours: hours ?? 24,
      feature,
    });
  },
});

export const topUsersByCost = query({
  args: {
    hours: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { hours, limit }) => {
    await requireAdmin(ctx);
    return await ctx.runQuery(internal.ai.usageData._topUsersByCost, {
      hours: hours ?? 24,
      limit: limit ?? 10,
    });
  },
});

export const recentByFeature = query({
  args: {
    feature: v.string(),
    hours: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { feature, hours, limit }) => {
    await requireAdmin(ctx);
    return await ctx.runQuery(internal.ai.usageData._recentByFeature, {
      feature,
      hours: hours ?? 24,
      limit: limit ?? 100,
    });
  },
});

// Multi-window summary so the dashboard can render 1h / 24h / 7d / 30d cards
// in a single round-trip.
export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [h1, h24, h168, h720] = await Promise.all([
      ctx.runQuery(internal.ai.usageData._featureWindow, { hours: 1 }),
      ctx.runQuery(internal.ai.usageData._featureWindow, { hours: 24 }),
      ctx.runQuery(internal.ai.usageData._featureWindow, { hours: 24 * 7 }),
      ctx.runQuery(internal.ai.usageData._featureWindow, { hours: 24 * 30 }),
    ]);
    return { lastHour: h1, last24h: h24, last7d: h168, last30d: h720 };
  },
});

// ── Admin: cost alerts ──────────────────────────────────────────────────────

export const openCostAlerts = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return await ctx.runQuery(internal.ai.costAlerts._listOpen, {});
  },
});

export const acknowledgeCostAlert = mutation({
  args: { alertId: v.id("aiCostAlerts") },
  handler: async (ctx, { alertId }) => {
    const userId = await requireAdmin(ctx);
    const alert = await ctx.db.get(alertId);
    if (!alert) throw new Error("Alert not found");
    if (alert.acknowledgedAt) return alert;
    await ctx.db.patch(alertId, {
      acknowledgedAt: Date.now(),
      acknowledgedBy: userId,
    });
    return await ctx.db.get(alertId);
  },
});

// ── Per-user: anyone can see their own usage ────────────────────────────────

export const myUsage = query({
  args: {
    hours: v.optional(v.number()),
    features: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { hours, features }) => {
    const userId = await requireUser(ctx);
    return await ctx.runQuery(internal.ai.usageData._userWindow, {
      userId,
      hours: hours ?? 24,
      features,
    });
  },
});
