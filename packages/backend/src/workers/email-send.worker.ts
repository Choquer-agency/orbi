import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { getQueueConnection } from '../queues/connection.js';
import { sendViaGmail } from '../services/gmail/gmail-sync.js';
import { emitThreadsUpdated } from '../services/socket-events.js';
import { createNotificationIfAllowed } from '../services/notifications.js';
import type { EmailSendJobData } from '../queues/email-send.queue.js';

const prisma = new PrismaClient();

export function createEmailSendWorker(io: Server): Worker<EmailSendJobData> {
  async function processEmailSend(job: Job<EmailSendJobData>): Promise<void> {
    const { emailId, accountId } = job.data;
    job.log(`Processing email send: emailId=${emailId}, accountId=${accountId}`);

    // 1. Load email and check current state
    const email = await prisma.email.findUnique({ where: { id: emailId } });
    if (!email) {
      job.log(`Email ${emailId} not found — skipping`);
      return;
    }

    // 2. Idempotency guard: if already delivered/sent with a real provider ID, skip
    if (
      email.providerMessageId &&
      !email.providerMessageId.startsWith('local-') &&
      (email.sendStatus === 'SENT' || email.sendStatus === 'DELIVERED')
    ) {
      job.log(`Email ${emailId} already sent (providerMessageId=${email.providerMessageId}) — skipping`);
      return;
    }

    // 3. If already undone, skip
    if (email.sendStatus === 'UNDONE') {
      job.log(`Email ${emailId} was undone — skipping`);
      return;
    }

    // 4. Claim the email for sending (SENDING status prevents double-send)
    await prisma.email.update({
      where: { id: emailId },
      data: {
        sendStatus: 'SENDING',
        sendAttempts: { increment: 1 },
        sendError: null,
      },
    });

    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });

    try {
      if (account.provider === 'GMAIL') {
        const result = await sendViaGmail(prisma, accountId, emailId);
        job.log(`Sent via Gmail: providerMessageId=${result.providerMessageId}`);

        // 5. Mark as DELIVERED (verified by Gmail API returning a message ID)
        await prisma.email.update({
          where: { id: emailId },
          data: {
            sendStatus: 'DELIVERED',
            sendError: null,
          },
        });

        // Emit real-time update
        emitThreadsUpdated(io, account.userId, [email.threadId]);
      } else if (account.provider === 'MICROSOFT') {
        const { sendViaMicrosoft } = await import('../services/microsoft/microsoft-send.js');
        const result = await sendViaMicrosoft(prisma, accountId, emailId);
        job.log(`Sent via Microsoft Graph: providerMessageId=${result.providerMessageId}`);

        await prisma.email.update({
          where: { id: emailId },
          data: {
            sendStatus: 'DELIVERED',
            sendError: null,
          },
        });

        emitThreadsUpdated(io, account.userId, [email.threadId]);
      } else {
        // IMAP not yet implemented — mark as failed
        const msg = `Provider ${account.provider} send not yet implemented`;
        job.log(msg);
        await prisma.email.update({
          where: { id: emailId },
          data: {
            sendStatus: 'FAILED',
            sendError: msg,
          },
        });
      }
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error';
      job.log(`Send failed: ${errorMsg}`);

      const updated = await prisma.email.findUnique({ where: { id: emailId } });
      const attempts = updated?.sendAttempts ?? 1;
      const maxAttempts = 3; // matches BullMQ retry config

      if (attempts >= maxAttempts) {
        // All retries exhausted — mark as FAILED for manual intervention
        await prisma.email.update({
          where: { id: emailId },
          data: {
            sendStatus: 'FAILED',
            sendError: `Failed after ${attempts} attempts: ${errorMsg}`,
          },
        });

        // Create a notification for the user (with real-time push)
        const emailRecord = await prisma.email.findUnique({
          where: { id: emailId },
          include: { account: true },
        });
        if (emailRecord) {
          await createNotificationIfAllowed(
            prisma,
            {
              userId: emailRecord.account.userId,
              type: 'SLA_WARNING',
              title: 'Email failed to send',
              body: `"${emailRecord.subject}" to ${(emailRecord.toAddresses as any[])?.[0]?.email ?? 'unknown'} could not be delivered. Please retry or check your account connection.`,
              data: { emailId, threadId: emailRecord.threadId },
            },
            io,
          );

          emitThreadsUpdated(io, emailRecord.account.userId, [emailRecord.threadId]);
        }

        job.log(`Email ${emailId} permanently failed after ${attempts} attempts`);
      } else {
        // Will be retried by BullMQ — record the error
        await prisma.email.update({
          where: { id: emailId },
          data: {
            sendStatus: 'SENT', // reset so retry picks it up
            sendError: `Attempt ${attempts} failed: ${errorMsg}`,
          },
        });
      }

      throw err; // re-throw so BullMQ handles the retry
    }
  }

  const worker = new Worker<EmailSendJobData>(
    'email-send',
    processEmailSend,
    {
      connection: getQueueConnection(),
      concurrency: 5,
    },
  );

  worker.on('completed', (job) => {
    console.log(`[email-send] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[email-send] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
