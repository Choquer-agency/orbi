import type { PrismaClient } from '@prisma/client';
import { getGraphClient, MESSAGE_SELECT_FIELDS } from './graph-client.js';
import { syncMicrosoftAccount } from './microsoft-sync.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HistoricalSyncProgress {
  syncedMessages: number;
  totalMessages: number;
  nextLink?: string;
  startedAt: string;
  lastBatchAt: string;
  error?: string;
}

/**
 * Full historical Microsoft sync — paginates through ALL messages and imports them.
 * Stores progress in the Account record for resumability.
 */
export async function historicalSyncMicrosoftAccount(
  prisma: PrismaClient,
  accountId: string,
  onProgress?: (progress: HistoricalSyncProgress) => void,
): Promise<void> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const { client } = await getGraphClient(prisma, accountId);

  // Gather user emails for contact extraction
  const userAccounts = await prisma.account.findMany({
    where: { userId: account.userId },
    select: { email: true },
  });
  const userEmails = userAccounts.map((a) => a.email.toLowerCase());

  // Check for existing progress (resume support)
  const existingProgress = account.historicalSyncProgress as HistoricalSyncProgress | null;
  let syncedMessages = existingProgress?.syncedMessages ?? 0;
  let resumeNextLink = existingProgress?.nextLink ?? undefined;
  let totalMessages = existingProgress?.totalMessages ?? 0;
  const startedAt = existingProgress?.startedAt ?? new Date().toISOString();

  // Mark as in-progress
  await prisma.account.update({
    where: { id: accountId },
    data: {
      historicalSyncStatus: 'IN_PROGRESS',
      historicalSyncProgress: {
        syncedMessages,
        totalMessages,
        nextLink: resumeNextLink,
        startedAt,
        lastBatchAt: new Date().toISOString(),
      } as any,
    },
  });

  try {
    // Build initial URL or resume from nextLink
    let url = resumeNextLink
      || `/me/messages?$select=${MESSAGE_SELECT_FIELDS}&$orderby=receivedDateTime desc&$top=50&$filter=isDraft eq false`;

    while (true) {
      let response: any;
      let retries = 0;

      while (retries < 3) {
        try {
          response = await client.api(url).get();
          break;
        } catch (err: any) {
          if (err.statusCode === 429) {
            const retryAfter = parseInt(err.headers?.['retry-after'] || '60', 10);
            console.log(`[microsoft-historical-sync] Rate limited, waiting ${retryAfter}s`);
            await delay(retryAfter * 1000);
            retries++;
          } else if (err.statusCode >= 500 && retries < 2) {
            await delay(Math.pow(2, retries) * 1000);
            retries++;
          } else {
            throw err;
          }
        }
      }

      if (!response) break;

      const messages = response.value || [];
      if (messages.length === 0) break;

      // Use @odata.count or estimate from message count so far
      if (response['@odata.count']) {
        totalMessages = response['@odata.count'];
      } else if (totalMessages === 0) {
        // Rough estimate — we'll refine as we go
        totalMessages = Math.max(syncedMessages + 1000, messages.length * 20);
      }

      // Group messages by conversationId
      const conversationMessages = new Map<string, any[]>();
      for (const msg of messages) {
        if (!conversationMessages.has(msg.conversationId)) {
          conversationMessages.set(msg.conversationId, []);
        }
        conversationMessages.get(msg.conversationId)!.push(msg);
      }

      // Process each conversation batch
      for (const [conversationId, convMessages] of conversationMessages) {
        let retryCount = 0;
        while (retryCount < 3) {
          try {
            await syncConversationBatch(prisma, client, accountId, account.userId, conversationId, convMessages, userEmails);
            syncedMessages += convMessages.length;
            // Rate limit: 130ms between API batches
            await delay(130);
            break;
          } catch (err: any) {
            if (err.statusCode === 429) {
              const retryAfter = parseInt(err.headers?.['retry-after'] || '60', 10);
              console.log(`[microsoft-historical-sync] Rate limited, waiting ${retryAfter}s`);
              await delay(retryAfter * 1000);
              retryCount++;
            } else if (err.statusCode >= 500 && retryCount < 2) {
              await delay(Math.pow(2, retryCount) * 1000);
              retryCount++;
            } else {
              console.error(`[microsoft-historical-sync] Failed conversation ${conversationId}: ${err.message}`);
              syncedMessages += convMessages.length; // count as processed even if failed
              break;
            }
          }
        }
      }

      // Update progress
      const progress: HistoricalSyncProgress = {
        syncedMessages,
        totalMessages,
        nextLink: response['@odata.nextLink'],
        startedAt,
        lastBatchAt: new Date().toISOString(),
      };

      await prisma.account.update({
        where: { id: accountId },
        data: { historicalSyncProgress: progress as any },
      });

      onProgress?.(progress);

      // Move to next page
      const nextLink = response['@odata.nextLink'];
      if (!nextLink) break;
      url = nextLink;
    }

    // Get delta link for future incremental syncs
    let deltaLink: string | null = null;
    try {
      let deltaResponse = await client
        .api('/me/messages/delta')
        .select(MESSAGE_SELECT_FIELDS)
        .top(1)
        .get();

      while (deltaResponse['@odata.nextLink']) {
        deltaResponse = await client.api(deltaResponse['@odata.nextLink']).get();
      }
      deltaLink = deltaResponse['@odata.deltaLink'] || null;
    } catch (err: any) {
      console.warn(`[microsoft-historical-sync] Failed to get delta link: ${err.message}`);
    }

    await prisma.account.update({
      where: { id: accountId },
      data: {
        historicalSyncStatus: 'COMPLETED',
        historicalSyncCompletedAt: new Date(),
        historicalSyncProgress: {
          syncedMessages,
          totalMessages: syncedMessages,
          startedAt,
          lastBatchAt: new Date().toISOString(),
        } as any,
        ...(deltaLink ? { syncCursor: deltaLink, lastSyncAt: new Date() } : {}),
      },
    });

    console.log(`[microsoft-historical-sync] Completed for ${account.email}: ${syncedMessages} messages synced`);
  } catch (err: any) {
    await prisma.account.update({
      where: { id: accountId },
      data: {
        historicalSyncStatus: 'FAILED',
        historicalSyncProgress: {
          syncedMessages,
          totalMessages,
          nextLink: resumeNextLink,
          startedAt,
          lastBatchAt: new Date().toISOString(),
          error: err.message,
        } as any,
      },
    });

    console.error(`[microsoft-historical-sync] Failed for ${account.email}: ${err.message}`);
    throw err;
  }
}

