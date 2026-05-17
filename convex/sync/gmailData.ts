// ─────────────────────────────────────────────────────────────────────────────
// gmailData.ts — V8-runtime data layer for Gmail sync.
//
// All DB reads/writes used by the Gmail sync actions live here so that
// `gmail.ts` and `gmailHistorical.ts` (which run "use node" for the Anthropic
// SDK and the Gmail REST calls) only contain actions.
//
// Naming convention: every internal helper is prefixed with `_` to mirror the
// rest of the Convex codebase.
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
      .filter((a) => a.provider === "GMAIL" && a.isActive)
      .map((a) => ({
        _id: a._id,
        userId: a.userId,
        email: a.email,
      }));
  },
});

/**
 * Single-account fetch used by the trigger action. Returns the data the
 * "use node" sync action needs: ownership check + cursor + user's other
 * mailbox addresses (so we can identify outbound vs inbound messages).
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
// Existence check for an email by its Gmail message id (used to skip
// already-synced messages without doing a full upsert round-trip).
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
      // Apply local-read lock: suppress read→unread regressions when the user
      // just marked the thread read in-app and Gmail hasn't reflected the
      // label change yet. New messages bump lastMessageAt so legitimate unreads
      // still come through.
      const patch: typeof data & { isRead?: boolean } = { ...data };
      const READ_LOCK_MS = 5 * 60 * 1000;
      const localReadRecent =
        existing.isRead === true &&
        existing.readStateLocalAt !== undefined &&
        Date.now() - existing.readStateLocalAt < READ_LOCK_MS;
      const noNewMessage =
        existing.lastMessageAt !== undefined &&
        args.lastMessageAt <= existing.lastMessageAt;
      if (localReadRecent && noNewMessage && args.isRead === false) {
        patch.isRead = true;
      }

      // Skip the patch entirely when nothing meaningful changed — Gmail's
      // history.list surfaces no-op delta events (importance recalcs, anti-spam
      // tagging, etc.). Avoiding the write keeps live-query re-fires minimal.
      const same =
        existing.subject === patch.subject &&
        existing.snippet === patch.snippet &&
        existing.isRead === patch.isRead &&
        existing.isStarred === patch.isStarred &&
        existing.isArchived === patch.isArchived &&
        existing.isTrashed === patch.isTrashed &&
        existing.messageCount === patch.messageCount &&
        existing.lastMessageAt === patch.lastMessageAt &&
        (existing.lastReceivedAt ?? undefined) ===
          (patch.lastReceivedAt ?? undefined) &&
        sameStringArray(existing.labels, patch.labels) &&
        sameStringArray(existing.participantEmails, patch.participantEmails);
      if (same) return existing._id;
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("threads", data);
  },
});

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Thread fingerprint — lets the Gmail sync action short-circuit before
// calling _upsertThread.
export const _getThreadFingerprint = internalQuery({
  args: {
    accountId: v.id("mailAccounts"),
    providerThreadId: v.string(),
  },
  handler: async (ctx, { accountId, providerThreadId }) => {
    const t = await ctx.db
      .query("threads")
      .withIndex("by_account_providerThreadId", (q) =>
        q.eq("accountId", accountId).eq("providerThreadId", providerThreadId),
      )
      .unique();
    if (!t) return null;
    return {
      id: t._id,
      subject: t.subject,
      snippet: t.snippet,
      isRead: t.isRead,
      isStarred: t.isStarred,
      isArchived: t.isArchived,
      isTrashed: t.isTrashed,
      labels: t.labels,
      participantEmails: t.participantEmails,
      messageCount: t.messageCount,
      lastMessageAt: t.lastMessageAt,
      lastReceivedAt: t.lastReceivedAt,
    };
  },
});

// Lightweight fingerprint used by the Gmail sync action to skip _upsertEmail
// (and the preprocess step) entirely when the delta payload didn't change
// anything we store.
export const _getEmailFingerprint = internalQuery({
  args: { providerMessageId: v.string() },
  handler: async (ctx, { providerMessageId }) => {
    const e = await ctx.db
      .query("emails")
      .withIndex("by_providerMessageId", (q) =>
        q.eq("providerMessageId", providerMessageId),
      )
      .unique();
    if (!e) return null;
    return {
      id: e._id,
      threadId: e.threadId,
      isRead: e.isRead,
      isStarred: e.isStarred,
      labels: e.labels,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Email upsert. If the email already exists (matched by providerMessageId)
// we only patch a few mutable fields (read state, labels, threadId in case
// the message moved between conversation groups). Otherwise insert fresh.
//
// Returns { emailId, isNew }. The action uses `isNew` to decide whether to
// fan out to classification / notifications / contact-extraction.
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
    // Optional — the sync action pre-processes the body before calling this
    // mutation and passes the cleaned/trimmed strings through. When absent
    // (e.g. backfill paths that haven't been migrated), the client falls
    // back to its own sanitization.
    bodyHtmlClean: v.optional(v.string()),
    bodyHtmlTrimmed: v.optional(v.string()),
    hasQuotedHistory: v.optional(v.boolean()),
    isForwarded: v.optional(v.boolean()),
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
      // No-op skip: Gmail's history.list fires deltas for label recomputes,
      // importance recalculations and inbox category reshuffles. Most arrive
      // with the same {threadId, isRead, isStarred, labels} we already have.
      const same =
        existing.threadId === args.threadId &&
        existing.isRead === args.isRead &&
        existing.isStarred === args.isStarred &&
        sameStringArray(existing.labels, args.labels);
      if (same) return { emailId: existing._id, isNew: false };
      await ctx.db.patch(existing._id, {
        threadId: args.threadId,
        isRead: args.isRead,
        isStarred: args.isStarred,
        labels: args.labels,
      });
      return { emailId: existing._id, isNew: false };
    }

    // New writes split heavy body bytes into the sibling `emailBodies` table
    // and leave bodyHtml/bodyText undefined on the row, so scans of `emails`
    // stay tiny. The viewer reads from `emailBodies` (with row fallback for
    // legacy emails that still have in-row bodies).
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
      hasQuotedHistory: args.hasQuotedHistory,
      isForwarded: args.isForwarded,
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
    if (args.bodyHtml || args.bodyText || args.bodyHtmlClean) {
      await ctx.db.insert("emailBodies", {
        emailId,
        bodyText: args.bodyText,
        bodyHtml: args.bodyHtml,
        bodyHtmlClean: args.bodyHtmlClean,
        bodyHtmlTrimmed: args.bodyHtmlTrimmed,
        hasQuotedHistory: args.hasQuotedHistory,
        isForwarded: args.isForwarded,
      });
    }
    return { emailId, isNew: true };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Insert any attachments described in the Gmail message payload. We only
// store metadata + the providerAttachmentId so the binary can be fetched on
// demand. Called once per inserted email (skipped on patches).
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
// Auto-reply context loader — gathers the delegation + the original email
// + the account in one round trip for the auto-reply action.
// ─────────────────────────────────────────────────────────────────────────────

export const _loadAutoReplyContext = internalQuery({
  args: {
    delegationId: v.id("outOfOfficeDelegations"),
    accountId: v.id("mailAccounts"),
    emailId: v.id("emails"),
  },
  handler: async (ctx, args) => {
    const delegation = await ctx.db.get(args.delegationId);
    if (!delegation) return null;
    const email = await ctx.db.get(args.emailId);
    if (!email) return null;
    const account = await ctx.db.get(args.accountId);
    if (!account) return null;
    return { delegation, email, account };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Cleanup of an empty thread that lost all its messages to a conversation
// split. Mirrors the Prisma version's post-split cleanup.
// ─────────────────────────────────────────────────────────────────────────────

export const _cleanupEmptyThread = internalMutation({
  args: {
    accountId: v.id("mailAccounts"),
    providerThreadId: v.string(),
  },
  handler: async (ctx, { accountId, providerThreadId }) => {
    const thread = await ctx.db
      .query("threads")
      .withIndex("by_account_providerThreadId", (q) =>
        q.eq("accountId", accountId).eq("providerThreadId", providerThreadId),
      )
      .unique();
    if (!thread) return;

    const emails = await ctx.db
      .query("emails")
      .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", thread._id))
      .collect();
    if (emails.length > 0) return;

    // Drop comments + thread access grants tied to this empty thread.
    const comments = await ctx.db
      .query("threadComments")
      .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
      .collect();
    for (const c of comments) await ctx.db.delete(c._id);
    await ctx.db.delete(thread._id);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-insert dispatch: blocked-sender check + contact extract +
// classification + notification + OOO auto-reply.
//
// Called once per NEW email (i.e. when _upsertEmail returns isNew=true).
// Uses ctx.scheduler to fan out work without blocking the sync action.
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

    // 1. Blocked sender → mark thread as trashed and stop.
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
      // Retention setting decides whether blocked mail goes to trash (and
      // gets purged by the daily sweeper after trashRetentionDays) or is
      // deleted right now on arrival. Default is "immediate delete" so the
      // mailbox stays minimal for explicitly-blocked senders.
      const ret = await ctx.db
        .query("retentionSettings")
        .withIndex("by_user", (q) => q.eq("userId", account.userId))
        .unique();
      const immediate = ret?.blockedSenderImmediate ?? true;
      if (immediate) {
        await ctx.scheduler.runAfter(
          0,
          internal.retention._deleteThreadCascade,
          { threadId: email.threadId },
        );
      } else {
        await ctx.db.patch(email.threadId, { isTrashed: true });
      }
      return;
    }

    // 2. Extract / auto-learn contact for the sender.
    await ctx.scheduler.runAfter(0, internal.contacts.upsertFromEmail, {
      userId: account.userId,
      email: senderEmail,
      name: email.fromName ?? null,
      isSender: true,
      isOutbound,
      bodyText: bodyText ?? null,
      receivedAt: email.receivedAt,
    });

    // 2b. Outbound emails: extract every recipient (TO/CC/BCC) so people the
    // user emails frequently surface in compose autocomplete. Skip the user's
    // own addresses so we don't add ourselves as a contact.
    if (isOutbound) {
      const userAccounts = await ctx.db
        .query("mailAccounts")
        .withIndex("by_user", (q) => q.eq("userId", account.userId))
        .collect();
      const selfEmails = new Set(
        userAccounts.map((a) => a.email.toLowerCase().trim()),
      );
      const rawRecipients = [
        ...((email.toAddresses as { email?: string; name?: string }[] | undefined) ?? []),
        ...((email.ccAddresses as { email?: string; name?: string }[] | undefined) ?? []),
        ...((email.bccAddresses as { email?: string; name?: string }[] | undefined) ?? []),
      ];
      for (const r of rawRecipients) {
        const addr = (r?.email ?? "").toLowerCase().trim();
        if (!addr || !addr.includes("@")) continue;
        if (selfEmails.has(addr)) continue;
        await ctx.scheduler.runAfter(0, internal.contacts.upsertFromEmail, {
          userId: account.userId,
          email: addr,
          name: r?.name ?? null,
          isSender: false,
          isOutbound: true,
          bodyText: null,
          receivedAt: email.receivedAt,
        });
      }
    }

    // 3. Schedule AI classification for RECENT inbound only (>90 days is
    // backfill — already triaged manually). Outbound gets a synthetic "sent"
    // classification (no LLM cost) plus optional follow-up watching.
    const CLASSIFY_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
    const isRecent = email.receivedAt > Date.now() - CLASSIFY_WINDOW_MS;
    if (!isOutbound && isRecent) {
      await ctx.scheduler.runAfter(
        0,
        internal.ai.classifier.classifyEmailWithContext,
        { emailId, userId: account.userId },
      );
    } else if (isOutbound) {
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

    // 3b. "Needs Response" scoring (recent inbound) / dismiss open signals
    // (outbound). Skips marketing/spam/notification internally. 2s delay so
    // classification lands first for the scorer's skip-list check.
    if (!isOutbound && isRecent) {
      await ctx.scheduler.runAfter(
        2_000,
        internal.ai.needsResponse.scoreEmail,
        { emailId, userId: account.userId },
      );
    } else {
      // Outbound: user just replied to a thread, so any open
      // needs-response signal on that thread is resolved. If the in-app
      // send-flow already dismissed it (kind="replied"), this is a no-op;
      // otherwise the user replied from another mailbox/client and we tag
      // it as auto-other-acc.
      await ctx.scheduler.runAfter(
        0,
        internal.ai.needsResponseData._dismissOpenSignalsForThread,
        { threadId: email.threadId, kind: "auto-other-acc" },
      );
    }

    // (Per-email NEW_EMAIL notifications removed: the bell now just shows
    // an unread-inbox count from threads.unreadCount. Storing 30k+ per-email
    // notification rows per user wasn't paying for itself.)

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
          internal.sync.gmail._sendAutoReplyIfAllowed,
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

// Used by sync/gmail.ts:repairOrphanThreads — finds threads with 0 email rows.
export const _listOrphanThreads = internalQuery({
  args: { accountId: v.id("mailAccounts"), limit: v.number() },
  handler: async (ctx, { accountId, limit }) => {
    const account = await ctx.db.get(accountId);
    if (!account) return [];
    const peers = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", account.userId))
      .collect();
    const userEmails = peers.map((p) => p.email.toLowerCase());

    // Scan recent threads for this account; skip ones that already have emails.
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_account_lastMessageAt", (q) => q.eq("accountId", accountId))
      .order("desc")
      .take(500); // bounded scan; orphans should sit at the top of recently-failed syncs

    const out: Array<{
      threadId: Id<"threads">;
      providerThreadId: string;
      userEmails: string[];
    }> = [];
    for (const t of threads) {
      if (out.length >= limit) break;
      const hasEmails = await ctx.db
        .query("emails")
        .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", t._id))
        .first();
      if (!hasEmails) {
        out.push({
          threadId: t._id,
          providerThreadId: t.providerThreadId,
          userEmails,
        });
      }
    }
    return out;
  },
});

// Used by sync/gmail.ts:refreshThread
export const _getThreadForRefresh = internalQuery({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get(threadId);
    if (!thread) return null;
    const account = await ctx.db.get(thread.accountId);
    if (!account) return null;
    // userEmails = all the user's mailbox addresses (for own-message detection)
    const peers = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", account.userId))
      .collect();
    return {
      providerThreadId: thread.providerThreadId,
      accountId: thread.accountId,
      ownerUserId: account.userId,
      provider: account.provider,
      userEmails: peers.map((p) => p.email.toLowerCase()),
    };
  },
});

// Used by sync/gmail.ts:refreshEmail
export const _getEmailForRefresh = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const email = await ctx.db.get(emailId);
    if (!email) return null;
    const account = await ctx.db.get(email.accountId);
    if (!account) return null;
    return {
      providerMessageId: email.providerMessageId,
      accountId: email.accountId,
      ownerUserId: account.userId,
      provider: account.provider,
    };
  },
});

export const _patchEmailBodyAndFrom = internalMutation({
  args: {
    emailId: v.id("emails"),
    fromAddress: v.string(),
    fromName: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    bodyText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Record<string, unknown> = {};
    if (args.fromAddress) patch.fromAddress = args.fromAddress;
    if (args.fromName !== undefined) patch.fromName = args.fromName;
    if (args.bodyHtml !== undefined) patch.bodyHtml = args.bodyHtml;
    if (args.bodyText !== undefined) patch.bodyText = args.bodyText;
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.emailId, patch);
    }
  },
});
