// ─────────────────────────────────────────────────────────────────────────────
// snippets.ts — port of routes/snippets.
//
// Variable interpolation ({{recipient_name}} etc.) lives in the frontend; here
// we just CRUD the records.
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { requireUser } from "./lib/auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const snippets = await ctx.db
      .query("snippets")
      .withIndex("by_user_category", (q) => q.eq("userId", userId))
      .collect();
    snippets.sort((a, b) => {
      const ca = a.category ?? "";
      const cb = b.category ?? "";
      if (ca !== cb) return ca.localeCompare(cb);
      return a.name.localeCompare(b.name);
    });
    return snippets;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    bodyHtml: v.string(),
    bodyText: v.string(),
    category: v.optional(v.string()),
    variables: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const id = await ctx.db.insert("snippets", {
      userId,
      name: args.name,
      bodyHtml: args.bodyHtml,
      bodyText: args.bodyText,
      category: args.category,
      variables: args.variables ?? [],
    });
    return await ctx.db.get(id);
  },
});

export const update = mutation({
  args: {
    id: v.id("snippets"),
    name: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    bodyText: v.optional(v.string()),
    category: v.optional(v.string()),
    variables: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const snip = await ctx.db.get(args.id);
    if (!snip || snip.userId !== userId) throw new Error("Snippet not found");

    const updates: Partial<Doc<"snippets">> = {};
    if (args.name !== undefined) updates.name = args.name;
    if (args.bodyHtml !== undefined) updates.bodyHtml = args.bodyHtml;
    if (args.bodyText !== undefined) updates.bodyText = args.bodyText;
    if (args.category !== undefined) updates.category = args.category;
    if (args.variables !== undefined) updates.variables = args.variables;
    await ctx.db.patch(args.id, updates);
    return await ctx.db.get(args.id);
  },
});

export const remove = mutation({
  args: { id: v.id("snippets") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const snip = await ctx.db.get(id);
    if (!snip || snip.userId !== userId) throw new Error("Snippet not found");
    await ctx.db.delete(id);
    return { success: true };
  },
});
