import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';

export interface GmailHistoricalSyncJobData {
  accountId: string;
}

export const gmailHistoricalSyncQueue = new Queue<GmailHistoricalSyncJobData, void, string>(
  'gmail-historical-sync',
  {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30000 },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 50 },
    },
  },
);

export async function addGmailHistoricalSyncJob(data: GmailHistoricalSyncJobData): Promise<string> {
  const job = await gmailHistoricalSyncQueue.add('historical-sync', data, {
    jobId: `gmail-historical-sync-${data.accountId}`,
  });
  return job.id!;
}
