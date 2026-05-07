// ─────────────────────────────────────────────────────────────────────────────
// aiFilters.ts — port of routes/ai-filters.
//
// CRUD plus a toggle helper and a matchCount-increment helper that the
// classifier worker calls when a filter fires.
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const filters = await ctx.db
      .query("aiFilters")
      .withIndex("by_user_isActive", (q) => q.eq("userId", userId))
      .collect();
    filters.sort((a, b) => b._creationTime - a._creationTime);
    return filters;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    description: v.string(),
    conditions: v.any(),
    actions: v.any(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const id = await ctx.db.insert("aiFilters", {
      userId,
      name: args.name,
      description: args.description,
      conditions: args.conditions,
      actions: args.actions,
      isActive: true,
      matchCount: 0,
    });
    return await ctx.db.get(id);
  },
});

export const update = mutation({
  args: {
    id: v.id("aiFilters"),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    conditions: v.optional(v.any()),
    actions: v.optional(v.any()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const filter = await ctx.db.get(args.id);
    if (!filter || filter.userId !== userId) throw new Error("Filter not found");

    const updates: Partial<Doc<"aiFilters">> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.description !== undefined) updates.description = args.description;
    if (args.conditions !== undefined) updates.conditions = args.conditions;
    if (args.actions !== undefined) updates.actions = args.actions;
    if (args.isActive !== undefined) updates.isActive = args.isActive;
    await ctx.db.patch(args.id, updates);
    return await ctx.db.get(args.id);
  },
});

export const toggleActive = mutation({
  args: { id: v.id("aiFilters") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const filter = await ctx.db.get(id);
    if (!filter || filter.userId !== userId) throw new Error("Filter not found");
    await ctx.db.patch(id, { isActive: !filter.isActive });
    return await ctx.db.get(id);
  },
});

export const remove = mutation({
  args: { id: v.id("aiFilters") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const filter = await ctx.db.get(id);
    if (!filter || filter.userId !== userId) throw new Error("Filter not found");
    await ctx.db.delete(id);
    return { success: true };
  },
});

/**
 * Internal helper called by the classify-email worker when a filter matches.
 */
export const recordMatch = internalMutation({
  args: { id: v.id("aiFilters") },
  handler: async (ctx, { id }) => {
    const filter = await ctx.db.get(id);
    if (!filter) return;
    await ctx.db.patch(id, {
      matchCount: filter.matchCount + 1,
      lastMatchedAt: Date.now(),
    });
  },
});
