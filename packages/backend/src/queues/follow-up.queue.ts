import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';

export interface FollowUpCheckJobData {
  watchId: string;
}

export const followUpQueue = new Queue<FollowUpCheckJobData, void, string>('follow-up-check', {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 2000 },
  },
});

export async function addFollowUpCheckJob(watchId: string): Promise<string> {
  const job = await followUpQueue.add('check', { watchId });
  return job.id!;
}
