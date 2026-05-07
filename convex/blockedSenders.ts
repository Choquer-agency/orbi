// ─────────────────────────────────────────────────────────────────────────────
// blockedSenders.ts — port of routes/blocked-senders.
//
// Either `emailAddress` or `domain` (XOR). Uniqueness is enforced in the
// add() mutation since Convex doesn't have unique-constraint enforcement.
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./lib/auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const blocked = await ctx.db
      .query("blockedSenders")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    blocked.sort((a, b) => b._creationTime - a._creationTime);
    return blocked;
  },
});

export const add = mutation({
  args: {
    emailAddress: v.optional(v.string()),
    domain: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    if (!args.emailAddress && !args.domain) {
      throw new Error("Provide emailAddress or domain");
    }

    const emailAddress = args.emailAddress
      ? args.emailAddress.toLowerCase().trim()
      : undefined;
    const domain = args.domain
      ? args.domain.toLowerCase().trim().replace(/^@/, "")
      : undefined;

    // Uniqueness check
    if (emailAddress) {
      const existing = await ctx.db
        .query("blockedSenders")
        .withIndex("by_user_email", (q) =>
          q.eq("userId", userId).eq("emailAddress", emailAddress),
        )
        .first();
      if (existing) throw new Error("Already blocked");
    } else if (domain) {
      const existing = await ctx.db
        .query("blockedSenders")
        .withIndex("by_user_domain", (q) =>
          q.eq("userId", userId).eq("domain", domain),
        )
        .first();
      if (existing) throw new Error("Already blocked");
    }

    const id = await ctx.db.insert("blockedSenders", {
      userId,
      emailAddress,
      domain,
      reason: args.reason,
    });
    return await ctx.db.get(id);
  },
});

export const remove = mutation({
  args: { id: v.id("blockedSenders") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const blocked = await ctx.db.get(id);
    if (!blocked || blocked.userId !== userId) throw new Error("Not found");
    await ctx.db.delete(id);
    return { success: true };
  },
});
