// ─────────────────────────────────────────────────────────────────────────────
// searchProviderData.ts — V8 data layer for searchProvider.ts.
//
// The action sibling runs "use node" (fetch + provider parsing). DB queries
// and mutations live here so they execute in the V8 runtime.
// ─────────────────────────────────────────────────────────────────────────────

import { v } from 'convex/values';
import { internalMutation, internalQuery, query } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { requireUser } from './lib/auth';
import { stampedThreadInsert, patchThread } from './lib/inboxStamp';

export const _listSearchableAccounts = internalQuery({
  args: {
    userId: v.id('users'),
    accountId: v.optional(v.id('mailAccounts')),
  },
  handler: async (ctx, { userId, accountId }) => {
    if (accountId) {
      const a = await ctx.db.get(accountId);
      if (!a || a.userId !== userId || !a.isActive) return [];
      return [{ _id: a._id, provider: a.provider, folderMap: a.msFolderMapCache?.entries ?? [] }];
    }
    const accounts = await ctx.db
      .query('mailAccounts')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(100);
    return accounts
      .filter((a) => a.isActive)
      .map((a) => ({
        _id: a._id,
        provider: a.provider,
        folderMap: a.msFolderMapCache?.entries ?? [],
      }));
  },
});

// Upsert search hits as proper email + thread rows. Skips ones already in
// the DB. The body stays absent; the user's first click on the result
// triggers the regular on-demand body fetch.
export const _upsertSearchHits = internalMutation({
  args: {
    accountId: v.id('mailAccounts'),
    hits: v.array(
      v.object({
        providerMessageId: v.string(),
        providerThreadId: v.string(),
        subject: v.string(),
        snippet: v.string(),
        fromAddress: v.string(),
        fromName: v.optional(v.string()),
        toAddresses: v.array(v.object({ email: v.string(), name: v.optional(v.string()) })),
        ccAddresses: v.array(v.object({ email: v.string(), name: v.optional(v.string()) })),
        receivedAt: v.number(),
        isRead: v.boolean(),
        isStarred: v.boolean(),
        isDraft: v.boolean(),
        hasAttachments: v.boolean(),
        internetMessageId: v.optional(v.string()),
        labels: v.array(v.string()),
      }),
    ),
  },
  handler: async (ctx, { accountId, hits }) => {
    const emailIds: Id<'emails'>[] = [];
    let imported = 0;
    const account = await ctx.db.get(accountId);
    if (!account) throw new Error('Account not found');
    for (const hit of hits) {
      const existing = await ctx.db
        .query('emails')
        .withIndex('by_accountId_and_providerMessageId', (q) =>
          q.eq('accountId', accountId).eq('providerMessageId', hit.providerMessageId),
        )
        .unique();
      if (existing) {
        emailIds.push(existing._id);
        continue;
      }

      const isSent =
        !hit.isDraft &&
        (hit.labels.includes('SENT') ||
          hit.fromAddress.toLowerCase() === account.email.toLowerCase());
      const participants = [
        ...new Set(
          [
            hit.fromAddress,
            ...hit.toAddresses.map((a) => a.email),
            ...hit.ccAddresses.map((a) => a.email),
          ]
            .map((e) => e.toLowerCase())
            .filter(Boolean),
        ),
      ];
      // Find or create the thread row.
      let threadId: Id<'threads'>;
      const existingThread = await ctx.db
        .query('threads')
        .withIndex('by_account_providerThreadId', (q) =>
          q.eq('accountId', accountId).eq('providerThreadId', hit.providerThreadId),
        )
        .unique();
      if (existingThread) {
        threadId = existingThread._id;
        // The provider may already have stamped the full conversation count.
        // Count a bounded prefix of stored messages before adding a missing hit.
        const storedMessages = await ctx.db
          .query('emails')
          .withIndex('by_thread_receivedAt', (q) => q.eq('threadId', threadId))
          .take(Math.min(existingThread.messageCount, 100));
        // Preserve current folder/read state when importing historical matches.
        await patchThread(ctx, threadId, {
          messageCount: Math.max(existingThread.messageCount, storedMessages.length + 1),
          participantEmails: [...new Set([...existingThread.participantEmails, ...participants])],
          lastMessageAt: Math.max(existingThread.lastMessageAt, hit.receivedAt),
          ...(!isSent && !hit.isDraft
            ? { lastReceivedAt: Math.max(existingThread.lastReceivedAt ?? 0, hit.receivedAt) }
            : {}),
          ...(isSent
            ? {
                hasSentMail: true,
                lastSentAt: Math.max(existingThread.lastSentAt ?? 0, hit.receivedAt),
              }
            : {}),
        });
      } else {
        threadId = await ctx.db.insert(
          'threads',
          stampedThreadInsert({
            accountId,
            providerThreadId: hit.providerThreadId,
            subject: hit.subject,
            snippet: hit.snippet || undefined,
            isRead: hit.isRead,
            isStarred: hit.isStarred,
            isArchived: !hit.labels.includes('INBOX') && !hit.labels.includes('SENT'),
            isTrashed: hit.labels.includes('TRASH'),
            labels: hit.labels,
            participantEmails: participants,
            messageCount: 1,
            lastMessageAt: hit.receivedAt,
            lastReceivedAt: !isSent && !hit.isDraft ? hit.receivedAt : undefined,
            hasSentMail: isSent,
            lastSentAt: isSent ? hit.receivedAt : undefined,
            isSpam: hit.labels.includes('SPAM'),
          }),
        );
      }

      const emailId = await ctx.db.insert('emails', {
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
        isStarred: hit.isStarred,
        isDraft: hit.isDraft,
        labels: hit.labels,
        hasAttachments: hit.hasAttachments,
        receivedAt: hit.receivedAt,
        sentAt: isSent ? hit.receivedAt : undefined,
        sendStatus: 'NONE',
        sendAttempts: 0,
      });
      emailIds.push(emailId);
      imported++;
    }
    return { imported, emailIds };
  },
});

