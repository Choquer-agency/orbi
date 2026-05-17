// ─────────────────────────────────────────────────────────────────────────────
// searchProviderData.ts — V8 data layer for searchProvider.ts.
//
// The action sibling runs "use node" (fetch + provider parsing). DB queries
// and mutations live here so they execute in the V8 runtime.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export const _listSearchableAccounts = internalQuery({
  args: {
    userId: v.id("users"),
    accountId: v.optional(v.id("mailAccounts")),
  },
  handler: async (ctx, { userId, accountId }) => {
    if (accountId) {
      const a = await ctx.db.get(accountId);
      if (!a || a.userId !== userId || !a.isActive) return [];
      return [{ _id: a._id, provider: a.provider }];
    }
    const accounts = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return accounts
      .filter((a) => a.isActive)
      .map((a) => ({ _id: a._id, provider: a.provider }));
  },
});

// Upsert search hits as proper email + thread rows. Skips ones already in
// the DB. The body stays absent; the user's first click on the result
// triggers the regular on-demand body fetch.
export const _upsertSearchHits = internalMutation({
  args: {
    accountId: v.id("mailAccounts"),
    hits: v.array(
      v.object({
        providerMessageId: v.string(),
        providerThreadId: v.string(),
        subject: v.string(),
        snippet: v.string(),
        fromAddress: v.string(),
        fromName: v.optional(v.string()),
        toAddresses: v.array(
          v.object({ email: v.string(), name: v.optional(v.string()) }),
        ),
        ccAddresses: v.array(
          v.object({ email: v.string(), name: v.optional(v.string()) }),
        ),
        receivedAt: v.number(),
        isRead: v.boolean(),
        internetMessageId: v.optional(v.string()),
        labels: v.array(v.string()),
      }),
    ),
  },
  handler: async (ctx, { accountId, hits }) => {
    const emailIds: Id<"emails">[] = [];
    let imported = 0;
    for (const hit of hits) {
      const existing = await ctx.db
        .query("emails")
        .withIndex("by_providerMessageId", (q) =>
          q.eq("providerMessageId", hit.providerMessageId),
        )
        .unique();
      if (existing) {
        emailIds.push(existing._id);
        continue;
      }

      // Find or create the thread row.
      let threadId: Id<"threads">;
      const existingThread = await ctx.db
        .query("threads")
        .withIndex("by_account_providerThreadId", (q) =>
          q
            .eq("accountId", accountId)
            .eq("providerThreadId", hit.providerThreadId),
        )
        .unique();
      if (existingThread) {
        threadId = existingThread._id;
      } else {
        threadId = await ctx.db.insert("threads", {
          accountId,
          providerThreadId: hit.providerThreadId,
          subject: hit.subject,
          snippet: hit.snippet || undefined,
          isRead: hit.isRead,
          isStarred: false,
          isArchived:
            !hit.labels.includes("INBOX") && !hit.labels.includes("SENT"),
          isTrashed: hit.labels.includes("TRASH"),
          labels: hit.labels,
          participantEmails: [
            hit.fromAddress.toLowerCase(),
            ...hit.toAddresses.map((a) => a.email.toLowerCase()),
          ].filter(Boolean),
          messageCount: 1,
          lastMessageAt: hit.receivedAt,
          lastReceivedAt: hit.receivedAt,
        });
      }

      const emailId = await ctx.db.insert("emails", {
        accountId,
        threadId,
        providerMessageId: hit.providerMessageId,
        internetMessageId: hit.internetMessageId,
        inReplyTo: undefined,
        references: [],
        fromAddress: hit.fromAddress,
        fromName: hit.fromName,
        toAddresses: hit.toAddresses,
        ccAddresses: hit.ccAddresses,
        bccAddresses: undefined,
        subject: hit.subject,
        snippet: hit.snippet || undefined,
        isRead: hit.isRead,
        isStarred: false,
        isDraft: false,
        labels: hit.labels,
        hasAttachments: false,
        receivedAt: hit.receivedAt,
        sentAt: hit.labels.includes("SENT") ? hit.receivedAt : undefined,
        sendStatus: "NONE",
        sendAttempts: 0,
      });
      emailIds.push(emailId);
      imported++;
    }
    return { imported, emailIds };
  },
});
