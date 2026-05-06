import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import { getQueueConnection } from '../queues/connection.js';
import { addSendJob } from '../queues/email-send.queue.js';
import type { PendingSendJobData } from '../queues/pending-send.queue.js';

const prisma = new PrismaClient();

async function processPendingSend(job: Job<PendingSendJobData>): Promise<void> {
  const { emailId, accountId } = job.data;

  const email = await prisma.email.findUnique({ where: { id: emailId } });

  if (!email) {
    job.log(`Email ${emailId} not found — skipping`);
    return;
  }

  if (email.sendStatus === 'UNDONE') {
    job.log(`Email ${emailId} was undone — skipping`);
    return;
  }

  if (email.sendStatus !== 'PENDING_SEND') {
    job.log(`Email ${emailId} has status ${email.sendStatus} — skipping`);
    return;
  }

  // Transition to SENT and enqueue for actual provider delivery
  await prisma.email.update({
    where: { id: emailId },
    data: { sendStatus: 'SENT' },
  });

  await addSendJob({ emailId, accountId });
  job.log(`Email ${emailId} undo window expired — proceeding to send`);
}

export const pendingSendWorker = new Worker<PendingSendJobData>(
  'pending-send',
  processPendingSend,
  {
    connection: getQueueConnection(),
    concurrency: 10,
  },
);

pendingSendWorker.on('completed', (job) => {
  console.log(`[pending-send] Job ${job.id} completed`);
});

pendingSendWorker.on('failed', (job, err) => {
  console.error(`[pending-send] Job ${job?.id} failed:`, err.message);
});
