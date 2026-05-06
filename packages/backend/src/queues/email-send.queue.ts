import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';

export interface EmailSendJobData {
  emailId: string;
  accountId: string;
}

export const emailSendQueue = new Queue<EmailSendJobData, void, string>('email-send', {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export async function addSendJob(data: EmailSendJobData): Promise<string> {
  const job = await emailSendQueue.add('send', data);
  return job.id!;
}
