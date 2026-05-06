import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import { addPendingSendJob } from '../../queues/pending-send.queue.js';
import { emitDraftsUpdated } from '../../services/socket-events.js';

export default async function draftRoutes(app: FastifyInstance) {
  // Create a new draft
  app.post('/api/drafts', { preHandler: [authenticate] }, async (request, reply) => {
    const {
      accountId,
      threadId,
      subject,
      bodyHtml,
      bodyText,
      toAddresses,
      mode,
      parentEmailId,
    } = request.body as {
      accountId: string;
      threadId?: string;
      subject?: string;
      bodyHtml?: string;
      bodyText?: string;
      toAddresses?: { email: string; name?: string }[];
      mode: 'compose' | 'reply' | 'forward';
      parentEmailId?: string;
    };

    const account = await app.prisma.account.findFirst({
      where: { id: accountId, userId: request.user.userId },
    });
    if (!account) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    // Look up inReplyTo if replying
    let inReplyTo: string | undefined;
    if ((mode === 'reply' || mode === 'forward') && parentEmailId) {
      const parent = await app.prisma.email.findUnique({
        where: { id: parentEmailId },
        select: { internetMessageId: true, providerMessageId: true },
      });
      if (parent) {
        inReplyTo = parent.internetMessageId || parent.providerMessageId;
      }
    }

    const now = new Date();

    const result = await app.prisma.$transaction(async (tx) => {
      let resolvedThreadId = threadId;

      // Create a draft thread if no threadId (new compose)
      if (!resolvedThreadId) {
        const thread = await tx.thread.create({
          data: {
            accountId: account.id,
            providerThreadId: `draft-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            subject: subject || '(no subject)',
            snippet: (bodyText || '').slice(0, 200),
            isRead: true,
            labels: ['DRAFT'],
            participantEmails: [account.email, ...(toAddresses?.map((a) => a.email) || [])],
            messageCount: 0,
            lastMessageAt: now,
          },
        });
        resolvedThreadId = thread.id;
      }

      const email = await tx.email.create({
        data: {
          accountId: account.id,
          threadId: resolvedThreadId,
          providerMessageId: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          fromAddress: account.email,
          fromName: account.displayName || account.email.split('@')[0],
          toAddresses: toAddresses || [],
          subject: subject || '',
          bodyText: bodyText || '',
          bodyHtml: bodyHtml || '',
          snippet: (bodyText || '').slice(0, 200),
          isRead: true,
          isDraft: true,
          labels: ['DRAFT'],
          receivedAt: now,
          sendStatus: 'NONE',
          inReplyTo,
        },
      });

      return { id: email.id, threadId: resolvedThreadId };
    });

    emitDraftsUpdated(app.io, request.user.userId);

    return { data: result };
  });

  // Update (auto-save) an existing draft
  app.patch('/api/drafts/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { subject, bodyHtml, bodyText, toAddresses } = request.body as {
      subject?: string;
      bodyHtml?: string;
      bodyText?: string;
      toAddresses?: { email: string; name?: string }[];
    };

    const email = await app.prisma.email.findUnique({
      where: { id },
      include: { account: { select: { userId: true } } },
    });

    if (!email || email.account.userId !== request.user.userId) {
      return reply.status(404).send({ error: 'Draft not found' });
    }
    if (!email.isDraft) {
      return reply.status(400).send({ error: 'Email is not a draft' });
    }

    const data: Record<string, any> = {};
    if (subject !== undefined) data.subject = subject;
    if (bodyHtml !== undefined) data.bodyHtml = bodyHtml;
    if (bodyText !== undefined) data.bodyText = bodyText;
    if (toAddresses !== undefined) data.toAddresses = toAddresses;
    if (bodyText !== undefined) data.snippet = bodyText.slice(0, 200);

    const updated = await app.prisma.email.update({
      where: { id },
      data,
    });

    // Update thread snippet
    if (bodyText !== undefined) {
      await app.prisma.thread.update({
        where: { id: email.threadId },
        data: {
          snippet: bodyText.slice(0, 200),
          ...(subject !== undefined ? { subject } : {}),
        },
      });
    }

    return { data: updated };
  });

  // Delete (discard) a draft
  app.delete('/api/drafts/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const email = await app.prisma.email.findUnique({
      where: { id },
      include: { account: { select: { userId: true } }, thread: true },
    });

    if (!email || email.account.userId !== request.user.userId) {
      return reply.status(404).send({ error: 'Draft not found' });
    }
    if (!email.isDraft) {
      return reply.status(400).send({ error: 'Email is not a draft' });
    }

    await app.prisma.email.delete({ where: { id } });

    emitDraftsUpdated(app.io, request.user.userId);

    // If the thread was draft-only, clean it up
    if (email.thread.providerThreadId.startsWith('draft-thread-')) {
      const remainingCount = await app.prisma.email.count({
        where: { threadId: email.threadId },
      });
      if (remainingCount === 0) {
        await app.prisma.thread.delete({ where: { id: email.threadId } });
      }
    }

    return { data: { success: true } };
  });

  // Send a draft (convert draft → pending send)
  app.post('/api/drafts/:id/send', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { undoWindowSeconds = 60 } = request.body as { undoWindowSeconds?: number };

    const email = await app.prisma.email.findUnique({
      where: { id },
      include: { account: { select: { userId: true, id: true, email: true, displayName: true } }, thread: true },
    });

    if (!email || email.account.userId !== request.user.userId) {
      return reply.status(404).send({ error: 'Draft not found' });
    }
    if (!email.isDraft) {
      return reply.status(400).send({ error: 'Email is not a draft' });
    }

    const to = email.toAddresses as any[];
    if (!to || to.length === 0) {
      return reply.status(400).send({ error: 'Draft has no recipients' });
    }

    const now = new Date();
    const undoDeadlineAt = new Date(now.getTime() + undoWindowSeconds * 1000);

    // Convert draft to pending send
    const updated = await app.prisma.email.update({
      where: { id },
      data: {
        isDraft: false,
        sendStatus: 'PENDING_SEND',
        sentAt: now,
        undoDeadlineAt,
        labels: ['SENT'],
      },
    });

    // Update thread
    const threadData: Record<string, any> = {
      lastMessageAt: now,
      snippet: (email.bodyText || '').slice(0, 200),
      labels: ['SENT'],
    };
    if (email.thread.providerThreadId.startsWith('draft-thread-')) {
      threadData.providerThreadId = email.thread.providerThreadId.replace('draft-thread-', 'local-thread-');
      threadData.messageCount = 1;
      threadData.participantEmails = [
        email.account.email,
        ...to.map((a: any) => a.email),
      ];
    }
    await app.prisma.thread.update({
      where: { id: email.threadId },
      data: threadData,
    });

    // Queue for sending
    try {
      await addPendingSendJob(updated.id, email.account.id, undoWindowSeconds * 1000);
    } catch {
      await app.prisma.email.update({
        where: { id },
        data: { sendStatus: 'FAILED', sendError: 'Failed to queue email for sending' },
      });
      return reply.status(503).send({ error: 'Draft saved but failed to queue for sending' });
    }

    emitDraftsUpdated(app.io, request.user.userId);

    return { data: updated };
  });

  // Get draft count for badge
  app.get('/api/drafts/count', { preHandler: [authenticate] }, async (request) => {
    const accounts = await app.prisma.account.findMany({
      where: { userId: request.user.userId },
      select: { id: true },
    });

    const count = await app.prisma.email.count({
      where: {
        accountId: { in: accounts.map((a) => a.id) },
        isDraft: true,
      },
    });

    return { data: { count } };
  });
}
