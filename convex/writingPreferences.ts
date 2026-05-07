// ─────────────────────────────────────────────────────────────────────────────
// writingPreferences.ts — port of routes/settings/writing-preferences.ts.
//
// CRUD for the user's writing preferences, per-contact style overrides, and
// learned style corrections (read-only listing + delete).
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./lib/auth";

// ── Writing preferences ─────────────────────────────────────────────────────

export const getPreferences = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const prefs = await ctx.db
      .query("writingPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return prefs;
  },
});

export const updatePreferences = mutation({
  args: {
    greetingStyle: v.optional(v.string()),
    signOffStyle: v.optional(v.string()),
    tone: v.optional(v.number()),
    verbosity: v.optional(v.number()),
    descriptors: v.optional(v.array(v.string())),
    customRules: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("writingPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    if (existing) {
      const updates: Record<string, unknown> = {};
      if (args.greetingStyle !== undefined) updates.greetingStyle = args.greetingStyle;
      if (args.signOffStyle !== undefined) updates.signOffStyle = args.signOffStyle;
      if (args.tone !== undefined) updates.tone = args.tone;
      if (args.verbosity !== undefined) updates.verbosity = args.verbosity;
      if (args.descriptors !== undefined) updates.descriptors = args.descriptors;
      if (args.customRules !== undefined) updates.customRules = args.customRules;
      await ctx.db.patch(existing._id, updates);
      return await ctx.db.get(existing._id);
    }

    const id = await ctx.db.insert("writingPreferences", {
      userId,
      greetingStyle: args.greetingStyle,
      signOffStyle: args.signOffStyle,
      tone: args.tone ?? 3,
      verbosity: args.verbosity ?? 3,
      descriptors: args.descriptors ?? [],
      customRules: args.customRules ?? [],
    });
    return await ctx.db.get(id);
  },
});

// ── Contact styles ───────────────────────────────────────────────────────────

export const listContactStyles = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    // No "by_user" only index; fall back to scanning by_user_email for this user.
    const all = await ctx.db
      .query("contactStyles")
      .withIndex("by_user_email", (q) => q.eq("userId", userId))
      .collect();
    return all.sort((a, b) => b._creationTime - a._creationTime);
  },
});

export const upsertContactStyle = mutation({
  args: {
    contactEmail: v.string(),
    contactName: v.optional(v.string()),
    tone: v.optional(v.number()),
    verbosity: v.optional(v.number()),
    greetingStyle: v.optional(v.string()),
    signOffStyle: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("contactStyles")
      .withIndex("by_user_email", (q) =>
        q.eq("userId", userId).eq("contactEmail", args.contactEmail),
      )
      .unique();

    if (existing) {
      const updates: Record<string, unknown> = { isAutoLearned: false };
      if (args.contactName !== undefined) updates.contactName = args.contactName;
      if (args.tone !== undefined) updates.tone = args.tone;
      if (args.verbosity !== undefined) updates.verbosity = args.verbosity;
      if (args.greetingStyle !== undefined) updates.greetingStyle = args.greetingStyle;
      if (args.signOffStyle !== undefined) updates.signOffStyle = args.signOffStyle;
      if (args.notes !== undefined) updates.notes = args.notes;
      await ctx.db.patch(existing._id, updates);
      return await ctx.db.get(existing._id);
    }

    const id = await ctx.db.insert("contactStyles", {
      userId,
      contactEmail: args.contactEmail,
      contactName: args.contactName,
      tone: args.tone,
      verbosity: args.verbosity,
      greetingStyle: args.greetingStyle,
      signOffStyle: args.signOffStyle,
      notes: args.notes,
      isAutoLearned: false,
    });
    return await ctx.db.get(id);
  },
});

export const deleteContactStyle = mutation({
  args: { contactEmail: v.string() },
  handler: async (ctx, { contactEmail }) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("contactStyles")
      .withIndex("by_user_email", (q) =>
        q.eq("userId", userId).eq("contactEmail", contactEmail),
      )
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    return { deleted: !!existing };
  },
});

// ── Style corrections (list + delete only — creation lives in ai/learn.ts) ──

export const listStyleCorrections = query({
  args: {
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, { limit, offset }) => {
    const userId = await requireUser(ctx);
    const take = Math.min(limit ?? 20, 100);
    const skip = offset ?? 0;

    // Get general (no contact) corrections by index scan; we iterate two index
    // calls (one per `contactEmail` value) and merge — but for "all" we can't
    // efficiently filter only by user across both `null` and concrete values
    // without a per-user-only index. The schema has `by_user_contactEmail`, so
    // we scan that with the eq("userId", …) prefix.
    const all = await ctx.db
      .query("styleCorrections")
      .withIndex("by_user_contactEmail", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();

    const totalCount = all.length;
    const slice = all.slice(skip, skip + take);

    const corrections = slice.map((c) => ({
      id: c._id,
      category: c.category,
      summary: c.summary,
      contactEmail: c.contactEmail,
      originalText: c.originalText.slice(0, 200),
      editedText: c.editedText.slice(0, 200),
      createdAt: c._creationTime,
    }));

    return { corrections, totalCount };
  },
});

export const deleteStyleCorrection = mutation({
  args: { id: v.id("styleCorrections") },
  handler: async (ctx, { id }) => {
    const userId = await requireUser(ctx);
    const c = await ctx.db.get(id);
    if (!c || c.userId !== userId) throw new Error("Correction not found");
    await ctx.db.delete(id);
    return { deleted: true };
  },
});
