import type { PrismaClient } from '@prisma/client';
import { getGraphClient } from './graph-client.js';
import { injectTrackingPixel } from '../tracking/pixel.js';
import { rewriteLinksForTracking } from '../tracking/links.js';
import { env } from '../../config/env.js';

/**
 * Send an email via Microsoft Graph API using the draft-then-send pattern.
 * Creating a draft first gives us a reliable message ID.
 */
export async function sendViaMicrosoft(
  prisma: PrismaClient,
  accountId: string,
  emailId: string,
): Promise<{ providerMessageId: string; threadId: string }> {
  const { client } = await getGraphClient(prisma, accountId);
  const email = await prisma.email.findUniqueOrThrow({
    where: { id: emailId },
    include: { thread: true, attachments: true },
  });

  // Set up open + click tracking
  const baseUrl = env.TRACKING_BASE_URL;
  let sendBodyHtml = email.bodyHtml || email.bodyText || '';

  try {
    const tracking = await prisma.emailTracking.upsert({
      where: { emailId },
      create: { emailId },
      update: {},
    });

    const { html: linkedHtml, linkMap } = rewriteLinksForTracking(sendBodyHtml, tracking.trackingId, baseUrl);
    sendBodyHtml = linkedHtml;

    if (Object.keys(linkMap).length > 0) {
      await prisma.emailTracking.update({
        where: { id: tracking.id },
        data: { linkMap },
      });
    }

    sendBodyHtml = injectTrackingPixel(sendBodyHtml, tracking.trackingId, baseUrl);
  } catch (trackingErr: any) {
    console.warn(`[microsoft-send] Tracking setup failed for ${emailId}: ${trackingErr.message}`);
  }

  // Build the Graph API message object
  const toRecipients = (email.toAddresses as any[]).map((a: any) => ({
    emailAddress: { address: a.email, name: a.name || undefined },
  }));

  const ccRecipients = email.ccAddresses
    ? (email.ccAddresses as any[]).map((a: any) => ({
        emailAddress: { address: a.email, name: a.name || undefined },
      }))
    : [];

  const bccRecipients = email.bccAddresses
    ? (email.bccAddresses as any[]).map((a: any) => ({
        emailAddress: { address: a.email, name: a.name || undefined },
      }))
    : [];

  // Build internet message headers for threading
  const internetMessageHeaders: { name: string; value: string }[] = [];
  if (email.inReplyTo) {
    internetMessageHeaders.push({ name: 'In-Reply-To', value: email.inReplyTo });
  }
  if (email.references.length > 0) {
    internetMessageHeaders.push({ name: 'References', value: email.references.join(' ') });
  }

  const messagePayload: any = {
    subject: email.subject,
    body: { contentType: 'HTML', content: sendBodyHtml },
    toRecipients,
    ccRecipients,
    bccRecipients,
    ...(internetMessageHeaders.length > 0 ? { internetMessageHeaders } : {}),
  };

  // If replying to an existing conversation, set conversationId
  if (email.thread?.providerThreadId && !email.thread.providerThreadId.startsWith('local-')) {
    messagePayload.conversationId = email.thread.providerThreadId;
  }

  // Step 1: Create draft
  const draft = await client.api('/me/messages').post(messagePayload);
  const draftId = draft.id;
  const conversationId = draft.conversationId;

  // Step 2: Add attachments if any
  const outgoingAttachments = email.attachments.filter((a: any) => a.content);
  for (const att of outgoingAttachments) {
    const base64Content = Buffer.from(att.content!).toString('base64');
    await client.api(`/me/messages/${draftId}/attachments`).post({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: att.filename,
      contentType: att.mimeType,
      contentBytes: base64Content,
    });
  }

  // Step 3: Send the draft
  await client.api(`/me/messages/${draftId}/send`).post({});

  // Update email record with provider IDs
  await prisma.email.update({
    where: { id: emailId },
    data: {
      providerMessageId: draftId,
      sendStatus: 'SENT',
      sentAt: new Date(),
    },
  });

  // Clear attachment content from DB after successful send
  if (outgoingAttachments.length > 0) {
    await prisma.attachment.updateMany({
      where: { emailId, content: { not: null } },
      data: { content: null },
    });
  }

  // Update local thread with real conversation ID if it was a local placeholder
  if (email.thread && email.thread.providerThreadId.startsWith('local-') && conversationId) {
    await prisma.thread.update({
      where: { id: email.thread.id },
      data: { providerThreadId: conversationId },
    });
  }

  return { providerMessageId: draftId, threadId: conversationId || email.threadId };
}
