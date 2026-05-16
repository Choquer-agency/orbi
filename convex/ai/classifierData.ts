// ─────────────────────────────────────────────────────────────────────────────
// classifierData.ts — V8-runtime queries and mutations supporting classifier.ts.
// Split out because classifier.ts uses "use node" for the Anthropic SDK.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";

export const _getEmailForClassification = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const email = await ctx.db.get(emailId);
    if (!email) return null;
    const existing = await ctx.db
      .query("emailClassifications")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .unique();
    return {
      email: {
        id: email._id,
        accountId: email.accountId,
        threadId: email.threadId,
        subject: email.subject,
        fromAddress: email.fromAddress,
        fromName: email.fromName,
        bodyText: email.bodyText,
        snippet: email.snippet,
        isDraft: email.isDraft,
        sentAt: email.sentAt,
      },
      existing,
    };
  },
});

export const _getRecentTriageFeedback = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("triageFeedback")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(20);
    return rows.map((f) => ({
      subjectSnippet: f.subjectSnippet,
      senderAddress: f.senderAddress,
      finalCategory: f.finalCategory,
    }));
  },
});

export const _getSenderTriageRule = internalQuery({
  args: { userId: v.id("users"), senderAddress: v.string() },
  handler: async (ctx, { userId, senderAddress }) => {
    const sender = senderAddress.toLowerCase().trim();
    if (!sender) return null;
    const rows = await ctx.db
      .query("triageFeedback")
      .withIndex("by_user_sender", (q) =>
        q.eq("userId", userId).eq("senderAddress", sender),
      )
      .order("desc")
      .take(10);
    if (rows.length === 0) return null;

    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.finalCategory, (counts.get(row.finalCategory) ?? 0) + 1);
    }
    const [category, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      category,
      confidence: count >= 2 ? 0.99 : 0.95,
      examples: rows.length,
    };
  },
});

export const _persistClassification = internalMutation({
  args: {
    emailId: v.id("emails"),
    category: v.string(),
    confidence: v.number(),
    urgency: v.string(),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Re-check existing in case of races.
    const existing = await ctx.db
      .query("emailClassifications")
      .withIndex("by_email", (q) => q.eq("emailId", args.emailId))
      .unique();
    if (existing) return existing;
    const id = await ctx.db.insert("emailClassifications", {
      emailId: args.emailId,
      category: args.category,
      confidence: args.confidence,
      urgency: args.urgency,
      summary: args.summary,
      manualOverride: false,
      overriddenBy: undefined,
    });
    return await ctx.db.get(id);
  },
});
