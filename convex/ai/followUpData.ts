// ─────────────────────────────────────────────────────────────────────────────
// followUpData.ts — V8-runtime queries and mutations supporting checkWatch.
//
// Split out from followUp.ts because that file uses the node runtime
// ("use node") for the Anthropic SDK, and Convex disallows internalQuery /
// internalMutation in node-runtime files.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalQuery, internalMutation } from "../_generated/server";
import { buildThreadContext } from "../lib/threadContext";

export const _getWatch = internalQuery({
  args: { watchId: v.id("followUpWatches") },
  handler: async (ctx, { watchId }) => {
    const watch = await ctx.db.get(watchId);
    if (!watch) return null;
    return watch;
  },
});

export const _hasReplyAfter = internalQuery({
  args: {
    threadId: v.id("threads"),
    contactEmail: v.string(),
    afterMs: v.number(),
  },
  handler: async (ctx, { threadId, contactEmail, afterMs }) => {
    const emails = await ctx.db
      .query("emails")
      .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", threadId))
      .collect();
    return emails.some(
      (e) =>
        e.fromAddress.toLowerCase() === contactEmail.toLowerCase() &&
        e.receivedAt > afterMs,
    );
  },
});

export const _buildThreadContextForWatch = internalQuery({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const result = await buildThreadContext(ctx, threadId);
    return result.contextText;
  },
});

export const _markWatchReplied = internalMutation({
  args: { watchId: v.id("followUpWatches") },
  handler: async (ctx, { watchId }) => {
    await ctx.db.patch(watchId, {
      status: "REPLIED",
      resolvedAt: Date.now(),
    });
    await ctx.db.insert("followUpEvents", {
      watchId,
      type: "reply_received",
    });
  },
});

export const _markWatchExpired = internalMutation({
  args: { watchId: v.id("followUpWatches") },
  handler: async (ctx, { watchId }) => {
    await ctx.db.patch(watchId, {
      status: "EXPIRED",
      resolvedAt: Date.now(),
    });
  },
});

export const _advanceWatch = internalMutation({
  args: {
    watchId: v.id("followUpWatches"),
    nextStep: v.number(),
    nextCheckAt: v.number(),
    expired: v.boolean(),
    draftBody: v.string(),
    draftTone: v.string(),
  },
  handler: async (
    ctx,
    { watchId, nextStep, nextCheckAt, expired, draftBody, draftTone },
  ) => {
    await ctx.db.patch(watchId, {
      currentStep: nextStep,
      nextCheckAt,
      status: expired ? "EXPIRED" : "WATCHING",
    });
    await ctx.db.insert("followUpEvents", {
      watchId,
      type: "follow_up_drafted",
      draftBody,
      draftTone,
    });
  },
});
