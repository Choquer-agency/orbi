// emailBodyMigrateData.ts — read/write helpers for the body migration.
//
// `_pageEmails` walks `emails` in tiny windows by `_creationTime`. To stay
// under Convex's 16 MiB byte-read limit even when individual bodies are
// huge, we:
//   - never request more than `batchSize` rows (default 5)
//   - return only ids + a "needs migration" flag (full rows are still read
//     by the runtime, but at 5×N MB the total stays well below the cap as
//     long as batchSize is small enough)
//
// `_getInRowBody` reads exactly ONE email so each body read is isolated.
// `_migrateOne` writes the body into `emailBodies` and clears the in-row
// fields atomically.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

// We can't safely read multiple full email rows when bodies may be many MBs.
// Convex's `paginate({numItems:1})` is byte-aware and uses the system index
// internally — it bounds reads even when individual rows are huge. We page
// one row at a time, return its id + needsMigration, and pass back the
// opaque cursor so the action can loop.
export const _pageEmails = internalQuery({
  args: {
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { cursor }) => {
    // numItems is a target, not a hard limit — paginate is byte-aware and
    // will return fewer rows (or even 0) if doing so would exceed the byte
    // budget. We ask for up to 8 because most emails are <1 MB; heavy ones
    // get returned individually.
    const page = await ctx.db
      .query("emails")
      .order("asc")
      .paginate({ numItems: 8, cursor: cursor ?? null });
    if (page.page.length === 0) {
      return {
        rows: [],
        cursor: page.continueCursor,
        isDone: page.isDone,
      };
    }
    return {
      rows: page.page.map((row) => ({
        id: row._id,
        needsMigration:
          !!(row.bodyHtml || row.bodyText) && row.bodyHtmlClean === undefined,
      })),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const _getInRowBody = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const e = await ctx.db.get(emailId);
    if (!e) return null;
    return { bodyHtml: e.bodyHtml, bodyText: e.bodyText, subject: e.subject };
  },
});

export const _migrateOne = internalMutation({
  args: {
    emailId: v.id("emails"),
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    bodyHtmlClean: v.optional(v.string()),
    bodyHtmlTrimmed: v.optional(v.string()),
    hasQuotedHistory: v.boolean(),
    isForwarded: v.boolean(),
  },
  handler: async (ctx, args) => {
    // Has it already been migrated? If so, just patch in any missing fields.
    const existing = await ctx.db
      .query("emailBodies")
      .withIndex("by_email", (q) => q.eq("emailId", args.emailId))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        bodyText: args.bodyText,
        bodyHtml: args.bodyHtml,
        bodyHtmlClean: args.bodyHtmlClean,
        bodyHtmlTrimmed: args.bodyHtmlTrimmed,
        hasQuotedHistory: args.hasQuotedHistory,
        isForwarded: args.isForwarded,
      });
    } else {
      await ctx.db.insert("emailBodies", {
        emailId: args.emailId,
        bodyText: args.bodyText,
        bodyHtml: args.bodyHtml,
        bodyHtmlClean: args.bodyHtmlClean,
        bodyHtmlTrimmed: args.bodyHtmlTrimmed,
        hasQuotedHistory: args.hasQuotedHistory,
        isForwarded: args.isForwarded,
      });
    }
    // Clear the in-row body to free space on the hot row.
    await ctx.db.patch(args.emailId, {
      bodyText: undefined,
      bodyHtml: undefined,
      bodyHtmlClean: undefined,
      bodyHtmlTrimmed: undefined,
      hasQuotedHistory: args.hasQuotedHistory,
      isForwarded: args.isForwarded,
    });
  },
});
