import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';

export interface MicrosoftHistoricalSyncJobData {
  accountId: string;
}

export const microsoftHistoricalSyncQueue = new Queue<MicrosoftHistoricalSyncJobData, void, string>(
  'microsoft-historical-sync',
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

export async function addMicrosoftHistoricalSyncJob(data: MicrosoftHistoricalSyncJobData): Promise<string> {
  const job = await microsoftHistoricalSyncQueue.add('historical-sync', data, {
    jobId: `microsoft-historical-sync-${data.accountId}`,
  });
  return job.id!;
}
