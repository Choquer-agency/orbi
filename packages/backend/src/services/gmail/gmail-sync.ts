import { google, gmail_v1 } from 'googleapis';
import type { PrismaClient } from '@prisma/client';
import { TokenManager } from '../oauth/token-manager.js';
import { getGmailOAuth2Client } from '../oauth/gmail-oauth.js';
import { extractAndUpsertContacts } from '../contacts/extract-contacts.js';
import { injectTrackingPixel } from '../tracking/pixel.js';
import { rewriteLinksForTracking } from '../tracking/links.js';
import { env } from '../../config/env.js';

/**
 * Split a Gmail thread's messages into separate conversation groups.
 * Gmail sometimes groups unrelated emails (same subject, same sender) into one
 * thread even when they have no In-Reply-To / References linking them.
 * We split them so each independent message (or reply chain) becomes its own thread.
 */
function splitIntoConversations(messages: gmail_v1.Schema$Message[]): gmail_v1.Schema$Message[][] {
  if (messages.length <= 1) return [messages];

  // Build a set of all Message-IDs in this thread
  const messageIds = new Set<string>();
  for (const msg of messages) {
    const headers = msg.payload?.headers ?? [];
    const mid = getHeader(headers, 'Message-ID');
    if (mid) messageIds.add(mid);
  }

  // Group by reply chain: a message belongs to an existing group if its
  // In-Reply-To or any of its References point to a message in that group.
  const groups: gmail_v1.Schema$Message[][] = [];
  const groupMessageIds: Set<string>[] = [];

  for (const msg of messages) {
    const headers = msg.payload?.headers ?? [];
    const inReplyTo = getHeader(headers, 'In-Reply-To') || '';
    const referencesRaw = getHeader(headers, 'References') || '';
    const refs = referencesRaw.split(/\s+/).filter(Boolean);
    const allRefs = [inReplyTo, ...refs].filter(Boolean);
    const mid = getHeader(headers, 'Message-ID') || '';

    // Find which existing group this message is linked to
    let foundGroup = -1;
    for (let i = 0; i < groups.length; i++) {
      for (const ref of allRefs) {
        if (groupMessageIds[i].has(ref)) {
          foundGroup = i;
          break;
        }
      }
      if (foundGroup !== -1) break;
    }

    if (foundGroup !== -1) {
      groups[foundGroup].push(msg);
      if (mid) groupMessageIds[foundGroup].add(mid);
    } else {
      groups.push([msg]);
      const idSet = new Set<string>();
      if (mid) idSet.add(mid);
      groupMessageIds.push(idSet);
    }
  }

  return groups;
}

interface SyncResult {
  threadsUpserted: number;
  emailsUpserted: number;
  errors: string[];
}

/**
 * Build an authenticated Gmail API client for the given account.
 */
export async function getGmailClient(
  prisma: PrismaClient,
  accountId: string,
): Promise<gmail_v1.Gmail> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const tokenManager = new TokenManager(prisma);
  const accessToken = await tokenManager.getValidAccessToken(account);

  const oauth2Client = getGmailOAuth2Client();
  oauth2Client.setCredentials({ access_token: accessToken });

  return google.gmail({ version: 'v1', auth: oauth2Client });
}

/**
 * Parse an RFC 2822 email address "Name <email>" or just "email".
 */
function parseAddress(raw: string): { email: string; name?: string } {
  const match = raw.match(/^(.+?)\s*<(.+?)>$/);
  if (match) return { name: match[1].replace(/"/g, '').trim(), email: match[2].trim() };
  return { email: raw.trim() };
}

function parseAddressList(raw: string | undefined): { email: string; name?: string }[] {
  if (!raw) return [];
  return raw.split(',').map((a) => parseAddress(a));
}

function getHeader(headers: gmail_v1.Schema$MessagePartHeader[], name: string): string | undefined {
  return headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;
}

function getBody(payload: gmail_v1.Schema$MessagePart): { text: string; html: string } {
  let text = '';
  let html = '';

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    text = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  } else if (payload.mimeType === 'text/html' && payload.body?.data) {
    html = Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      const sub = getBody(part);
      if (sub.text && !text) text = sub.text;
      if (sub.html && !html) html = sub.html;
    }
  }

  return { text, html };
}

