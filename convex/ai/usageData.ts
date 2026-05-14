import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Bound result size for any "recent rows" scan. Anything larger should be
// served from the daily rollup (future work) instead of `.collect()`.
const MAX_RECENT_ROWS = 5000;

export const _record = internalMutation({
  args: {
    userId: v.optional(v.id("users")),
    feature: v.string(),
    model: v.string(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    providerCallCount: v.number(),
    requestId: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const inputTokens = args.inputTokens ?? 0;
    const outputTokens = args.outputTokens ?? 0;
    await ctx.db.insert("aiUsageLogs", {
      userId: args.userId,
      feature: args.feature,
      model: args.model,
      inputTokens,
      outputTokens,
      providerCallCount: args.providerCallCount,
      estimatedCostUsd: estimateAnthropicCostUsd(args.model, inputTokens, outputTokens),
      requestId: args.requestId,
      metadata: args.metadata,
      createdAt: Date.now(),
    });
  },
});

export const _dailyUsage = internalQuery({
  args: {
    userId: v.id("users"),
    // Single feature (back-compat) or list. When `features` is provided we sum
    // across all of them — useful when we want a shared budget across keys
    // like "chat" + a future "chat_premium".
    feature: v.optional(v.string()),
    features: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { userId, feature, features }) => {
    const since = Date.now() - DAY_MS;
    const rows = await ctx.db
      .query("aiUsageLogs")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", userId).gte("createdAt", since))
      .collect();
    const allowed = features
      ? new Set(features)
      : feature
        ? new Set([feature])
        : null;
    const filtered = allowed ? rows.filter((r) => allowed.has(r.feature)) : rows;
    return filtered.reduce(
      (acc, row) => ({
        calls: acc.calls + row.providerCallCount,
        inputTokens: acc.inputTokens + row.inputTokens,
        outputTokens: acc.outputTokens + row.outputTokens,
        estimatedCostUsd: acc.estimatedCostUsd + row.estimatedCostUsd,
      }),
      { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    );
  },
});

// Aggregates the last 24h by feature for a global cost dashboard. Uses the
// `by_feature_createdAt` index when a feature is passed; otherwise scans all
// recent rows. Cheap because the daily window bounds row count.
export const _featureDailyTotals = internalQuery({
  args: { feature: v.optional(v.string()) },
  handler: async (ctx, { feature }) => {
    const since = Date.now() - DAY_MS;
    const rows = feature
      ? await ctx.db
          .query("aiUsageLogs")
          .withIndex("by_feature_createdAt", (q) =>
            q.eq("feature", feature).gte("createdAt", since),
          )
          .collect()
      : await ctx.db.query("aiUsageLogs").collect();
    const recent = feature ? rows : rows.filter((r) => r.createdAt >= since);
    const totals = new Map<string, { calls: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number }>();
    for (const row of recent) {
      const t = totals.get(row.feature) ?? {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      };
      t.calls += row.providerCallCount;
      t.inputTokens += row.inputTokens;
      t.outputTokens += row.outputTokens;
      t.estimatedCostUsd += row.estimatedCostUsd;
      totals.set(row.feature, t);
    }
    return Array.from(totals.entries())
      .map(([f, t]) => ({ feature: f, ...t }))
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
  },
});

// Window queries — hour/day/week/month windows for the cost dashboard. All
// use the indexed `createdAt` lower bound so cost scales with the window
// size, not table size.

export const _userWindow = internalQuery({
  args: {
    userId: v.id("users"),
    hours: v.number(),
    features: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { userId, hours, features }) => {
    const since = Date.now() - hours * HOUR_MS;
    const rows = await ctx.db
      .query("aiUsageLogs")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", userId).gte("createdAt", since))
      .collect();
    const allowed = features ? new Set(features) : null;
    const filtered = allowed ? rows.filter((r) => allowed.has(r.feature)) : rows;
    return aggregate(filtered);
  },
});

export const _featureWindow = internalQuery({
  args: { hours: v.number(), feature: v.optional(v.string()) },
  handler: async (ctx, { hours, feature }) => {
    const since = Date.now() - hours * HOUR_MS;
    const rows = feature
      ? await ctx.db
          .query("aiUsageLogs")
          .withIndex("by_feature_createdAt", (q) =>
            q.eq("feature", feature).gte("createdAt", since),
          )
          .collect()
      : await ctx.db.query("aiUsageLogs").collect();
    const recent = feature ? rows : rows.filter((r) => r.createdAt >= since);
    const byFeature = new Map<string, AggregateBucket>();
    const byModel = new Map<string, AggregateBucket>();
    for (const row of recent) {
      addRow(byFeature, row.feature, row);
      addRow(byModel, row.model, row);
    }
    return {
      total: aggregate(recent),
      byFeature: bucketsToArray(byFeature).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd),
      byModel: bucketsToArray(byModel).sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd),
    };
  },
});