/**
 * Sync a batch of messages belonging to the same conversation.
 * Simplified version — upserts thread and messages.
 */
async function syncConversationBatch(
  prisma: PrismaClient,
  client: any,
  accountId: string,
  userId: string,
  conversationId: string,
  messages: any[],
  userEmails: string[],
): Promise<void> {
  // Import the full syncMicrosoftAccount's syncConversation via direct DB operations
  // This mirrors the pattern but works with the messages we already have

  if (messages.length === 0) return;

  messages.sort((a: any, b: any) =>
    new Date(a.receivedDateTime).getTime() - new Date(b.receivedDateTime).getTime(),
  );

  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];
  const subject = firstMsg.subject || '(no subject)';
  const snippet = lastMsg.bodyPreview || '';

  const participants = new Set<string>();
  for (const msg of messages) {
    if (msg.from?.emailAddress?.address) participants.add(msg.from.emailAddress.address);
    for (const r of msg.toRecipients || []) {
      if (r.emailAddress?.address) participants.add(r.emailAddress.address);
    }
  }

  const hasUnread = messages.some((m: any) => !m.isRead);
  const hasStarred = messages.some((m: any) => m.flag?.flagStatus === 'flagged');
  const lastDate = new Date(lastMsg.receivedDateTime);

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
      labels: [],
      participantEmails: [...participants],
      messageCount: { increment: messages.length },
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
      labels: [],
      participantEmails: [...participants],
      messageCount: messages.length,
      lastMessageAt: lastDate,
      ...(lastReceivedAt ? { lastReceivedAt } : {}),
    },
  });

  // Upsert messages
  for (const msg of messages) {
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
        },
      });
      continue;
    }

    const from = msg.from?.emailAddress
      ? { email: msg.from.emailAddress.address, name: msg.from.emailAddress.name }
      : { email: 'unknown' };

    const toRecipients = (msg.toRecipients || []).map((r: any) => ({
      email: r.emailAddress.address,
      ...(r.emailAddress.name ? { name: r.emailAddress.name } : {}),
    }));
    const ccRecipients = (msg.ccRecipients || []).map((r: any) => ({
      email: r.emailAddress.address,
      ...(r.emailAddress.name ? { name: r.emailAddress.name } : {}),
    }));
    const bccRecipients = (msg.bccRecipients || []).map((r: any) => ({
      email: r.emailAddress.address,
      ...(r.emailAddress.name ? { name: r.emailAddress.name } : {}),
    }));

    const bodyHtml = msg.body?.contentType === 'html' ? msg.body.content : null;
    const bodyText = msg.body?.contentType === 'text' ? msg.body.content : null;

    const headers = msg.internetMessageHeaders || [];
    const inReplyTo = headers.find((h: any) => h.name.toLowerCase() === 'in-reply-to')?.value || null;
    const refsRaw = headers.find((h: any) => h.name.toLowerCase() === 'references')?.value || '';
    const refs = refsRaw.split(/\s+/).filter(Boolean);

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
        toAddresses: toRecipients,
        ccAddresses: ccRecipients,
        bccAddresses: bccRecipients,
        subject: msg.subject || '(no subject)',
        bodyText,
        bodyHtml,
        snippet: msg.bodyPreview || null,
        isRead: msg.isRead,
        isStarred: msg.flag?.flagStatus === 'flagged',
        isDraft: msg.isDraft || false,
        labels: [],
        hasAttachments: msg.hasAttachments || false,
        receivedAt: new Date(msg.receivedDateTime),
        sentAt: msg.sentDateTime ? new Date(msg.sentDateTime) : null,
      },
    });
  }

  // Extract contacts
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

  const { extractAndUpsertContacts } = await import('../contacts/extract-contacts.js');
  const lastMsgBody = lastMsg.body?.contentType === 'text' ? lastMsg.body.content : null;
  const senderEmail = lastMsg.from?.emailAddress?.address;
  const isOutbound = senderEmail ? userEmails.includes(senderEmail.toLowerCase().trim()) : false;

  await extractAndUpsertContacts(
    prisma,
    userId,
    allParticipants,
    lastMsgBody,
    new Date(lastMsg.receivedDateTime),
    userEmails,
    senderEmail,
    isOutbound,
  );
}