function getAttachments(
  payload: gmail_v1.Schema$MessagePart,
  result: { filename: string; mimeType: string; size: number; attachmentId: string; contentId?: string }[] = [],
): typeof result {
  const contentIdHeader = payload.headers?.find(
    (h) => h.name?.toLowerCase() === 'content-id',
  );
  const hasFilename = payload.filename && payload.filename.length > 0;
  const hasCid = !!contentIdHeader?.value;

  if ((hasFilename || hasCid) && payload.body?.attachmentId) {
    const contentId = contentIdHeader?.value?.replace(/[<>]/g, '') || undefined;
    const mimeType = payload.mimeType || 'application/octet-stream';

    result.push({
      filename: payload.filename || `inline-${contentId || payload.body.attachmentId}.${mimeType.split('/')[1] || 'bin'}`,
      mimeType,
      size: payload.body.size || 0,
      attachmentId: payload.body.attachmentId,
      contentId,
    });
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      getAttachments(part, result);
    }
  }
  return result;
}

/**
 * Full sync: fetches recent threads from Gmail and upserts into the database.
 * Uses historyId-based incremental sync when a syncCursor is available.
 */
export async function syncGmailAccount(
  prisma: PrismaClient,
  accountId: string,
  maxResults = 500,
): Promise<SyncResult> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const gmail = await getGmailClient(prisma, accountId);
  const result: SyncResult = { threadsUpserted: 0, emailsUpserted: 0, errors: [] };

  // Gather all user email addresses for contact extraction (to skip self)
  const userAccounts = await prisma.account.findMany({
    where: { userId: account.userId },
    select: { email: true },
  });
  const userEmails = userAccounts.map((a) => a.email.toLowerCase());

  try {
    // If we have a syncCursor (historyId), try incremental sync
    if (account.syncCursor) {
      try {
        const incrementalResult = await incrementalSync(prisma, gmail, account, userEmails, result);
        if (incrementalResult) return incrementalResult;
      } catch (err: any) {
        // historyId too old — fall back to full sync
        if (err.code === 404 || err.message?.includes('historyId')) {
          console.log(`[gmail-sync] historyId expired for ${account.email}, doing full sync`);
        } else {
          throw err;
        }
      }
    }

    // Full sync: list threads with pagination
    const threadIds: string[] = [];
    let pageToken: string | undefined;
    const perPage = Math.min(maxResults, 100); // Gmail API max per request is 100

    while (threadIds.length < maxResults) {
      const listRes = await gmail.users.threads.list({
        userId: 'me',
        maxResults: perPage,
        q: 'in:inbox OR in:sent',
        pageToken,
      });

      const ids = listRes.data.threads?.map((t) => t.id!) ?? [];
      threadIds.push(...ids);

      pageToken = listRes.data.nextPageToken ?? undefined;
      if (!pageToken || ids.length === 0) break;
    }

    // Trim to maxResults in case we overshot
    threadIds.splice(maxResults);

    for (const gmailThreadId of threadIds) {
      try {
        await syncSingleThread(prisma, gmail, accountId, gmailThreadId, account.userId, userEmails);
        result.threadsUpserted++;
      } catch (err: any) {
        result.errors.push(`Thread ${gmailThreadId}: ${err.message}`);
      }
    }

    // Update syncCursor to current historyId for next incremental sync
    const profile = await gmail.users.getProfile({ userId: 'me' });
    if (profile.data.historyId) {
      await prisma.account.update({
        where: { id: accountId },
        data: {
          syncCursor: profile.data.historyId,
          lastSyncAt: new Date(),
        },
      });
    }
  } catch (err: any) {
    result.errors.push(`Sync failed: ${err.message}`);
  }

  return result;
}

/**
 * Incremental sync using Gmail History API.
 */
