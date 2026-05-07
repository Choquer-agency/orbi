// ─────────────────────────────────────────────────────────────────────────────
// classifications.ts — port of routes/classifications/index.ts.
//
// - listCategories (public query, frozen list)
// - getClassification (per-email)
// - classifyEmail (mutation that schedules an internal action)
// - overrideClassification
// - routingRules CRUD
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { requireUser } from "./lib/auth";

const DEFAULT_CATEGORIES = [
  { id: "revision_request", label: "Revision Request", color: "#F97316" },
  { id: "billing", label: "Billing", color: "#10B981" },
  { id: "new_inquiry", label: "New Inquiry", color: "#3B82F6" },
  { id: "project_update", label: "Project Update", color: "#8B5CF6" },
  { id: "meeting_scheduling", label: "Meeting", color: "#14B8A6" },
  { id: "feedback", label: "Feedback", color: "#EAB308" },
  { id: "support_request", label: "Support", color: "#EF4444" },
  { id: "internal", label: "Internal", color: "#93C5FD" },
  { id: "notification", label: "Notification", color: "#60A5FA" },
  { id: "marketing", label: "Marketing", color: "#F472B6" },
  { id: "spam", label: "Spam", color: "#FB923C" },
  { id: "other", label: "Other", color: "#D1D5DB" },
];

export const listCategories = query({
  args: {},
  handler: async (ctx) => {
    await requireUser(ctx);
    return DEFAULT_CATEGORIES;
  },
});

export const getClassification = query({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    await requireUser(ctx);
    const cls = await ctx.db
      .query("emailClassifications")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .unique();
    if (!cls) throw new Error("No classification found");
    return cls;
  },
});

export const classifyEmail = mutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    await requireUser(ctx);
    // Schedule the classification action; replaces BullMQ enqueue.
    await ctx.scheduler.runAfter(0, internal.ai.classifier.classifyEmail, {
      emailId,
    });
    return { message: "Classification queued" };
  },
});

export const overrideClassification = mutation({
  args: { emailId: v.id("emails"), category: v.string() },
  handler: async (ctx, { emailId, category }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("emailClassifications")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .unique();
    if (!existing) throw new Error("No classification found");
    await ctx.db.patch(existing._id, {
      category,
      manualOverride: true,
      overriddenBy: userId,
    });
    return await ctx.db.get(existing._id);
  },
});

// ── Routing Rules ───────────────────────────────────────────────────────────

export const listRoutingRules = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const rules = await ctx.db
      .query("routingRules")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rules.sort((a, b) => a.category.localeCompare(b.category));
  },
});

export const createRoutingRule = mutation({
  args: {
    category: v.string(),
    assignToUserId: v.optional(v.id("users")),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, { category, assignToUserId, priority }) => {
    const userId = await requireUser(ctx);
    const id = await ctx.db.insert("routingRules", {
      userId,
      category,
      assignToUserId,
      priority: priority ?? 0,
      isActive: true,
    });
    return await ctx.db.get(id);
  },
});

export const updateRoutingRule = mutation({
  args: {
    id: v.id("routingRules"),
    assignToUserId: v.optional(v.union(v.id("users"), v.null())),
    isActive: v.optional(v.boolean()),
    priority: v.optional(v.number()),
  },
  handler: async (ctx, { id, assignToUserId, isActive, priority }) => {
    const userId = await requireUser(ctx);
    const rule = await ctx.db.get(id);
    if (!rule || rule.userId !== userId) {
      throw new Error("Routing rule not found");
    }
    const updates: Record<string, unknown> = {};
    if (assignToUserId !== undefined) {
      updates.assignToUserId = assignToUserId === null ? undefined : assignToUserId;
    }
    if (isActive !== undefined) updates.isActive = isActive;
    if (priority !== undefined) updates.priority = priority;
    await ctx.db.patch(id, updates);
    return await ctx.db.get(id);
  },
});

export const deleteRoutingRule = mutation({
  args: { id: v.id("routingRules") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const rule = await ctx.db.get(id);
    if (!rule || rule.userId !== userId) {
      throw new Error("Routing rule not found");
    }
    await ctx.db.delete(id);
    return { message: "Deleted" };
  },
});
