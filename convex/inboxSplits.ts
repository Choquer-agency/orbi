// ─────────────────────────────────────────────────────────────────────────────
// inboxSplits.ts — port of routes/settings/inbox-splits.
//
// First call seeds DEFAULT_SPLITS for the user. `update` replaces the entire
// configuration (delete-all + insert-all), matching the source PUT semantics.
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./lib/auth";

const DEFAULT_SPLITS = [
  { category: "all", label: "All", position: 0 },
  {
    category: "revision_request,new_inquiry,feedback",
    label: "Client Work",
    position: 1,
  },
  { category: "internal", label: "Internal", position: 2 },
  { category: "billing", label: "Billing", position: 3 },
  {
    category: "project_update,notification",
    label: "Updates",
    position: 4,
  },
];

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const splits = await ctx.db
      .query("inboxSplits")
      .withIndex("by_user_isEnabled_position", (q) => q.eq("userId", userId))
      .collect();
    splits.sort((a, b) => a.position - b.position);
    // NOTE: queries can't write — frontend must call ensureDefaults() once if empty.
    return splits;
  },
});

/**
 * Seed defaults if the user has no inbox splits yet. Called by the frontend
 * after `list` returns an empty array.
 */
export const ensureDefaults = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("inboxSplits")
      .withIndex("by_user_isEnabled_position", (q) => q.eq("userId", userId))
      .collect();
    if (existing.length > 0) return existing;
    for (const s of DEFAULT_SPLITS) {
      await ctx.db.insert("inboxSplits", {
        userId,
        category: s.category,
        label: s.label,
        position: s.position,
        isEnabled: true,
      });
    }
    const splits = await ctx.db
      .query("inboxSplits")
      .withIndex("by_user_isEnabled_position", (q) => q.eq("userId", userId))
      .collect();
    splits.sort((a, b) => a.position - b.position);
    return splits;
  },
});

export const update = mutation({
  args: {
    splits: v.array(
      v.object({
        category: v.string(),
        label: v.string(),
        position: v.number(),
        isEnabled: v.boolean(),
      }),
    ),
  },
  handler: async (ctx, { splits }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("inboxSplits")
      .withIndex("by_user_isEnabled_position", (q) => q.eq("userId", userId))
      .collect();
    for (const s of existing) await ctx.db.delete(s._id);
    for (const s of splits) {
      await ctx.db.insert("inboxSplits", {
        userId,
        category: s.category,
        label: s.label,
        position: s.position,
        isEnabled: s.isEnabled,
      });
    }
    const result = await ctx.db
      .query("inboxSplits")
      .withIndex("by_user_isEnabled_position", (q) => q.eq("userId", userId))
      .collect();
    result.sort((a, b) => a.position - b.position);
    return result;
  },
});
