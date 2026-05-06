import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';

export interface ClassifyEmailJobData {
  emailId: string;
}

export const classifyEmailQueue = new Queue<ClassifyEmailJobData, void, string>('classify-email', {
  connection: getQueueConnection(),
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { count: 2000 },
    removeOnFail: { count: 5000 },
  },
});

export async function addClassifyJob(emailId: string): Promise<string> {
  const job = await classifyEmailQueue.add('classify', { emailId });
  return job.id!;
}