async function incrementalSync(
  prisma: PrismaClient,
  gmail: gmail_v1.Gmail,
  account: { id: string; userId: string; syncCursor: string | null; email: string },
  userEmails: string[],
  result: SyncResult,
): Promise<SyncResult | null> {
  // Paginate through ALL history pages to catch every change
  const changedThreadIds = new Set<string>();
  let pageToken: string | undefined;
  let latestHistoryId: string | undefined;
  let hasAnyHistory = false;

  do {
    const historyRes = await gmail.users.history.list({
      userId: 'me',
      startHistoryId: account.syncCursor!,
      historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
      pageToken,
    });

    // Track the latest historyId from the first page (it's the global latest)
    if (!latestHistoryId && historyRes.data.historyId) {
      latestHistoryId = historyRes.data.historyId;
    }

    if (historyRes.data.history) {
      hasAnyHistory = true;
      for (const h of historyRes.data.history) {
        for (const msg of h.messagesAdded ?? []) {
          if (msg.message?.threadId) changedThreadIds.add(msg.message.threadId);
        }
        for (const msg of h.messagesDeleted ?? []) {
          if (msg.message?.threadId) changedThreadIds.add(msg.message.threadId);
        }
        for (const msg of h.labelsAdded ?? []) {
          if (msg.message?.threadId) changedThreadIds.add(msg.message.threadId);
        }
        for (const msg of h.labelsRemoved ?? []) {
          if (msg.message?.threadId) changedThreadIds.add(msg.message.threadId);
        }
      }
    }

    pageToken = historyRes.data.nextPageToken ?? undefined;
  } while (pageToken);

  if (!hasAnyHistory) {
    // No changes since last sync
    await prisma.account.update({
      where: { id: account.id },
      data: { lastSyncAt: new Date() },
    });
    return result;
  }

  for (const threadId of changedThreadIds) {
    try {
      await syncSingleThread(prisma, gmail, account.id, threadId, account.userId, userEmails);
      result.threadsUpserted++;
    } catch (err: any) {
      result.errors.push(`Thread ${threadId}: ${err.message}`);
    }
  }

  // Update cursor to the latest historyId
  if (latestHistoryId) {
    await prisma.account.update({
      where: { id: account.id },
      data: {
        syncCursor: latestHistoryId,
        lastSyncAt: new Date(),
      },
    });
  }

  return result;
}

/**
 * Sync a single Gmail thread: fetch all messages and upsert into DB.
 */
