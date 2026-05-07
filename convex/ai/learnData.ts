// ─────────────────────────────────────────────────────────────────────────────
// learnData.ts — V8-runtime mutation supporting learn.ts.
// Split out because learn.ts uses "use node" for the Anthropic SDK.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

export const _persistCorrection = internalMutation({
  args: {
    userId: v.id("users"),
    contactEmail: v.optional(v.string()),
    category: v.string(),
    originalText: v.string(),
    editedText: v.string(),
    summary: v.optional(v.string()),
    threadId: v.optional(v.string()),
    greetingChanged: v.optional(v.string()),
    signoffChanged: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("styleCorrections", {
      userId: args.userId,
      contactEmail: args.contactEmail,
      category: args.category,
      originalText: args.originalText.slice(0, 5000),
      editedText: args.editedText.slice(0, 5000),
      summary: args.summary,
      threadId: args.threadId,
    });

    if (args.contactEmail && (args.greetingChanged || args.signoffChanged)) {
      const existing = await ctx.db
        .query("contactStyles")
        .withIndex("by_user_email", (q) =>
          q.eq("userId", args.userId).eq("contactEmail", args.contactEmail!),
        )
        .unique();
      const updates: Record<string, unknown> = {};
      if (args.greetingChanged) updates.greetingStyle = args.greetingChanged;
      if (args.signoffChanged) updates.signOffStyle = args.signoffChanged;
      if (existing) {
        await ctx.db.patch(existing._id, updates);
      } else {
        await ctx.db.insert("contactStyles", {
          userId: args.userId,
          contactEmail: args.contactEmail,
          ...updates,
          isAutoLearned: true,
        });
      }
    }
  },
});
