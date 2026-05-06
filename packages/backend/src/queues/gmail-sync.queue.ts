import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';

export interface GmailSyncJobData {
  accountId: string;
  maxResults?: number;
}

export const gmailSyncQueue = new Queue<GmailSyncJobData, void, string>('gmail-sync', {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 500 },
  },
});

export async function addGmailSyncJob(data: GmailSyncJobData): Promise<string> {
  // Use timestamp-based jobId so completed jobs don't block future syncs.
  // BullMQ deduplication still prevents concurrent syncs for the same account
  // because a job with the same prefix won't stack while one is active.
  const job = await gmailSyncQueue.add('sync', data, {
    jobId: `gmail-sync-${data.accountId}-${Date.now()}`,
  });
  return job.id!;
}
