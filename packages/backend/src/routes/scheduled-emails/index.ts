import type { FastifyInstance } from 'fastify';
import { authenticate } from '../../middleware/authenticate.js';
import {
  addScheduledSendJob,
  removeScheduledSendJob,
} from '../../queues/scheduled-send.queue.js';
import { addSendJob } from '../../queues/email-send.queue.js';
import { addPendingSendJob } from '../../queues/pending-send.queue.js';

export default async function scheduledEmailRoutes(app: FastifyInstance) {
  // Create a scheduled email
  app.post('/api/scheduled-emails', { preHandler: [authenticate] }, async (request, reply) => {
    const {
      accountId,
      threadId,
      parentEmailId,
      mode,
      to,
      cc,
      bcc,
      subject,
      bodyHtml,
      bodyText,
      sendAt,
    } = request.body as {
      accountId: string;
      threadId?: string;
      parentEmailId?: string;
      mode?: string;
      to: { email: string; name?: string }[];
      cc?: { email: string; name?: string }[];
      bcc?: { email: string; name?: string }[];
      subject: string;
      bodyHtml: string;
      bodyText: string;
      sendAt: string;
    };

    const sendAtDate = new Date(sendAt);
    const now = new Date();

    if (sendAtDate <= now) {
      return reply.status(400).send({ error: 'sendAt must be in the future' });
    }

    const account = await app.prisma.account.findFirst({
      where: { id: accountId, userId: request.user.userId },
    });

    if (!account) {
      return reply.status(404).send({ error: 'Account not found' });
    }

    const scheduled = await app.prisma.scheduledEmail.create({
      data: {
        userId: request.user.userId,
        accountId,
        threadId: threadId || null,
        parentEmailId: parentEmailId || null,
        mode: mode || 'compose',
        toAddresses: to,
        ccAddresses: cc ?? undefined,
        bccAddresses: bcc ?? undefined,
        subject,
        bodyHtml,
        bodyText,
        sendAt: sendAtDate,
      },
    });

    // Enqueue a delayed BullMQ job
    const delay = sendAtDate.getTime() - now.getTime();
    const jobId = await addScheduledSendJob(scheduled.id, delay);

    await app.prisma.scheduledEmail.update({
      where: { id: scheduled.id },
      data: { jobId },
    });

    return { data: { ...scheduled, jobId } };
  });

  // List scheduled emails
  app.get('/api/scheduled-emails', { preHandler: [authenticate] }, async (request) => {
    const { status } = request.query as { status?: string };

    const where: any = { userId: request.user.userId };
    if (status) {
      where.status = status;
    }

    const scheduledEmails = await app.prisma.scheduledEmail.findMany({
      where,
      orderBy: { sendAt: 'asc' },
      include: { account: { select: { email: true, displayName: true } } },
    });

    return { data: scheduledEmails };
  });

  // Get single scheduled email
  app.get('/api/scheduled-emails/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const scheduled = await app.prisma.scheduledEmail.findFirst({
      where: { id, userId: request.user.userId },
      include: { account: { select: { email: true, displayName: true } } },
    });

    if (!scheduled) {
      return reply.status(404).send({ error: 'Scheduled email not found' });
    }

    return { data: scheduled };
  });

  // Update a scheduled email (only if still SCHEDULED)
  app.patch('/api/scheduled-emails/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const updates = request.body as {
      sendAt?: string;
      subject?: string;
      bodyHtml?: string;
      bodyText?: string;
      to?: { email: string; name?: string }[];
    };

    const existing = await app.prisma.scheduledEmail.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'Scheduled email not found' });
    }

    if (existing.status !== 'SCHEDULED') {
      return reply.status(400).send({ error: 'Can only update emails with SCHEDULED status' });
    }

    const data: any = {};
    if (updates.subject !== undefined) data.subject = updates.subject;
    if (updates.bodyHtml !== undefined) data.bodyHtml = updates.bodyHtml;
    if (updates.bodyText !== undefined) data.bodyText = updates.bodyText;
    if (updates.to !== undefined) data.toAddresses = updates.to;

    if (updates.sendAt) {
      const newSendAt = new Date(updates.sendAt);
      if (newSendAt <= new Date()) {
        return reply.status(400).send({ error: 'sendAt must be in the future' });
      }
      data.sendAt = newSendAt;

      // Reschedule BullMQ job
      await removeScheduledSendJob(id);
      const delay = newSendAt.getTime() - Date.now();
      const newJobId = await addScheduledSendJob(id, delay);
      data.jobId = newJobId;
    }

    const updated = await app.prisma.scheduledEmail.update({
      where: { id },
      data,
    });

    return { data: updated };
  });

  // Send a scheduled email immediately with undo support
  app.post('/api/scheduled-emails/:id/send-now', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { undoWindowSeconds } = (request.body as { undoWindowSeconds?: number } | null) ?? {};

    const scheduled = await app.prisma.scheduledEmail.findFirst({
      where: { id, userId: request.user.userId },
      include: { account: true },
    });

    if (!scheduled) {
      return reply.status(404).send({ error: 'Scheduled email not found' });
    }

    if (scheduled.status !== 'SCHEDULED') {
      return reply.status(400).send({ error: 'Can only send emails with SCHEDULED status' });
    }

    // Remove the delayed BullMQ job (if it exists)
    try { await removeScheduledSendJob(id); } catch { /* ok */ }

    // Mark as sending
    await app.prisma.scheduledEmail.update({ where: { id }, data: { status: 'SENDING' } });

    try {
      const now = new Date();
      const useUndo = undoWindowSeconds && undoWindowSeconds > 0;
      const undoDeadlineAt = useUndo
        ? new Date(now.getTime() + undoWindowSeconds * 1000)
        : null;

      let email: any;
      let threadId: string;

      if (scheduled.mode === 'reply' && scheduled.parentEmailId) {
        const parentEmail = await app.prisma.email.findUnique({ where: { id: scheduled.parentEmailId } });
        if (!parentEmail) throw new Error('Parent email not found');
        threadId = parentEmail.threadId;

        email = await app.prisma.email.create({
          data: {
            accountId: scheduled.accountId,
            threadId,
            providerMessageId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            inReplyTo: parentEmail.internetMessageId || parentEmail.providerMessageId,
            fromAddress: scheduled.account.email,
            fromName: scheduled.account.displayName || scheduled.account.email.split('@')[0],
            toAddresses: scheduled.toAddresses as any,
            subject: scheduled.subject,
            bodyText: scheduled.bodyText,
            bodyHtml: scheduled.bodyHtml,
            snippet: scheduled.bodyText.slice(0, 200),
            isRead: true,
            labels: ['SENT'],
            receivedAt: now,
            sentAt: now,
            sendStatus: useUndo ? 'PENDING_SEND' : 'SENT',
            undoDeadlineAt,
          },
        });

        await app.prisma.thread.update({
          where: { id: threadId },
          data: { snippet: scheduled.bodyText.slice(0, 200) },
        });
      } else {
        const thread = await app.prisma.thread.create({
          data: {
            accountId: scheduled.accountId,
            providerThreadId: `local-thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            subject: scheduled.subject,
            snippet: scheduled.bodyText.slice(0, 200),
            isRead: true,
            participantEmails: ((scheduled.toAddresses as any) || []).map((a: any) => a.email),
            messageCount: 1,
            lastMessageAt: now,
          },
        });
        threadId = thread.id;

        email = await app.prisma.email.create({
          data: {
            accountId: scheduled.accountId,
            threadId,
            providerMessageId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            fromAddress: scheduled.account.email,
            fromName: scheduled.account.displayName || scheduled.account.email.split('@')[0],
            toAddresses: scheduled.toAddresses as any,
            ccAddresses: scheduled.ccAddresses as any,
            bccAddresses: scheduled.bccAddresses as any,
            subject: scheduled.subject,
            bodyText: scheduled.bodyText,
            bodyHtml: scheduled.bodyHtml,
            snippet: scheduled.bodyText.slice(0, 200),
            isRead: true,
            labels: ['SENT'],
            receivedAt: now,
            sentAt: now,
            sendStatus: useUndo ? 'PENDING_SEND' : 'SENT',
            undoDeadlineAt,
          },
        });
      }

      if (useUndo) {
        await addPendingSendJob(email.id, scheduled.accountId, undoWindowSeconds * 1000);
      } else {
        await addSendJob({ emailId: email.id, accountId: scheduled.accountId });
      }

      await app.prisma.scheduledEmail.update({ where: { id }, data: { status: 'SENT', sentEmailId: email.id } });

      return {
        data: {
          id: email.id,
          threadId,
          undoDeadlineAt: undoDeadlineAt?.toISOString() ?? null,
        },
      };
    } catch (err: any) {
      await app.prisma.scheduledEmail.update({ where: { id }, data: { status: 'FAILED', failureReason: err.message } });
      return reply.status(500).send({ error: 'Failed to send', message: err.message });
    }
  });

  // Cancel a scheduled email
  app.delete('/api/scheduled-emails/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const existing = await app.prisma.scheduledEmail.findFirst({
      where: { id, userId: request.user.userId },
    });

    if (!existing) {
      return reply.status(404).send({ error: 'Scheduled email not found' });
    }

    if (existing.status !== 'SCHEDULED') {
      return reply.status(400).send({ error: 'Can only cancel emails with SCHEDULED status' });
    }

    // Remove BullMQ job
    await removeScheduledSendJob(id);

    const cancelled = await app.prisma.scheduledEmail.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    return { data: cancelled };
  });
}