export async function syncSingleThread(
  prisma: PrismaClient,
  gmail: gmail_v1.Gmail,
  accountId: string,
  gmailThreadId: string,
  userId: string,
  userEmails: string[],
): Promise<void> {
  const threadRes = await gmail.users.threads.get({
    userId: 'me',
    id: gmailThreadId,
    format: 'full',
  });

  const messages = threadRes.data.messages ?? [];
  if (messages.length === 0) return;

  // Split Gmail's thread into conversation groups based on In-Reply-To / References.
  // Gmail groups unrelated emails with the same subject into one thread, but we want
  // each independent conversation (no reply chain linking them) as its own thread.
  const groups = splitIntoConversations(messages);

  for (let groupIdx = 0; groupIdx < groups.length; groupIdx++) {
    const group = groups[groupIdx];
    const firstMsg = group[0];
    const lastMsg = group[group.length - 1];
    const firstHeaders = firstMsg.payload?.headers ?? [];

    // Use a stable sub-thread id so re-syncs don't duplicate
    const subThreadId = groups.length === 1
      ? gmailThreadId
      : `${gmailThreadId}::${groupIdx}`;

    const subject = getHeader(firstHeaders, 'Subject') || '(no subject)';
    const lastSnippet = lastMsg.snippet || '';
    const threadLabels = [...new Set(group.flatMap((m) => m.labelIds ?? []))];

    // Collect participant emails
    const participants = new Set<string>();
    for (const msg of group) {
      const headers = msg.payload?.headers ?? [];
      const from = getHeader(headers, 'From');
      if (from) parseAddressList(from).forEach((a) => participants.add(a.email));
      const to = getHeader(headers, 'To');
      if (to) parseAddressList(to).forEach((a) => participants.add(a.email));
    }

    const lastDate = lastMsg.internalDate
      ? new Date(parseInt(lastMsg.internalDate, 10))
      : new Date();

    // Compute lastReceivedAt: latest date from emails NOT sent by the user
    let lastReceivedAt: Date | null = null;
    for (const msg of [...group].reverse()) {
      const msgHeaders = msg.payload?.headers ?? [];
      const msgFrom = parseAddress(getHeader(msgHeaders, 'From') || '');
      if (msgFrom.email && !userEmails.includes(msgFrom.email.toLowerCase())) {
        lastReceivedAt = msg.internalDate
          ? new Date(parseInt(msg.internalDate, 10))
          : new Date();
        break;
      }
    }

    // Upsert thread
    const thread = await prisma.thread.upsert({
      where: {
        accountId_providerThreadId: {
          accountId,
          providerThreadId: subThreadId,
        },
      },
      update: {
        subject,
        snippet: lastSnippet,
        isRead: !threadLabels.includes('UNREAD'),
        isStarred: threadLabels.includes('STARRED'),
        isArchived: !threadLabels.includes('INBOX') && !threadLabels.includes('SENT'),
        isTrashed: threadLabels.includes('TRASH'),
        labels: threadLabels,
        participantEmails: [...participants],
        messageCount: group.length,
        lastMessageAt: lastDate,
        ...(lastReceivedAt ? { lastReceivedAt } : {}),
      },
      create: {
        accountId,
        providerThreadId: subThreadId,
        subject,
        snippet: lastSnippet,
        isRead: !threadLabels.includes('UNREAD'),
        isStarred: threadLabels.includes('STARRED'),
        isArchived: !threadLabels.includes('INBOX') && !threadLabels.includes('SENT'),
        isTrashed: threadLabels.includes('TRASH'),
        labels: threadLabels,
        participantEmails: [...participants],
        messageCount: group.length,
        lastMessageAt: lastDate,
        ...(lastReceivedAt ? { lastReceivedAt } : {}),
      },
    });

    // Upsert each message
    for (const msg of group) {
      const headers = msg.payload?.headers ?? [];
      const msgId = msg.id!;
      const from = parseAddress(getHeader(headers, 'From') || '');
      const toRaw = getHeader(headers, 'To');
      const ccRaw = getHeader(headers, 'Cc');
      const bccRaw = getHeader(headers, 'Bcc');
      const internetMessageId = getHeader(headers, 'Message-ID') || null;
      const inReplyTo = getHeader(headers, 'In-Reply-To') || null;
      const referencesRaw = getHeader(headers, 'References') || '';
      const refs = referencesRaw.split(/\s+/).filter(Boolean);

      const body = getBody(msg.payload!);
      const attachments = getAttachments(msg.payload!);
      const labels = msg.labelIds ?? [];
      const receivedAt = msg.internalDate
        ? new Date(parseInt(msg.internalDate, 10))
        : new Date();

      const existing = await prisma.email.findUnique({
        where: { providerMessageId: msgId },
      });

      if (existing) {
        // Update labels / read state, and reassign thread if it moved groups
        await prisma.email.update({
          where: { id: existing.id },
          data: {
            threadId: thread.id,
            isRead: !labels.includes('UNREAD'),
            isStarred: labels.includes('STARRED'),
            labels,
          },
        });
      } else {
        await prisma.email.create({
          data: {
            accountId,
            threadId: thread.id,
            providerMessageId: msgId,
            internetMessageId,
            inReplyTo,
            references: refs,
            fromAddress: from.email,
            fromName: from.name || null,
            toAddresses: parseAddressList(toRaw),
            ccAddresses: parseAddressList(ccRaw),
            bccAddresses: parseAddressList(bccRaw),
            subject: getHeader(headers, 'Subject') || '(no subject)',
            bodyText: body.text || null,
            bodyHtml: body.html || null,
            snippet: msg.snippet || null,
            isRead: !labels.includes('UNREAD'),
            isStarred: labels.includes('STARRED'),
            isDraft: labels.includes('DRAFT'),
            labels,
            hasAttachments: attachments.length > 0,
            receivedAt,
            sentAt: labels.includes('SENT') ? receivedAt : null,
            attachments: {
              create: attachments.map((a) => ({
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.size,
                providerAttachmentId: a.attachmentId,
                contentId: a.contentId || null,
              })),
            },
          },
        });
      }
    }
  }

  // If we split a previously-combined thread, clean up the old one (now has 0 emails)
  if (groups.length > 1) {
    const oldThread = await prisma.thread.findUnique({
      where: { accountId_providerThreadId: { accountId, providerThreadId: gmailThreadId } },
      select: { id: true, _count: { select: { emails: true } } },
    });
    if (oldThread && oldThread._count.emails === 0) {
      await prisma.threadComment.deleteMany({ where: { threadId: oldThread.id } });
      await prisma.thread.delete({ where: { id: oldThread.id } });
    }
  }

  // Extract contacts from all participants in this thread
  const allParticipants: { email: string; name?: string }[] = [];
  for (const msg of messages) {
    const headers = msg.payload?.headers ?? [];
    const from = getHeader(headers, 'From');
    if (from) allParticipants.push(...parseAddressList(from));
    const to = getHeader(headers, 'To');
    if (to) allParticipants.push(...parseAddressList(to));
    const cc = getHeader(headers, 'Cc');
    if (cc) allParticipants.push(...parseAddressList(cc));
  }

  // Use last message body for signature parsing
  const lastMsg = messages[messages.length - 1];
  const lastMsgBody = getBody(lastMsg.payload!);
  const lastMsgDate = lastMsg.internalDate
    ? new Date(parseInt(lastMsg.internalDate!, 10))
    : new Date();
  const lastMsgHeaders = lastMsg.payload?.headers ?? [];
  const lastMsgFrom = getHeader(lastMsgHeaders, 'From');
  const senderEmail = lastMsgFrom ? parseAddressList(lastMsgFrom)[0]?.email : undefined;
  const isOutbound = senderEmail ? userEmails.includes(senderEmail.toLowerCase().trim()) : false;
  await extractAndUpsertContacts(
    prisma,
    userId,
    allParticipants,
    lastMsgBody.text || null,
    lastMsgDate,
    userEmails,
    senderEmail,
    isOutbound,
  );
}

