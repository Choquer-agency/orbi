import type { Client } from '@microsoft/microsoft-graph-client';
import type { PrismaClient } from '@prisma/client';
import { getGraphClient, MESSAGE_SELECT_FIELDS } from './graph-client.js';
import { extractAndUpsertContacts } from '../contacts/extract-contacts.js';

interface SyncResult {
  threadsUpserted: number;
  emailsUpserted: number;
  errors: string[];
}

interface GraphRecipient {
  emailAddress: { address: string; name?: string };
}

interface GraphMessage {
  id: string;
  conversationId: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  from?: { emailAddress: { address: string; name?: string } };
  toRecipients: GraphRecipient[];
  ccRecipients: GraphRecipient[];
  bccRecipients: GraphRecipient[];
  receivedDateTime: string;
  sentDateTime?: string;
  isRead: boolean;
  isDraft: boolean;
  hasAttachments: boolean;
  flag?: { flagStatus: string };
  parentFolderId: string;
  internetMessageId?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  // Present when delta query marks a deletion
  '@removed'?: { reason: string };
}

/**
 * Parse recipients from Graph format to our format.
 */
function parseRecipients(recipients: GraphRecipient[]): { email: string; name?: string }[] {
  return (recipients || []).map((r) => ({
    email: r.emailAddress.address,
    ...(r.emailAddress.name ? { name: r.emailAddress.name } : {}),
  }));
}

/**
 * Get a header value from internetMessageHeaders.
 */
function getInternetHeader(
  headers: { name: string; value: string }[] | undefined,
  name: string,
): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/**
 * Resolve a parentFolderId to a well-known folder name.
 * Microsoft Graph returns GUIDs for parentFolderId, so we need to look up the actual folder.
 * We cache the mapping per sync run.
 */
const folderCache = new Map<string, Map<string, string[]>>();

async function resolveFolder(
  client: Client,
  accountId: string,
  parentFolderId: string,
): Promise<string[]> {
  if (!folderCache.has(accountId)) {
    // Build the cache by listing well-known folders
    const map = new Map<string, string[]>();
    try {
      const wellKnown = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'archive', 'junkemail'];
      const labelNames = ['INBOX', 'SENT', 'DRAFT', 'TRASH', 'ARCHIVE', 'SPAM'];
      for (let i = 0; i < wellKnown.length; i++) {
        try {
          const folder = await client.api(`/me/mailFolders/${wellKnown[i]}`).select('id').get();
          if (folder?.id) {
            map.set(folder.id, [labelNames[i]]);
          }
        } catch {
          // Folder may not exist (e.g., no archive folder)
        }
      }
    } catch {
      // If we can't list folders, we'll just return empty labels
    }
    folderCache.set(accountId, map);
  }

  return folderCache.get(accountId)!.get(parentFolderId) || [];
}

/**
 * Clear the folder cache for an account (call after sync completes).
 */
function clearFolderCache(accountId: string): void {
  folderCache.delete(accountId);
}

/**
 * Sync a Microsoft account using delta queries for incremental sync,
 * or full message listing for initial sync.
 */
