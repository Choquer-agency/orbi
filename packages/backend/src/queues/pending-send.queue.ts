import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';

export interface PendingSendJobData {
  emailId: string;
  accountId: string;
}

export const pendingSendQueue = new Queue<PendingSendJobData, void, string>('pending-send', {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 1000 },
  },
});

export async function addPendingSendJob(
  emailId: string,
  accountId: string,
  delayMs: number,
): Promise<string> {
  const job = await pendingSendQueue.add(
    'pending-send',
    { emailId, accountId },
    { delay: delayMs, jobId: `undo-${emailId}` },
  );
  return job.id!;
}

export async function removePendingSendJob(emailId: string): Promise<void> {
  const job = await pendingSendQueue.getJob(`undo-${emailId}`);
  if (job) {
    await job.remove();
  }
}
