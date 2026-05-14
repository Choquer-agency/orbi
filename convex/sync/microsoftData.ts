// ─────────────────────────────────────────────────────────────────────────────
// microsoftData.ts — V8-runtime data layer for Microsoft Graph sync.
//
// Mirrors the shape of `gmailData.ts` so a single sync action can pivot off
// the provider field. Microsoft uses Graph "delta" links (a fully-formed URL
// that captures the cursor) which we store directly in `mailAccounts.syncCursor`.
// ─────────────────────────────────────────────────────────────────────────────

import { internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { promisedFollowUpText } from "../lib/promiseDetector";
import type { Doc, Id } from "../_generated/dataModel";

// ─────────────────────────────────────────────────────────────────────────────
// Account discovery (cron uses this to schedule periodic syncs).
// ─────────────────────────────────────────────────────────────────────────────

export const _listActiveAccounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("mailAccounts").collect();
    return all
      .filter((a) => a.provider === "MICROSOFT" && a.isActive)
      .map((a) => ({
        _id: a._id,
        userId: a.userId,
        email: a.email,
      }));
  },
});

/**
 * Single-account fetch used by the trigger action. Returns the data the Node
 * sync action needs: ownership info, cursor, and the user's other mailbox
 * addresses (used to identify outbound vs inbound messages).
 */
