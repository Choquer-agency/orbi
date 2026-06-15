// ─────────────────────────────────────────────────────────────────────────────
// onDemandBodyData.ts — V8 data layer for the on-demand body fetcher.
//
// Pair file to convex/sync/onDemandBody.ts. The action there fetches the full
// message from Gmail or Microsoft Graph (which can't run in V8 because the
// action sibling is "use node"); the mutations here write the result.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

// Look up everything the action needs in one round trip: email row, sibling
// account, and whether the body has already been fetched.
export const _lookupForBodyFetch = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const email = await ctx.db.get(emailId);
    if (!email) return null;
    const account = await ctx.db.get(email.accountId);
    if (!account) return null;
    const existingBody = await ctx.db
      .query("emailBodies")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .unique();
    return {
      email: {
        _id: email._id,
        accountId: email.accountId,
        providerMessageId: email.providerMessageId,
        subject: email.subject,
        hasAttachments: email.hasAttachments,
      },
      account: {
        _id: account._id,
        userId: account.userId,
        provider: account.provider,
      },
      hasBody: !!existingBody,
    };
  },
});

// All active mailbox accounts (any provider) — used by the one-time
// recent-body backfill (backfillRecentBodies).
export const _listActiveAccountIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("mailAccounts").collect();
    return all.filter((a) => a.isActive).map((a) => ({ _id: a._id }));
  },
});

// A page of email ids in [cutoffMs, beforeReceivedAt), newest first, for one
// account. Reads only the lean `emails` rows (bodies live in emailBodies) so
// the indexed range scan is cheap. Used by the recent-body backfill to find
// which messages still need their body pre-fetched.
export const _recentEmailIdsPage = internalQuery({
  args: {
    accountId: v.id("mailAccounts"),
    cutoffMs: v.number(),
    beforeReceivedAt: v.optional(v.number()),
    limit: v.number(),
  },
  handler: async (ctx, { accountId, cutoffMs, beforeReceivedAt, limit }) => {
    const rows = await ctx.db
      .query("emails")
      .withIndex("by_account_receivedAt", (q) => {
        const base = q.eq("accountId", accountId).gte("receivedAt", cutoffMs);
        return beforeReceivedAt !== undefined
          ? base.lt("receivedAt", beforeReceivedAt)
          : base;
      })
      .order("desc")
      .take(limit);
    return {
      ids: rows.map((e) => e._id),
      lastReceivedAt:
        rows.length > 0 ? rows[rows.length - 1].receivedAt : undefined,
      full: rows.length === limit,
    };
  },
});

// Persist a fetched body. Idempotent — patches the existing emailBodies row
// if one is present, otherwise inserts. Mirrors the legacy `_migrateOne`
// helper in emailBodyMigrateData.ts but lives here so the on-demand path
// doesn't reach into a "migration" namespace.
export const _persistBody = internalMutation({
  args: {
    emailId: v.id("emails"),
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    bodyHtmlClean: v.optional(v.string()),
    bodyHtmlTrimmed: v.optional(v.string()),
    hasQuotedHistory: v.boolean(),
    isForwarded: v.boolean(),
    hasAttachments: v.boolean(),
  },
  handler: async (ctx, args) => {
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
    // Patch hasAttachments on the email row — metadata-only ingest defaults
    // it to false, and only the on-demand fetch can confirm it.
    await ctx.db.patch(args.emailId, {
      hasAttachments: args.hasAttachments,
      hasQuotedHistory: args.hasQuotedHistory,
      isForwarded: args.isForwarded,
    });
  },
});

// Insert attachment metadata discovered during the on-demand fetch. Dedups
// by providerAttachmentId so repeat fetches don't double-insert.
export const _persistAttachments = internalMutation({
  args: {
    emailId: v.id("emails"),
    attachments: v.array(
      v.object({
        filename: v.string(),
        mimeType: v.string(),
        size: v.number(),
        providerAttachmentId: v.optional(v.string()),
        contentId: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { emailId, attachments }) => {
    const existing = await ctx.db
      .query("attachments")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .collect();
    const seen = new Set(
      existing
        .map((a) => a.providerAttachmentId)
        .filter((p): p is string => !!p),
    );
    for (const att of attachments) {
      if (att.providerAttachmentId && seen.has(att.providerAttachmentId)) {
        continue;
      }
      await ctx.db.insert("attachments", {
        emailId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        providerAttachmentId: att.providerAttachmentId,
        contentId: att.contentId,
      });
    }
  },
});
