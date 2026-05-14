// ─────────────────────────────────────────────────────────────────────────────
// costAlerts.ts — periodic AI cost-alert check.
//
// Cron (every 15 minutes) calls `runCheck`. It pulls the spend over the last
// hour for each (feature, threshold) pair and, when a threshold is crossed,
// inserts an `aiCostAlerts` row that the admin dashboard surfaces. Alerts
// auto-dedupe by suppressing duplicates within the cooldown window so we
// don't spam the dashboard during a sustained spike.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";

// Default per-feature hourly budgets. Tune in one place. Keep this in code
// (rather than in the DB) so a deploy is the audit trail.
const FEATURE_HOURLY_LIMITS: Array<{ feature: string; maxUsd: number }> = [
  { feature: "chat", maxUsd: 5 },
  { feature: "draft", maxUsd: 3 },
  { feature: "classifier", maxUsd: 2 },
  { feature: "task_extract", maxUsd: 2 },
  { feature: "task_resolve", maxUsd: 1 },
  { feature: "follow_up_draft", maxUsd: 1 },
  { feature: "learn", maxUsd: 0.5 },
  { feature: "meeting_detect", maxUsd: 1 },
];

const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1h between repeated alerts per feature

export const runCheck = internalAction({
  args: {},
  handler: async (ctx): Promise<{ raised: number }> => {
    const alerts = await ctx.runQuery(internal.ai.usageData._checkCostAlerts, {
      hours: 1,
      featureLimits: FEATURE_HOURLY_LIMITS,
    });
    if (alerts.length === 0) return { raised: 0 };

    let raised = 0;
    for (const a of alerts) {
      const created = await ctx.runMutation(internal.ai.costAlerts._raise, {
        feature: a.feature,
        windowHours: 1,
        estimatedCostUsd: a.estimatedCostUsd,
        thresholdUsd: a.thresholdUsd,
        cooldownMs: ALERT_COOLDOWN_MS,
      });
      if (created) raised += 1;
    }
    return { raised };
  },
});

export const _raise = internalMutation({
  args: {
    feature: v.string(),
    windowHours: v.number(),
    estimatedCostUsd: v.number(),
    thresholdUsd: v.number(),
    cooldownMs: v.number(),
  },
  handler: async (ctx, args) => {
    const since = Date.now() - args.cooldownMs;
    const recent = await ctx.db
      .query("aiCostAlerts")
      .withIndex("by_feature_createdAt", (q) =>
        q.eq("feature", args.feature).gte("createdAt", since),
      )
      .collect();
    const stillOpen = recent.some((r) => !r.acknowledgedAt);
    if (stillOpen) return null;

    return await ctx.db.insert("aiCostAlerts", {
      feature: args.feature,
      windowHours: args.windowHours,
      estimatedCostUsd: args.estimatedCostUsd,
      thresholdUsd: args.thresholdUsd,
      acknowledgedAt: undefined,
      acknowledgedBy: undefined,
      createdAt: Date.now(),
    });
  },
});

// Read the currently-open (unacknowledged) alerts. Used by the admin
// dashboard banner.
export const _listOpen = internalQuery({
  args: {},
  handler: async (ctx) => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("aiCostAlerts")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", since))
      .order("desc")
      .collect();
    return rows.filter((r) => !r.acknowledgedAt);
  },
});
