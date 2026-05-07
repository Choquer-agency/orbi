// ─────────────────────────────────────────────────────────────────────────────
// notificationPreferences.ts — port of routes/settings/notification-preferences.
//
// Returns a default-shaped record if no row exists yet (read-only). Mutations
// upsert.
// ─────────────────────────────────────────────────────────────────────────────

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireUser } from "./lib/auth";

const DEFAULTS = {
  enableNewEmail: true,
  enableMention: true,
  enableComment: true,
  enableAssignment: true,
  enableSlaWarning: true,
  enableSlaBreach: true,
  enableSnoozeReminder: true,
  desktopEnabled: true,
  soundEnabled: true,
  pushEnabled: true,
  showPreviewOnLock: true,
};

export const get = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const prefs = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (prefs) return prefs;
    // Return defaults shape (no _id) so the UI has something to render before
    // the user explicitly saves.
    return { userId, ...DEFAULTS };
  },
});

export const update = mutation({
  args: {
    enableNewEmail: v.optional(v.boolean()),
    enableMention: v.optional(v.boolean()),
    enableComment: v.optional(v.boolean()),
    enableAssignment: v.optional(v.boolean()),
    enableSlaWarning: v.optional(v.boolean()),
    enableSlaBreach: v.optional(v.boolean()),
    enableSnoozeReminder: v.optional(v.boolean()),
    desktopEnabled: v.optional(v.boolean()),
    soundEnabled: v.optional(v.boolean()),
    pushEnabled: v.optional(v.boolean()),
    showPreviewOnLock: v.optional(v.boolean()),
    quietHoursStart: v.optional(v.union(v.string(), v.null())),
    quietHoursEnd: v.optional(v.union(v.string(), v.null())),
    quietHoursTimezone: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const existing = await ctx.db
      .query("notificationPreferences")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    // Build patch — convert null → undefined for optional v.string() fields
    const patch: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(args)) {
      if (val === undefined) continue;
      patch[k] = val === null ? undefined : val;
    }

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return await ctx.db.get(existing._id);
    }

    const id = await ctx.db.insert("notificationPreferences", {
      userId,
      ...DEFAULTS,
      ...patch,
    });
    return await ctx.db.get(id);
  },
});
