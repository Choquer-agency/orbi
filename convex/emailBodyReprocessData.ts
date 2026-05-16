import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

export const _page = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("emailBodies")
      .order("asc")
      .paginate({ numItems: 4, cursor: cursor ?? null });
    return {
      rows: page.page.map((r) => ({ bodyId: r._id, emailId: r.emailId })),
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const _getSource = internalQuery({
  args: { bodyId: v.id("emailBodies"), emailId: v.id("emails") },
  handler: async (ctx, { bodyId, emailId }) => {
    const body = await ctx.db.get(bodyId);
    if (!body) return null;
    const email = await ctx.db.get(emailId);
    return {
      bodyHtml: body.bodyHtml,
      bodyText: body.bodyText,
      subject: email?.subject,
    };
  },
});

export const _writeBack = internalMutation({
  args: {
    bodyId: v.id("emailBodies"),
    emailId: v.id("emails"),
    bodyHtmlClean: v.optional(v.string()),
    bodyHtmlTrimmed: v.optional(v.string()),
    hasQuotedHistory: v.boolean(),
    isForwarded: v.boolean(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.bodyId, {
      bodyHtmlClean: args.bodyHtmlClean,
      bodyHtmlTrimmed: args.bodyHtmlTrimmed,
      hasQuotedHistory: args.hasQuotedHistory,
      isForwarded: args.isForwarded,
    });
    await ctx.db.patch(args.emailId, {
      hasQuotedHistory: args.hasQuotedHistory,
      isForwarded: args.isForwarded,
    });
  },
});
