// ─────────────────────────────────────────────────────────────────────────────
// ooo.ts — port of routes/ooo (out-of-office delegation + auto-reply).
//
// Notable adds:
//   - getActiveDelegateForUser: read-only lookup the auto-reply worker uses
//     when an inbound email arrives, to decide whether to send an auto-reply.
//   - recordAutoReply: internal mutation called by the auto-reply worker after
//     it sends a reply, to dedupe future sends to the same sender.
//
// Schema field is `categories: v.array(v.string())` (named `autoReplyCategories`
// in the spec — preserved current shape).
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";

export const get = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const delegation = await ctx.db
      .query("outOfOfficeDelegations")
      .withIndex("by_user_isActive", (q) =>
        q.eq("userId", userId).eq("isActive", true),
      )
      .first();
    if (!delegation) return null;

    let delegate = null;
    if (delegation.delegateId) {
      const u = await ctx.db.get(delegation.delegateId);
      if (u) {
        delegate = {
          id: u._id,
          name: u.name ?? null,
          email: u.email ?? null,
          avatarUrl: u.avatarUrl ?? null,
        };
      }
    }
    return { ...delegation, delegate };
  },
});

export const create = mutation({
  args: {
    delegateId: v.optional(v.id("users")),
    startAt: v.number(),
    endAt: v.number(),
    autoReplyEnabled: v.optional(v.boolean()),
    autoReplyBody: v.optional(v.string()),
    autoReplySubject: v.optional(v.string()),
    autoReplyScope: v.optional(v.string()),
    categories: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const id = await ctx.db.insert("outOfOfficeDelegations", {
      userId,
      delegateId: args.delegateId,
      startAt: args.startAt,
      endAt: args.endAt,
      autoReplyEnabled: args.autoReplyEnabled ?? false,
      autoReplyBody: args.autoReplyBody,
      autoReplySubject: args.autoReplySubject,
      autoReplyScope: args.autoReplyScope ?? "all",
      isActive: true,
      categories: args.categories ?? [],
    });

    // Notify the delegate via internal helper that respects their prefs.
    if (args.delegateId) {
      const me = await ctx.db.get(userId);
      const startStr = new Date(args.startAt).toLocaleDateString();
      const endStr = new Date(args.endAt).toLocaleDateString();
      await ctx.runMutation(internal.notifications.createIfAllowed, {
        userId: args.delegateId,
        type: "ASSIGNMENT" as const,
        title: "You have been set as an OOO delegate",
        body: `${me?.name ?? "A teammate"} has set you as their delegate from ${startStr} to ${endStr}.`,
        data: { delegationId: id },
      });
    }
    return await ctx.db.get(id);
  },
});

export const update = mutation({
  args: {
    id: v.id("outOfOfficeDelegations"),
    endAt: v.optional(v.number()),
    autoReplyEnabled: v.optional(v.boolean()),
    autoReplyBody: v.optional(v.union(v.string(), v.null())),
    autoReplySubject: v.optional(v.union(v.string(), v.null())),
    autoReplyScope: v.optional(v.string()),
    categories: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const delegation = await ctx.db.get(args.id);
    if (!delegation || delegation.userId !== userId) {
      throw new Error("Delegation not found");
    }

    const updates: Partial<Doc<"outOfOfficeDelegations">> = {};
    if (args.endAt !== undefined) updates.endAt = args.endAt;
    if (args.autoReplyEnabled !== undefined)
      updates.autoReplyEnabled = args.autoReplyEnabled;
    if (args.autoReplyBody !== undefined)
      updates.autoReplyBody = args.autoReplyBody ?? undefined;
    if (args.autoReplySubject !== undefined)
      updates.autoReplySubject = args.autoReplySubject ?? undefined;
    if (args.autoReplyScope !== undefined)
      updates.autoReplyScope = args.autoReplyScope;
    if (args.categories !== undefined) updates.categories = args.categories;
    await ctx.db.patch(args.id, updates);
    return await ctx.db.get(args.id);
  },
});

export const cancel = mutation({
  args: { id: v.id("outOfOfficeDelegations") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const delegation = await ctx.db.get(id);
    if (!delegation || delegation.userId !== userId) {
      throw new Error("Delegation not found");
    }
    await ctx.db.patch(id, { isActive: false });
    return await ctx.db.get(id);
  },
});

/**
 * List active delegates (the workers + handoff banner use this).
 * Returns delegations where the current user is the delegate.
 */
export const myActiveAssignments = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    // Linear scan (small dataset). To optimize add a `by_delegate_isActive` index.
    const all = await ctx.db.query("outOfOfficeDelegations").collect();
    return all.filter(
      (d) => d.delegateId === userId && d.isActive,
    );
  },
});

// ── Internal helpers used by sync/auto-reply worker ─────────────────────────

/**
 * Look up the active OOO delegation for an account owner. Returns the
 * delegation only if `now` is within [startAt, endAt] and isActive.
 * Used by the auto-reply worker to decide whether to reply.
 */
export const getActiveDelegationForUser = internalQuery({
  args: { userId: v.id("users"), now: v.number() },
  handler: async (ctx, { userId, now }) => {
    const delegation = await ctx.db
      .query("outOfOfficeDelegations")
      .withIndex("by_user_isActive", (q) =>
        q.eq("userId", userId).eq("isActive", true),
      )
      .first();
    if (!delegation) return null;
    if (now < delegation.startAt || now > delegation.endAt) return null;
    return delegation;
  },
});

/**
 * Record that we've sent an auto-reply to a sender for this delegation.
 * Worker calls this after sending; future inbound from the same sender are
 * skipped (idempotency / dedupe).
 */
export const recordAutoReply = internalMutation({
  args: {
    delegationId: v.id("outOfOfficeDelegations"),
    senderAddress: v.string(),
  },
  handler: async (ctx, args) => {
    const sender = args.senderAddress.toLowerCase().trim();
    const existing = await ctx.db
      .query("autoReplyLogs")
      .withIndex("by_delegation_sender", (q) =>
        q.eq("delegationId", args.delegationId).eq("senderAddress", sender),
      )
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("autoReplyLogs", {
      delegationId: args.delegationId,
      senderAddress: sender,
      repliedAt: Date.now(),
    });
  },
});

/**
 * Has this delegation already auto-replied to this sender?
 */
export const hasAutoRepliedTo = internalQuery({
  args: {
    delegationId: v.id("outOfOfficeDelegations"),
    senderAddress: v.string(),
  },
  handler: async (ctx, args) => {
    const sender = args.senderAddress.toLowerCase().trim();
    const existing = await ctx.db
      .query("autoReplyLogs")
      .withIndex("by_delegation_sender", (q) =>
        q.eq("delegationId", args.delegationId).eq("senderAddress", sender),
      )
      .first();
    return !!existing;
  },
});
