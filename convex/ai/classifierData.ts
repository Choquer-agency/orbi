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
        subject: email.subject,
        fromAddress: email.fromAddress,
        fromName: email.fromName,
        bodyText: email.bodyText,
        snippet: email.snippet,
      },
      existing,
    };
  },
});

// Look up a per-user sender / domain override for a given from-address.
// Used by the classifier to short-circuit AI inference when the user has
// already told us where this sender belongs.
export const _getSenderOverride = internalQuery({
  args: { userId: v.id("users"), fromAddress: v.string() },
  handler: async (ctx, { userId, fromAddress }) => {
    const addr = fromAddress.toLowerCase().trim();
    if (!addr.includes("@")) return null;
    const domain = `@${addr.split("@")[1]}`;
    const rows = await ctx.db
      .query("senderTriageOverrides")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    let domainHit: string | null = null;
    for (const o of rows) {
      if (o.kind === "email" && o.pattern === addr) {
        // Exact email match wins outright.
        return { category: o.forceCategory, kind: "email" as const };
      }
      if (o.kind === "domain" && o.pattern === domain) {
        domainHit = o.forceCategory;
      }
    }
    return domainHit ? { category: domainHit, kind: "domain" as const } : null;
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

export const _persistClassification = internalMutation({
  args: {
    emailId: v.id("emails"),
    category: v.string(),
    // Kept as optional inbound args so existing callers don't have to change,
    // but we don't store them anymore. The Classification row is now just
    // (emailId, category, manualOverride). Dropped: confidence/urgency/summary
    // — none were displayed in the UI and they were ~40% of the row's bytes.
    confidence: v.optional(v.number()),
    urgency: v.optional(v.string()),
    summary: v.optional(v.string()),
    manualOverride: v.optional(v.boolean()),
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
      manualOverride: args.manualOverride ?? false,
    });
    return await ctx.db.get(id);
  },
});
