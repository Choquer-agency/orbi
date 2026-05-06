import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { getQueueConnection } from '../queues/connection.js';
import { historicalSyncMicrosoftAccount } from '../services/microsoft/microsoft-historical-sync.js';
import type { MicrosoftHistoricalSyncJobData } from '../queues/microsoft-historical-sync.queue.js';

const prisma = new PrismaClient();

async function processHistoricalSync(job: Job<MicrosoftHistoricalSyncJobData>): Promise<void> {
  const { accountId } = job.data;
  job.log(`Starting historical Microsoft sync for account ${accountId}`);

  await historicalSyncMicrosoftAccount(prisma, accountId, (progress) => {
    job.updateProgress({
      syncedMessages: progress.syncedMessages,
      totalMessages: progress.totalMessages,
      percentage: progress.totalMessages > 0
        ? Math.round((progress.syncedMessages / progress.totalMessages) * 100)
        : 0,
    });
  });

  job.log('Historical sync completed');
}

export const microsoftHistoricalSyncWorker = new Worker<MicrosoftHistoricalSyncJobData>(
  'microsoft-historical-sync',
  processHistoricalSync,
  {
    connection: getQueueConnection(),
    concurrency: 1,
    stalledInterval: 30000,
    lockDuration: 60000,
  },
);

microsoftHistoricalSyncWorker.on('completed', (job) => {
  console.log(`[microsoft-historical-sync] Job ${job.id} completed`);
});

microsoftHistoricalSyncWorker.on('failed', (job, err) => {
  console.error(`[microsoft-historical-sync] Job ${job?.id} failed:`, err.message);
});
