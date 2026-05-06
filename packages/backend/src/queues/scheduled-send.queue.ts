import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';

export interface ScheduledSendJobData {
  scheduledEmailId: string;
}

export const scheduledSendQueue = new Queue<ScheduledSendJobData, void, string>('scheduled-send', {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 2000 },
  },
});

export async function addScheduledSendJob(
  scheduledEmailId: string,
  delay: number,
): Promise<string> {
  const job = await scheduledSendQueue.add(
    'scheduled-send',
    { scheduledEmailId },
    { delay, jobId: scheduledEmailId },
  );
  return job.id!;
}

export async function removeScheduledSendJob(scheduledEmailId: string): Promise<void> {
  const job = await scheduledSendQueue.getJob(scheduledEmailId);
  if (job) {
    await job.remove();
  }
}
