import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { getQueueConnection } from '../queues/connection.js';
import { addSendJob } from '../queues/email-send.queue.js';
import type { ScheduledSendJobData } from '../queues/scheduled-send.queue.js';

const prisma = new PrismaClient();

async function processScheduledSend(job: Job<ScheduledSendJobData>): Promise<void> {
  const { scheduledEmailId } = job.data;

  const scheduled = await prisma.scheduledEmail.findUnique({
    where: { id: scheduledEmailId },
    include: { account: true },
  });

  if (!scheduled) {
    job.log(`Scheduled email ${scheduledEmailId} not found — skipping`);
    return;
  }

  if (scheduled.status !== 'SCHEDULED') {
    job.log(`Scheduled email ${scheduledEmailId} has status ${scheduled.status} — skipping`);
    return;
  }

  // Mark as sending
  await prisma.scheduledEmail.update({
    where: { id: scheduledEmailId },
    data: { status: 'SENDING' },
  });

  try {
    const now = new Date();

    if (scheduled.mode === 'reply' && scheduled.parentEmailId) {
      // Create reply email in the thread
      const parentEmail = await prisma.email.findUnique({
        where: { id: scheduled.parentEmailId },
      });

      if (!parentEmail) {
        throw new Error(`Parent email ${scheduled.parentEmailId} not found`);
      }

      const email = await prisma.email.create({
        data: {
          accountId: scheduled.accountId,
          threadId: parentEmail.threadId,
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
        },
      });

      await prisma.thread.update({
        where: { id: parentEmail.threadId },
        data: { snippet: scheduled.bodyText.slice(0, 200) },
      });

      // Enqueue for actual provider send
      await addSendJob({ emailId: email.id, accountId: scheduled.accountId });

      await prisma.scheduledEmail.update({
        where: { id: scheduledEmailId },
        data: { status: 'SENT', sentEmailId: email.id },
      });
    } else {
      // New compose or forward — create thread + email
      const thread = await prisma.thread.create({
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

      const email = await prisma.email.create({
        data: {
          accountId: scheduled.accountId,
          threadId: thread.id,
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
        },
      });

      await addSendJob({ emailId: email.id, accountId: scheduled.accountId });

      await prisma.scheduledEmail.update({
        where: { id: scheduledEmailId },
        data: { status: 'SENT', sentEmailId: email.id },
      });
    }

    job.log(`Scheduled email ${scheduledEmailId} sent successfully`);
  } catch (err: any) {
    await prisma.scheduledEmail.update({
      where: { id: scheduledEmailId },
      data: { status: 'FAILED', failureReason: err.message },
    });
    throw err;
  }
}

export const scheduledSendWorker = new Worker<ScheduledSendJobData>(
  'scheduled-send',
  processScheduledSend,
  {
    connection: getQueueConnection(),
    concurrency: 3,
  },
);

scheduledSendWorker.on('completed', (job) => {
  console.log(`[scheduled-send] Job ${job.id} completed`);
});

scheduledSendWorker.on('failed', (job, err) => {
  console.error(`[scheduled-send] Job ${job?.id} failed:`, err.message);
});