// Drill-down: top users by cost in a window. Used by the admin dashboard to
// answer "who is spending the most today".
export const _topUsersByCost = internalQuery({
  args: { hours: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { hours, limit }) => {
    const since = Date.now() - hours * HOUR_MS;
    const rows = await ctx.db.query("aiUsageLogs").collect();
    const recent = rows.filter((r) => r.createdAt >= since);
    const byUser = new Map<string, AggregateBucket>();
    for (const row of recent) {
      if (!row.userId) continue;
      addRow(byUser, row.userId, row);
    }
    return bucketsToArray(byUser)
      .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)
      .slice(0, limit ?? 10);
  },
});

// Recent raw rows for a single feature. Use this to drill into spikes.
export const _recentByFeature = internalQuery({
  args: {
    feature: v.string(),
    hours: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { feature, hours, limit }) => {
    const since = Date.now() - (hours ?? 24) * HOUR_MS;
    const rows = await ctx.db
      .query("aiUsageLogs")
      .withIndex("by_feature_createdAt", (q) =>
        q.eq("feature", feature).gte("createdAt", since),
      )
      .order("desc")
      .take(Math.min(limit ?? 100, MAX_RECENT_ROWS));
    return rows;
  },
});

// Trip-wire that the alert cron polls every 15m. Returns the list of
// (feature, costUsd) pairs that exceed the thresholds in `featureLimits`.
export const _checkCostAlerts = internalQuery({
  args: {
    hours: v.number(),
    featureLimits: v.array(v.object({ feature: v.string(), maxUsd: v.number() })),
  },
  handler: async (ctx, { hours, featureLimits }) => {
    const since = Date.now() - hours * HOUR_MS;
    const alerts: Array<{ feature: string; estimatedCostUsd: number; thresholdUsd: number }> = [];
    for (const { feature, maxUsd } of featureLimits) {
      const rows = await ctx.db
        .query("aiUsageLogs")
        .withIndex("by_feature_createdAt", (q) =>
          q.eq("feature", feature).gte("createdAt", since),
        )
        .collect();
      const total = rows.reduce((sum, r) => sum + r.estimatedCostUsd, 0);
      if (total >= maxUsd) {
        alerts.push({ feature, estimatedCostUsd: total, thresholdUsd: maxUsd });
      }
    }
    return alerts;
  },
});

type AggregateBucket = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

function emptyBucket(): AggregateBucket {
  return { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
}

function aggregate(rows: Array<{ providerCallCount: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number }>): AggregateBucket {
  return rows.reduce((acc, row) => {
    acc.calls += row.providerCallCount;
    acc.inputTokens += row.inputTokens;
    acc.outputTokens += row.outputTokens;
    acc.estimatedCostUsd += row.estimatedCostUsd;
    return acc;
  }, emptyBucket());
}

function addRow(
  map: Map<string, AggregateBucket>,
  key: string,
  row: { providerCallCount: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number },
) {
  const b = map.get(key) ?? emptyBucket();
  b.calls += row.providerCallCount;
  b.inputTokens += row.inputTokens;
  b.outputTokens += row.outputTokens;
  b.estimatedCostUsd += row.estimatedCostUsd;
  map.set(key, b);
}

function bucketsToArray(map: Map<string, AggregateBucket>) {
  return Array.from(map.entries()).map(([key, bucket]) => ({ key, ...bucket }));
}

function estimateAnthropicCostUsd(model: string, inputTokens: number, outputTokens: number) {
  // Approximate current Anthropic list prices per 1M tokens. Keep this as
  // telemetry, not billing truth; provider invoices remain authoritative.
  const lower = model.toLowerCase();
  if (lower === "deterministic") return 0;
  let inputPerMillion: number;
  let outputPerMillion: number;
  if (lower.includes("haiku")) {
    [inputPerMillion, outputPerMillion] = [1, 5];
  } else if (lower.includes("opus")) {
    [inputPerMillion, outputPerMillion] = [15, 75];
  } else {
    // Sonnet (and unknown models default to Sonnet pricing so we never under-count).
    [inputPerMillion, outputPerMillion] = [3, 15];
  }
  return (inputTokens / 1_000_000) * inputPerMillion + (outputTokens / 1_000_000) * outputPerMillion;
}
