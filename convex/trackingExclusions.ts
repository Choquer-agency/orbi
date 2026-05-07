// ─────────────────────────────────────────────────────────────────────────────
// trackingExclusions.ts — port of routes/settings/tracking-exclusions.
//
// Per-user list of email addresses the open-pixel/link-rewrite injectors skip.
// `add` is upsert-style (matches source POST behavior).
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./lib/auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const exclusions = await ctx.db
      .query("trackingExclusions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    exclusions.sort((a, b) => b._creationTime - a._creationTime);
    return exclusions;
  },
});

export const add = mutation({
  args: {
    emailAddress: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    if (!args.emailAddress || !args.emailAddress.includes("@")) {
      throw new Error("Valid email address required");
    }
    const email = args.emailAddress.toLowerCase().trim();

    const existing = await ctx.db
      .query("trackingExclusions")
      .withIndex("by_user_email", (q) =>
        q.eq("userId", userId).eq("emailAddress", email),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { reason: args.reason });
      return await ctx.db.get(existing._id);
    }

    const id = await ctx.db.insert("trackingExclusions", {
      userId,
      emailAddress: email,
      reason: args.reason,
    });
    return await ctx.db.get(id);
  },
});

export const remove = mutation({
  args: { id: v.id("trackingExclusions") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const exclusion = await ctx.db.get(id);
    if (!exclusion || exclusion.userId !== userId) {
      throw new Error("Exclusion not found");
    }
    await ctx.db.delete(id);
    return { message: "Deleted" };
  },
});