export async function syncMicrosoftAccount(
  prisma: PrismaClient,
  accountId: string,
  maxResults = 500,
): Promise<SyncResult> {
  const { client, account } = await getGraphClient(prisma, accountId);
  const result: SyncResult = { threadsUpserted: 0, emailsUpserted: 0, errors: [] };

  // Gather all user email addresses for contact extraction
  const userAccounts = await prisma.account.findMany({
    where: { userId: account.userId },
    select: { email: true },
  });
  const userEmails = userAccounts.map((a) => a.email.toLowerCase());

  try {
    // If we have a syncCursor (deltaLink), try incremental sync
    if (account.syncCursor) {
      try {
        const incrementalResult = await incrementalSync(
          prisma, client, account, userEmails, result,
        );
        if (incrementalResult) {
          clearFolderCache(accountId);
          return incrementalResult;
        }
      } catch (err: any) {
        // Delta token expired (410 Gone) — fall back to full sync
        if (err.statusCode === 410 || err.code === 'SyncStateNotFound') {
          console.log(`[microsoft-sync] Delta token expired for ${account.email}, doing full sync`);
          await prisma.account.update({
            where: { id: accountId },
            data: { syncCursor: null },
          });
        } else {
          throw err;
        }
      }
    }

    // Full sync: fetch recent messages with pagination
    let fetched = 0;
    let nextLink: string | undefined;
    const url = `/me/messages?$select=${MESSAGE_SELECT_FIELDS}&$orderby=receivedDateTime desc&$top=50`;

    let response = await client.api(url).get();
    const conversationMessages = new Map<string, GraphMessage[]>();

    while (fetched < maxResults) {
      const messages: GraphMessage[] = response.value || [];
      if (messages.length === 0) break;

      for (const msg of messages) {
        if (!conversationMessages.has(msg.conversationId)) {
          conversationMessages.set(msg.conversationId, []);
        }
        conversationMessages.get(msg.conversationId)!.push(msg);
        fetched++;
        if (fetched >= maxResults) break;
      }

      nextLink = response['@odata.nextLink'];
      if (!nextLink || fetched >= maxResults) break;
      response = await client.api(nextLink).get();
    }

    // Upsert conversations as threads
    for (const [conversationId, messages] of conversationMessages) {
      try {
        await syncConversation(prisma, client, accountId, account.userId, conversationId, messages, userEmails);
        result.threadsUpserted++;
        result.emailsUpserted += messages.length;
      } catch (err: any) {
        result.errors.push(`Conversation ${conversationId}: ${err.message}`);
      }
    }

    // Get initial delta link for future incremental syncs
    try {
      const deltaLink = await getInitialDeltaLink(client);
      if (deltaLink) {
        await prisma.account.update({
          where: { id: accountId },
          data: { syncCursor: deltaLink, lastSyncAt: new Date() },
        });
      }
    } catch (err: any) {
      console.warn(`[microsoft-sync] Failed to get delta link: ${err.message}`);
      await prisma.account.update({
        where: { id: accountId },
        data: { lastSyncAt: new Date() },
      });
    }
  } catch (err: any) {
    result.errors.push(`Sync failed: ${err.message}`);
  }

  clearFolderCache(accountId);
  return result;
}

/**
 * Incremental sync using Microsoft Graph delta query.
 */
async function incrementalSync(
  prisma: PrismaClient,
  client: Client,
  account: { id: string; userId: string; syncCursor: string | null; email: string },
  userEmails: string[],
  result: SyncResult,
): Promise<SyncResult | null> {
  const deltaLink = account.syncCursor!;
  const changedConversations = new Map<string, GraphMessage[]>();
  const deletedMessageIds = new Set<string>();
  let newDeltaLink: string | undefined;
  let hasAnyChanges = false;

  // Page through all delta results
  let response = await client.api(deltaLink).get();

  while (true) {
    const messages: GraphMessage[] = response.value || [];

    for (const msg of messages) {
      hasAnyChanges = true;

      if (msg['@removed']) {
        deletedMessageIds.add(msg.id);
        continue;
      }

      if (!changedConversations.has(msg.conversationId)) {
        changedConversations.set(msg.conversationId, []);
      }
      changedConversations.get(msg.conversationId)!.push(msg);
    }

    if (response['@odata.nextLink']) {
      response = await client.api(response['@odata.nextLink']).get();
    } else {
      newDeltaLink = response['@odata.deltaLink'];
      break;
    }
  }

  if (!hasAnyChanges) {
    await prisma.account.update({
      where: { id: account.id },
      data: { lastSyncAt: new Date() },
    });
    return result;
  }

  // Handle deleted messages
  for (const msgId of deletedMessageIds) {
    try {
      const email = await prisma.email.findUnique({
        where: { providerMessageId: msgId },
        select: { id: true, threadId: true },
      });
      if (email) {
        await prisma.email.delete({ where: { id: email.id } });
        // Check if thread is now empty
        const remaining = await prisma.email.count({ where: { threadId: email.threadId } });
        if (remaining === 0) {
          await prisma.threadComment.deleteMany({ where: { threadId: email.threadId } });
          await prisma.thread.delete({ where: { id: email.threadId } });
        }
      }
    } catch (err: any) {
      result.errors.push(`Delete msg ${msgId}: ${err.message}`);
    }
  }

  // Upsert changed conversations
  for (const [conversationId, messages] of changedConversations) {
    try {
      await syncConversation(prisma, client, account.id, account.userId, conversationId, messages, userEmails);
      result.threadsUpserted++;
      result.emailsUpserted += messages.length;
    } catch (err: any) {
      result.errors.push(`Conversation ${conversationId}: ${err.message}`);
    }
  }

  // Update delta link
  if (newDeltaLink) {
    await prisma.account.update({
      where: { id: account.id },
      data: { syncCursor: newDeltaLink, lastSyncAt: new Date() },
    });
  }

  return result;
}

