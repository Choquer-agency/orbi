// ─────────────────────────────────────────────────────────────────────────────
// meetingDetectorData.ts — V8-runtime queries/mutations for meetingDetector.ts.
// Split out because meetingDetector.ts uses "use node" for the Anthropic SDK.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";

export const _getEmailForDetection = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const email = await ctx.db.get(emailId);
    if (!email) return null;
    // Check existing detection — by_email index isn't defined; scan threadId list.
    const existing = await ctx.db
      .query("meetingDetections")
      .withIndex("by_thread", (q) => q.eq("threadId", email.threadId))
      .collect();
    const match = existing.find((m) => m.emailId === emailId);
    return {
      email: {
        id: email._id,
        threadId: email.threadId,
        subject: email.subject,
        bodyText: email.bodyText,
        fromAddress: email.fromAddress,
        fromName: email.fromName,
      },
      existing: match || null,
    };
  },
});

export const _persistDetection = internalMutation({
  args: {
    emailId: v.id("emails"),
    threadId: v.id("threads"),
    requestedTimes: v.any(),
    summary: v.optional(v.string()),
    attendees: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("meetingDetections", {
      emailId: args.emailId,
      threadId: args.threadId,
      status: "DETECTED",
      requestedTimes: args.requestedTimes,
      summary: args.summary,
      attendees: args.attendees,
    });
    return await ctx.db.get(id);
  },
});