// Hydrate the provider's actual matching emails. Re-running a local text
// search here would discard matches whose body has never been downloaded.
export const results = query({
  args: { emailIds: v.array(v.id('emails')) },
  handler: async (ctx, { emailIds }) => {
    const userId = await requireUser(ctx);
    if (emailIds.length > 100) throw new Error('Too many search results');
    const accounts = await ctx.db
      .query('mailAccounts')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .take(100);
    const owned = new Set(accounts.map((a) => a._id));
    const emails = await Promise.all([...new Set(emailIds)].map((id) => ctx.db.get(id)));
    const byThread = new Map<Id<'threads'>, NonNullable<(typeof emails)[number]>>();
    for (const email of emails) {
      if (!email || !owned.has(email.accountId)) continue;
      const current = byThread.get(email.threadId);
      if (!current || email.receivedAt > current.receivedAt) byThread.set(email.threadId, email);
    }
    const rows = await Promise.all(
      [...byThread].map(async ([threadId, email]) => {
        const thread = await ctx.db.get(threadId);
        if (!thread || !owned.has(thread.accountId) || thread.isTrashed) return null;
        const comments = await ctx.db
          .query('threadComments')
          .withIndex('by_thread', (q) => q.eq('threadId', threadId))
          .take(15);
        return {
          ...thread,
          id: thread._id,
          snippet: email.snippet ?? thread.snippet,
          // Search dates/previews describe the match, even in a long conversation.
          lastReceivedAt: email.receivedAt,
          emails: [
            {
              fromAddress: email.fromAddress,
              fromName: email.fromName,
              snippet: email.snippet,
              receivedAt: email.receivedAt,
              classification: null,
            },
          ],
          _count: { comments: comments.length },
          hasDraft: email.isDraft,
        };
      }),
    );
    return rows.filter((row) => row !== null).sort((a, b) => b.lastReceivedAt - a.lastReceivedAt);
  },
});