/**
 * Send an email via Gmail API.
 */
export async function sendViaGmail(
  prisma: PrismaClient,
  accountId: string,
  emailId: string,
): Promise<{ providerMessageId: string; threadId: string }> {
  const gmail = await getGmailClient(prisma, accountId);
  const email = await prisma.email.findUniqueOrThrow({
    where: { id: emailId },
    include: { thread: true, attachments: true },
  });

  // Set up open + click tracking
  const baseUrl = env.TRACKING_BASE_URL;
  let sendBodyHtml = email.bodyHtml || email.bodyText || '';

  try {
    // Create tracking record (upsert to handle retries)
    const tracking = await prisma.emailTracking.upsert({
      where: { emailId },
      create: { emailId },
      update: {},
    });

    // Rewrite links for click tracking
    const { html: linkedHtml, linkMap } = rewriteLinksForTracking(sendBodyHtml, tracking.trackingId, baseUrl);
    sendBodyHtml = linkedHtml;

    // Save link map
    if (Object.keys(linkMap).length > 0) {
      await prisma.emailTracking.update({
        where: { id: tracking.id },
        data: { linkMap },
      });
    }

    // Inject tracking pixel for open tracking
    sendBodyHtml = injectTrackingPixel(sendBodyHtml, tracking.trackingId, baseUrl);
  } catch (trackingErr: any) {
    // Don't fail the send if tracking setup fails (e.g. duplicate)
    console.warn(`[gmail-send] Tracking setup failed for ${emailId}: ${trackingErr.message}`);
  }

  // Build RFC 2822 message
  const to = (email.toAddresses as any[])
    .map((a: any) => (a.name ? `"${a.name}" <${a.email}>` : a.email))
    .join(', ');
  const cc = email.ccAddresses
    ? (email.ccAddresses as any[])
        .map((a: any) => (a.name ? `"${a.name}" <${a.email}>` : a.email))
        .join(', ')
    : '';

  const headers = [
    `From: ${email.fromName ? `"${email.fromName}" <${email.fromAddress}>` : email.fromAddress}`,
    `To: ${to}`,
  ];
  if (cc) headers.push(`Cc: ${cc}`);
  headers.push(`Subject: ${email.subject}`);
  if (email.inReplyTo) headers.push(`In-Reply-To: ${email.inReplyTo}`);
  if (email.references.length > 0) headers.push(`References: ${email.references.join(' ')}`);
  headers.push('MIME-Version: 1.0');

  // Attachments with content = outgoing files stored in DB
  const outgoingAttachments = email.attachments.filter((a: any) => a.content);

  let messageBody: string;
  if (outgoingAttachments.length > 0) {
    // Build multipart/mixed message
    const boundary = `orbi_${crypto.randomUUID()}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts = [
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      sendBodyHtml,
    ];

    for (const att of outgoingAttachments) {
      const base64Data = Buffer.from(att.content!).toString('base64');
      // Split into 76-char lines per RFC 2045
      const base64Lines = base64Data.match(/.{1,76}/g)?.join('\r\n') || base64Data;
      parts.push(
        `--${boundary}`,
        `Content-Type: ${att.mimeType}; name="${att.filename}"`,
        `Content-Disposition: attachment; filename="${att.filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        base64Lines,
      );
    }

    parts.push(`--${boundary}--`);
    messageBody = parts.join('\r\n');
  } else {
    headers.push('Content-Type: text/html; charset=UTF-8');
    messageBody = sendBodyHtml;
  }

  const raw = Buffer.from([...headers, '', messageBody].join('\r\n')).toString('base64url');

  // Only pass threadId if it's a real Gmail thread ID (not a local placeholder)
  // Strip ::N suffix from conversation-split thread IDs
  const rawThreadId = email.thread?.providerThreadId;
  const gmailThreadId = rawThreadId?.replace(/::.*$/, '') || rawThreadId;
  const isRealThread = gmailThreadId && !gmailThreadId.startsWith('local-');

  const sendRes = await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw,
      ...(isRealThread ? { threadId: gmailThreadId } : {}),
    },
  });

  const providerMessageId = sendRes.data.id!;
  const providerThreadId = sendRes.data.threadId!;

  // Verify the message exists in Gmail (delivery confirmation)
  try {
    const verifyRes = await gmail.users.messages.get({
      userId: 'me',
      id: providerMessageId,
      format: 'minimal',
    });
    if (!verifyRes.data.id) {
      throw new Error('Message verification failed — message not found after send');
    }
  } catch (verifyErr: any) {
    // Don't fail the send if verification fails — the message was accepted by Gmail
    console.warn(`[gmail-send] Verification check failed for ${providerMessageId}: ${verifyErr.message}`);
  }

  // Update email record with provider IDs
  await prisma.email.update({
    where: { id: emailId },
    data: {
      providerMessageId,
      sendStatus: 'SENT',
      sentAt: new Date(),
    },
  });

  // Clear attachment content from DB after successful send (data is now in Gmail)
  if (outgoingAttachments.length > 0) {
    await prisma.attachment.updateMany({
      where: { emailId, content: { not: null } },
      data: { content: null },
    });
  }

  // Update local thread with real Gmail thread ID if it was a local placeholder
  if (email.thread && email.thread.providerThreadId.startsWith('local-')) {
    await prisma.thread.update({
      where: { id: email.thread.id },
      data: { providerThreadId },
    });
  }

  return { providerMessageId, threadId: providerThreadId };
}

/**
 * Download an attachment via Gmail API.
 */
export async function downloadGmailAttachment(
  prisma: PrismaClient,
  accountId: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const gmail = await getGmailClient(prisma, accountId);

  const res = await gmail.users.messages.attachments.get({
    userId: 'me',
    messageId,
    id: attachmentId,
  });

  return Buffer.from(res.data.data!, 'base64url');
}
