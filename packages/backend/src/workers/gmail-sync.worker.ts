import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { getQueueConnection } from '../queues/connection.js';
import { syncGmailAccount } from '../services/gmail/gmail-sync.js';
import { emitThreadsUpdated } from '../services/socket-events.js';
import { createNotificationIfAllowed } from '../services/notifications.js';
import { sendSilentPush } from '../services/push/send-push.js';
import type { GmailSyncJobData } from '../queues/gmail-sync.queue.js';

const prisma = new PrismaClient();

export function createGmailSyncWorker(io: Server): Worker<GmailSyncJobData> {
  async function processGmailSync(job: Job<GmailSyncJobData>): Promise<void> {
    const { accountId, maxResults } = job.data;
    job.log(`Starting Gmail sync for account ${accountId}`);

    const result = await syncGmailAccount(prisma, accountId, maxResults);

    job.log(
      `Sync complete: ${result.threadsUpserted} threads, ${result.emailsUpserted} emails, ${result.errors.length} errors`,
    );

    if (result.errors.length > 0) {
      job.log(`Errors: ${result.errors.join('; ')}`);
    }

    // Emit real-time event when new threads were synced
    if (result.threadsUpserted > 0) {
      const account = await prisma.account.findUnique({
        where: { id: accountId },
        select: { userId: true, email: true },
      });
      if (account) {
        emitThreadsUpdated(io, account.userId);

        // Create push notifications for genuinely new inbound emails.
        // Query emails created in the last 30 seconds that are inbound (not sent by user).
        const recentCutoff = new Date(Date.now() - 30_000);
        const newInbound = await prisma.email.findMany({
          where: {
            accountId,
            createdAt: { gte: recentCutoff },
            fromAddress: { not: account.email },
            isDraft: false,
            sendStatus: 'NONE',
          },
          select: { id: true, threadId: true, fromName: true, fromAddress: true, subject: true },
          orderBy: { receivedAt: 'desc' },
          take: 6, // Cap to prevent notification flood
        });

        if (newInbound.length > 0 && newInbound.length <= 5) {
          for (const email of newInbound) {
            await createNotificationIfAllowed(prisma, {
              userId: account.userId,
              type: 'NEW_EMAIL',
              title: email.fromName || email.fromAddress,
              body: email.subject,
              data: { threadId: email.threadId, emailId: email.id, accountId },
            }, io);
          }
        } else if (newInbound.length > 5) {
          // Batch summary to avoid flooding
          await createNotificationIfAllowed(prisma, {
            userId: account.userId,
            type: 'NEW_EMAIL',
            title: `${newInbound.length} new emails`,
            body: `From ${newInbound[0].fromName || newInbound[0].fromAddress} and others`,
            data: { type: 'batch_summary', accountId },
          }, io);
        }

        // If no new inbound emails triggered visible notifications,
        // send a silent push to keep background data fresh
        if (newInbound.length === 0) {
          sendSilentPush(prisma, account.userId, { type: 'sync_complete', accountId }).catch(() => {});
        }
      }
    }
  }

  const worker = new Worker<GmailSyncJobData>(
    'gmail-sync',
    processGmailSync,
    {
      connection: getQueueConnection(),
      concurrency: 3,
    },
  );

  worker.on('completed', (job) => {
    console.log(`[gmail-sync] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[gmail-sync] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

/**
 * Schedule periodic sync for all active Gmail accounts.
 */
export async function scheduleGmailSyncs(): Promise<void> {
  const { addGmailSyncJob } = await import('../queues/gmail-sync.queue.js');

  const accounts = await prisma.account.findMany({
    where: { provider: 'GMAIL', isActive: true },
    select: { id: true },
  });

  for (const account of accounts) {
    try {
      await addGmailSyncJob({ accountId: account.id });
    } catch {
      // Job already exists (deduplication) — skip
    }
  }

  console.log(`[gmail-sync] Scheduled sync for ${accounts.length} Gmail account(s)`);
}
