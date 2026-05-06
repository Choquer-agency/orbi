import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';

export interface MicrosoftSyncJobData {
  accountId: string;
  maxResults?: number;
}

export const microsoftSyncQueue = new Queue<MicrosoftSyncJobData, void, string>('microsoft-sync', {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

export async function addMicrosoftSyncJob(data: MicrosoftSyncJobData): Promise<string> {
  const job = await microsoftSyncQueue.add('sync', data, {
    jobId: `microsoft-sync-${data.accountId}-${Date.now()}`,
  });
  return job.id!;
}