export const _getAccountForSync = internalQuery({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }) => {
    const account = await ctx.db.get(accountId);
    if (!account) return null;
    const peers = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", account.userId))
      .collect();
    return {
      _id: account._id,
      userId: account.userId,
      email: account.email,
      provider: account.provider,
      isActive: account.isActive,
      syncCursor: account.syncCursor ?? null,
      historicalSyncStatus: account.historicalSyncStatus,
      historicalSyncProgress: account.historicalSyncProgress ?? null,
      userEmails: peers.map((p) => p.email.toLowerCase()),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Sync cursor + historical progress
// ─────────────────────────────────────────────────────────────────────────────

export const _getSyncCursor = internalQuery({
  args: { accountId: v.id("mailAccounts") },
  handler: async (ctx, { accountId }) => {
    const account = await ctx.db.get(accountId);
    if (!account) return null;
    return {
      syncCursor: account.syncCursor ?? null,
      historicalSyncStatus: account.historicalSyncStatus,
      historicalSyncProgress: account.historicalSyncProgress ?? null,
      userId: account.userId,
      email: account.email,
    };
  },
});

export const _setSyncCursor = internalMutation({
  args: {
    accountId: v.id("mailAccounts"),
    syncCursor: v.optional(v.string()),
    lastSyncAt: v.optional(v.number()),
  },
  handler: async (ctx, { accountId, syncCursor, lastSyncAt }) => {
    const patch: Partial<Doc<"mailAccounts">> = {};
    if (syncCursor !== undefined) patch.syncCursor = syncCursor;
    if (lastSyncAt !== undefined) patch.lastSyncAt = lastSyncAt;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(accountId, patch);
    }
  },
});

export const _setHistoricalProgress = internalMutation({
  args: {
    accountId: v.id("mailAccounts"),
    progress: v.optional(v.any()),
    status: v.optional(
      v.union(
        v.literal("IDLE"),
        v.literal("IN_PROGRESS"),
        v.literal("COMPLETED"),
        v.literal("FAILED"),
      ),
    ),
    completedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const patch: Partial<Doc<"mailAccounts">> = {};
    if (args.progress !== undefined) patch.historicalSyncProgress = args.progress;
    if (args.status !== undefined) patch.historicalSyncStatus = args.status;
    if (args.completedAt !== undefined)
      patch.historicalSyncCompletedAt = args.completedAt;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.accountId, patch);
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Email existence check (used to decide whether to fetch attachments).
// ─────────────────────────────────────────────────────────────────────────────

export const _existsByProviderMessageId = internalQuery({
  args: { providerMessageId: v.string() },
  handler: async (ctx, { providerMessageId }) => {
    const existing = await ctx.db
      .query("emails")
      .withIndex("by_providerMessageId", (q) =>
        q.eq("providerMessageId", providerMessageId),
      )
      .unique();
    return existing ? existing._id : null;
  },
});

/**
 * Lookup an email by its providerMessageId for the delta-delete branch.
 * Returns just the ids needed to clean up the row (and possibly the parent
 * thread if it becomes empty).
 */
export const _findEmailByProviderId = internalQuery({
  args: { providerMessageId: v.string() },
  handler: async (ctx, { providerMessageId }) => {
    const existing = await ctx.db
      .query("emails")
      .withIndex("by_providerMessageId", (q) =>
        q.eq("providerMessageId", providerMessageId),
      )
      .unique();
    if (!existing) return null;
    return { _id: existing._id, threadId: existing.threadId };
  },
});

/**
 * Delete an email and (if its thread is now empty) the thread + its
 * comments. Mirrors the source-side post-delete cleanup.
 */
export const _deleteEmail = internalMutation({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const email = await ctx.db.get(emailId);
    if (!email) return;
    const threadId = email.threadId;
    await ctx.db.delete(emailId);

    const remaining = await ctx.db
      .query("emails")
      .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", threadId))
      .collect();
    if (remaining.length > 0) return;

    const comments = await ctx.db
      .query("threadComments")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    for (const c of comments) await ctx.db.delete(c._id);
    await ctx.db.delete(threadId);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Thread upsert (by accountId + providerThreadId).
// ─────────────────────────────────────────────────────────────────────────────

export const _upsertThread = internalMutation({
  args: {
    accountId: v.id("mailAccounts"),
    providerThreadId: v.string(),
    subject: v.string(),
    snippet: v.optional(v.string()),
    isRead: v.boolean(),
    isStarred: v.boolean(),
    isArchived: v.boolean(),
    isTrashed: v.boolean(),
    labels: v.array(v.string()),
    participantEmails: v.array(v.string()),
    messageCount: v.number(),
    lastMessageAt: v.number(),
    lastReceivedAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Id<"threads">> => {
    const existing = await ctx.db
      .query("threads")
      .withIndex("by_account_providerThreadId", (q) =>
        q
          .eq("accountId", args.accountId)
          .eq("providerThreadId", args.providerThreadId),
      )
      .unique();

    const data = {
      accountId: args.accountId,
      providerThreadId: args.providerThreadId,
      subject: args.subject,
      snippet: args.snippet,
      isRead: args.isRead,
      isStarred: args.isStarred,
      isArchived: args.isArchived,
      isTrashed: args.isTrashed,
      labels: args.labels,
      participantEmails: args.participantEmails,
      messageCount: args.messageCount,
      lastMessageAt: args.lastMessageAt,
      ...(args.lastReceivedAt !== undefined
        ? { lastReceivedAt: args.lastReceivedAt }
        : {}),
    };

    if (existing) {
      await ctx.db.patch(existing._id, data);
      return existing._id;
    }
    return await ctx.db.insert("threads", data);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Email upsert.
// ─────────────────────────────────────────────────────────────────────────────

export const _upsertEmail = internalMutation({
  args: {
    accountId: v.id("mailAccounts"),
    threadId: v.id("threads"),
    providerMessageId: v.string(),
    internetMessageId: v.optional(v.string()),
    inReplyTo: v.optional(v.string()),
    references: v.array(v.string()),
    fromAddress: v.string(),
    fromName: v.optional(v.string()),
    toAddresses: v.any(),
    ccAddresses: v.optional(v.any()),
    bccAddresses: v.optional(v.any()),
    subject: v.string(),
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    snippet: v.optional(v.string()),
    isRead: v.boolean(),
    isStarred: v.boolean(),
    isDraft: v.boolean(),
    labels: v.array(v.string()),
    hasAttachments: v.boolean(),
    receivedAt: v.number(),
    sentAt: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ emailId: Id<"emails">; isNew: boolean }> => {
    const existing = await ctx.db
      .query("emails")
      .withIndex("by_providerMessageId", (q) =>
        q.eq("providerMessageId", args.providerMessageId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        threadId: args.threadId,
        isRead: args.isRead,
        isStarred: args.isStarred,
        labels: args.labels,
      });
      return { emailId: existing._id, isNew: false };
    }

    const emailId = await ctx.db.insert("emails", {
      accountId: args.accountId,
      threadId: args.threadId,
      providerMessageId: args.providerMessageId,
      internetMessageId: args.internetMessageId,
      inReplyTo: args.inReplyTo,
      references: args.references,
      fromAddress: args.fromAddress,
      fromName: args.fromName,
      toAddresses: args.toAddresses,
      ccAddresses: args.ccAddresses,
      bccAddresses: args.bccAddresses,
      subject: args.subject,
      bodyText: args.bodyText,
      bodyHtml: args.bodyHtml,
      snippet: args.snippet,
      isRead: args.isRead,
      isStarred: args.isStarred,
      isDraft: args.isDraft,
      labels: args.labels,
      hasAttachments: args.hasAttachments,
      receivedAt: args.receivedAt,
      sentAt: args.sentAt,
      sendStatus: "NONE",
      sendAttempts: 0,
    });
    return { emailId, isNew: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Attachment metadata insertion.
// ─────────────────────────────────────────────────────────────────────────────

export const _insertAttachments = internalMutation({
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
    for (const att of attachments) {
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

// ─────────────────────────────────────────────────────────────────────────────
// Read the body + send-context for an inbound email when we need to send an
// OOO auto-reply. Returns null if the email or the thread/account were
// deleted between insertion and the auto-reply scheduler.
// ─────────────────────────────────────────────────────────────────────────────

export const _getEmailForReply = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const email = await ctx.db.get(emailId);
    if (!email) return null;
    const thread = await ctx.db.get(email.threadId);
    if (!thread) return null;
    return {
      _id: email._id,
      fromAddress: email.fromAddress,
      fromName: email.fromName ?? null,
      subject: email.subject,
      internetMessageId: email.internetMessageId ?? null,
      references: email.references,
      providerMessageId: email.providerMessageId,
      threadProviderId: thread.providerThreadId,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-insert dispatch: blocked-sender check + contact extract +
// classification + notification + OOO auto-reply.
// Mirrors the gmail port's `_onNewEmailInserted` (Agent F).
// ─────────────────────────────────────────────────────────────────────────────

export const _onNewEmailInserted = internalMutation({
  args: {
    emailId: v.id("emails"),
    accountId: v.id("mailAccounts"),
    bodyText: v.optional(v.union(v.string(), v.null())),
    isOutbound: v.boolean(),
  },
  handler: async (ctx, { emailId, accountId, bodyText, isOutbound }) => {
    const email = await ctx.db.get(emailId);
    if (!email) return;
    const account = await ctx.db.get(accountId);
    if (!account) return;

    const senderEmail = email.fromAddress.toLowerCase().trim();
    const senderDomain = senderEmail.includes("@")
      ? senderEmail.split("@")[1]
      : "";

    // 1. Blocked sender → trash the thread and bail.
    const blockedByEmail = await ctx.db
      .query("blockedSenders")
      .withIndex("by_user_email", (q) =>
        q.eq("userId", account.userId).eq("emailAddress", senderEmail),
      )
      .first();
    let blocked = blockedByEmail;
    if (!blocked && senderDomain) {
      blocked =
        (await ctx.db
          .query("blockedSenders")
          .withIndex("by_user_domain", (q) =>
            q.eq("userId", account.userId).eq("domain", senderDomain),
          )
          .first()) ?? null;
    }
    if (blocked) {
      await ctx.db.patch(email.threadId, { isTrashed: true });
      return;
    }

    // 2. Auto-learn contact for the sender.
    await ctx.scheduler.runAfter(0, internal.contacts.upsertFromEmail, {
      userId: account.userId,
      email: senderEmail,
      name: email.fromName ?? null,
      isSender: true,
      isOutbound,
      bodyText: bodyText ?? null,
      receivedAt: email.receivedAt,
    });

    // 3. Schedule AI classification for inbound mail only. Outbound promise
    // follow-ups are handled here without an LLM call so mail sent from
    // Outlook web/desktop still gets tracked.
    if (!isOutbound) {
      await ctx.scheduler.runAfter(
        0,
        internal.ai.classifier.classifyEmailWithContext,
        { emailId, userId: account.userId },
      );
    } else {
      // Synthetic "sent" classification so downstream filters still surface
      // outbound mail without an LLM call.
      const existingClassification = await ctx.db
        .query("emailClassifications")
        .withIndex("by_email", (q) => q.eq("emailId", emailId))
        .unique();
      if (!existingClassification) {
        await ctx.db.insert("emailClassifications", {
          emailId,
          category: "sent",
          confidence: 1,
          urgency: "low",
          summary: undefined,
          manualOverride: false,
          overriddenBy: undefined,
        });
      }
      if (promisedFollowUpText(bodyText)) {
        const firstRecipient = Array.isArray(email.toAddresses)
          ? (email.toAddresses[0] as { email?: string } | undefined)?.email
          : undefined;
        const contactEmail = (firstRecipient ?? "").toLowerCase().trim();
        if (contactEmail) {
          await ctx.scheduler.runAfter(
            0,
            internal.followUps._ensureWatchForEmail,
            {
              userId: account.userId,
              threadId: email.threadId,
              emailId: String(emailId),
              contactEmail,
            },
          );
        }
      }
    }

    // 4. Notify the user (per-type prefs are enforced inside the helper).
    if (!isOutbound) {
      await ctx.scheduler.runAfter(
        0,
        internal.notifications.createIfAllowed,
        {
          userId: account.userId,
          type: "NEW_EMAIL" as const,
          title: email.fromName ?? email.fromAddress,
          body: email.subject,
          data: { threadId: email.threadId, emailId, accountId },
        },
      );
    }

    // 5. OOO auto-reply (only for inbound messages).
    if (!isOutbound) {
      const delegation = await ctx.db
        .query("outOfOfficeDelegations")
        .withIndex("by_user_isActive", (q) =>
          q.eq("userId", account.userId).eq("isActive", true),
        )
        .first();
      if (
        delegation &&
        delegation.autoReplyEnabled &&
        Date.now() >= delegation.startAt &&
        Date.now() <= delegation.endAt
      ) {
        await ctx.scheduler.runAfter(
          0,
          internal.sync.microsoft._sendAutoReplyIfAllowed,
          {
            delegationId: delegation._id,
            accountId,
            emailId,
          },
        );
      }
    }
  },
});
