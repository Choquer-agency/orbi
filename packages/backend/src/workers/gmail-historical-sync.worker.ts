import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { getQueueConnection } from '../queues/connection.js';
import { historicalSyncGmailAccount } from '../services/gmail/gmail-historical-sync.js';
import type { GmailHistoricalSyncJobData } from '../queues/gmail-historical-sync.queue.js';

const prisma = new PrismaClient();

async function processHistoricalSync(job: Job<GmailHistoricalSyncJobData>): Promise<void> {
  const { accountId } = job.data;
  job.log(`Starting historical Gmail sync for account ${accountId}`);

  await historicalSyncGmailAccount(prisma, accountId, (progress) => {
    job.updateProgress({
      syncedThreads: progress.syncedThreads,
      totalThreads: progress.totalThreads,
      percentage: progress.totalThreads > 0
        ? Math.round((progress.syncedThreads / progress.totalThreads) * 100)
        : 0,
    });
  });

  job.log('Historical sync completed');
}

export const gmailHistoricalSyncWorker = new Worker<GmailHistoricalSyncJobData>(
  'gmail-historical-sync',
  processHistoricalSync,
  {
    connection: getQueueConnection(),
    concurrency: 1,
    // Detect stalled jobs quickly (important during dev hot-reloads)
    stalledInterval: 30000,
    lockDuration: 60000,
  },
);

gmailHistoricalSyncWorker.on('completed', (job) => {
  console.log(`[historical-sync] Job ${job.id} completed`);
});

gmailHistoricalSyncWorker.on('failed', (job, err) => {
  console.error(`[historical-sync] Job ${job?.id} failed:`, err.message);
});