/**
 * Sync a single conversation (group of messages sharing a conversationId) into a thread.
 */
async function syncConversation(
  prisma: PrismaClient,
  client: Client,
  accountId: string,
  userId: string,
  conversationId: string,
  messages: GraphMessage[],
  userEmails: string[],
): Promise<void> {
  if (messages.length === 0) return;

  // Sort by receivedDateTime ascending
  messages.sort((a, b) =>
    new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime(),
  );

  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];

  const subject = firstMsg.subject || '(no subject)';
  const snippet = lastMsg.bodyPreview || '';

  // Collect participants
  const participants = new Set<string>();
  for (const msg of messages) {
    if (msg.from?.emailAddress?.address) participants.add(msg.from.emailAddress.address);
    for (const r of msg.toRecipients || []) {
      if (r.emailAddress?.address) participants.add(r.emailAddress.address);
    }
  }

  // Resolve labels from the folder IDs across all messages
  const allLabels = new Set<string>();
  for (const msg of messages) {
    const labels = await resolveFolder(client, accountId, msg.parentFolderId);
    labels.forEach((l) => allLabels.add(l));
  }
  const threadLabels = [...allLabels];

  // Determine read state (thread is unread if any message is unread)
  const hasUnread = messages.some((m) => !m.isRead);
  const hasStarred = messages.some((m) => m.flag?.flagStatus === 'flagged');

  const lastDate = new Date(lastMsg.receivedDateTime);

  // Compute lastReceivedAt: latest date from emails NOT sent by the user
  let lastReceivedAt: Date | null = null;
  for (const msg of [...messages].reverse()) {
    const fromEmail = msg.from?.emailAddress?.address?.toLowerCase();
    if (fromEmail && !userEmails.includes(fromEmail)) {
      lastReceivedAt = new Date(msg.receivedDateTime);
      break;
    }
  }

  // Upsert thread
  const thread = await prisma.thread.upsert({
    where: {
      accountId_providerThreadId: {
        accountId,
        providerThreadId: conversationId,
      },
    },
    update: {
      subject,
      snippet,
      isRead: !hasUnread,
      isStarred: hasStarred,
      isArchived: !threadLabels.includes('INBOX') && !threadLabels.includes('SENT'),
      isTrashed: threadLabels.includes('TRASH'),
      labels: threadLabels,
      participantEmails: [...participants],
      messageCount: messages.length,
      lastMessageAt: lastDate,
      ...(lastReceivedAt ? { lastReceivedAt } : {}),
    },
    create: {
      accountId,
      providerThreadId: conversationId,
      subject,
      snippet,
      isRead: !hasUnread,
      isStarred: hasStarred,
      isArchived: !threadLabels.includes('INBOX') && !threadLabels.includes('SENT'),
      isTrashed: threadLabels.includes('TRASH'),
      labels: threadLabels,
      participantEmails: [...participants],
      messageCount: messages.length,
      lastMessageAt: lastDate,
      ...(lastReceivedAt ? { lastReceivedAt } : {}),
    },
  });

  // Upsert each message
  for (const msg of messages) {
    const msgLabels = await resolveFolder(client, accountId, msg.parentFolderId);
    const inReplyTo = getInternetHeader(msg.internetMessageHeaders, 'In-Reply-To') || null;
    const referencesRaw = getInternetHeader(msg.internetMessageHeaders, 'References') || '';
    const refs = referencesRaw.split(/\s+/).filter(Boolean);

    const from = msg.from?.emailAddress
      ? { email: msg.from.emailAddress.address, name: msg.from.emailAddress.name }
      : { email: 'unknown' };

    const bodyHtml = msg.body?.contentType === 'html' ? msg.body.content : null;
    const bodyText = msg.body?.contentType === 'text' ? msg.body.content : null;

    const receivedAt = new Date(msg.receivedDateTime);
    const sentAt = msg.sentDateTime ? new Date(msg.sentDateTime) : null;

    const existing = await prisma.email.findUnique({
      where: { providerMessageId: msg.id },
    });

    if (existing) {
      await prisma.email.update({
        where: { id: existing.id },
        data: {
          threadId: thread.id,
          isRead: msg.isRead,
          isStarred: msg.flag?.flagStatus === 'flagged',
          labels: msgLabels,
        },
      });
    } else {
      // Fetch attachments metadata if the message has attachments
      let attachmentData: { filename: string; mimeType: string; size: number; providerAttachmentId: string; contentId: string | null }[] = [];
      if (msg.hasAttachments) {
        try {
          const attResponse = await client
            .api(`/me/messages/${msg.id}/attachments`)
            .select('id,name,contentType,size,isInline,contentId')
            .get();
          attachmentData = (attResponse.value || []).map((att: any) => ({
            filename: att.name || 'attachment',
            mimeType: att.contentType || 'application/octet-stream',
            size: att.size || 0,
            providerAttachmentId: att.id,
            contentId: att.isInline ? (att.contentId || null) : null,
          }));
        } catch {
          // Non-critical — skip attachment metadata
        }
      }

      await prisma.email.create({
        data: {
          accountId,
          threadId: thread.id,
          providerMessageId: msg.id,
          internetMessageId: msg.internetMessageId || null,
          inReplyTo,
          references: refs,
          fromAddress: from.email,
          fromName: from.name || null,
          toAddresses: parseRecipients(msg.toRecipients),
          ccAddresses: parseRecipients(msg.ccRecipients),
          bccAddresses: parseRecipients(msg.bccRecipients),
          subject: msg.subject || '(no subject)',
          bodyText,
          bodyHtml,
          snippet: msg.bodyPreview || null,
          isRead: msg.isRead,
          isStarred: msg.flag?.flagStatus === 'flagged',
          isDraft: msg.isDraft,
          labels: msgLabels,
          hasAttachments: msg.hasAttachments,
          receivedAt,
          sentAt,
          ...(attachmentData.length > 0
            ? {
                attachments: {
                  create: attachmentData.map((a) => ({
                    filename: a.filename,
                    mimeType: a.mimeType,
                    size: a.size,
                    providerAttachmentId: a.providerAttachmentId,
                    contentId: a.contentId,
                  })),
                },
              }
            : {}),
        },
      });
    }
  }

  // Extract contacts from all participants
  const allParticipants: { email: string; name?: string }[] = [];
  for (const msg of messages) {
    if (msg.from?.emailAddress) {
      allParticipants.push({
        email: msg.from.emailAddress.address,
        ...(msg.from.emailAddress.name ? { name: msg.from.emailAddress.name } : {}),
      });
    }
    for (const r of [...(msg.toRecipients || []), ...(msg.ccRecipients || [])]) {
      if (r.emailAddress?.address) {
        allParticipants.push({
          email: r.emailAddress.address,
          ...(r.emailAddress.name ? { name: r.emailAddress.name } : {}),
        });
      }
    }
  }

  const lastMsgBody = lastMsg.body?.contentType === 'text' ? lastMsg.body.content : null;
  const lastMsgDate = new Date(lastMsg.receivedDateTime);
  const senderEmail = lastMsg.from?.emailAddress?.address;
  const isOutbound = senderEmail ? userEmails.includes(senderEmail.toLowerCase().trim()) : false;

  await extractAndUpsertContacts(
    prisma,
    userId,
    allParticipants,
    lastMsgBody,
    lastMsgDate,
    userEmails,
    senderEmail,
    isOutbound,
  );
}

/**
 * Get the initial delta link by issuing a delta query with no token.
 * This gives us a starting point for future incremental syncs.
 */
async function getInitialDeltaLink(client: Client): Promise<string | null> {
  let response = await client
    .api('/me/messages/delta')
    .select(MESSAGE_SELECT_FIELDS)
    .top(1)
    .get();

  // Page through until we get a deltaLink
  while (response['@odata.nextLink']) {
    response = await client.api(response['@odata.nextLink']).get();
  }

  return response['@odata.deltaLink'] || null;
}

/**
 * Download an attachment via Microsoft Graph API.
 */
export async function downloadMicrosoftAttachment(
  prisma: PrismaClient,
  accountId: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const { client } = await getGraphClient(prisma, accountId);

  const attachment = await client
    .api(`/me/messages/${messageId}/attachments/${attachmentId}`)
    .get();

  // File attachments have contentBytes in base64
  if (attachment.contentBytes) {
    return Buffer.from(attachment.contentBytes, 'base64');
  }

  throw new Error('Attachment has no downloadable content');
}
