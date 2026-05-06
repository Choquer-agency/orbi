import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';

export interface SnoozeJobData {
  threadId: string;
  userId: string;
}

export const snoozeQueue = new Queue<SnoozeJobData, void, string>('snooze', {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 2000 },
  },
});

export async function addSnoozeJob(
  threadId: string,
  userId: string,
  delay: number,
): Promise<string> {
  // Remove any existing snooze job for this thread first
  await removeSnoozeJob(threadId);

  const job = await snoozeQueue.add(
    'snooze',
    { threadId, userId },
    { delay, jobId: threadId },
  );
  return job.id!;
}

export async function removeSnoozeJob(threadId: string): Promise<void> {
  const job = await snoozeQueue.getJob(threadId);
  if (job) {
    await job.remove();
  }
}
