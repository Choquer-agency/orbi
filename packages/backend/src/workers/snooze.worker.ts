import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { getQueueConnection } from '../queues/connection.js';
import { createNotificationIfAllowed } from '../services/notifications.js';
import { emitThreadsUpdated } from '../services/socket-events.js';
import type { SnoozeJobData } from '../queues/snooze.queue.js';

const prisma = new PrismaClient();

async function processSnooze(job: Job<SnoozeJobData>, io: Server): Promise<void> {
  const { threadId, userId } = job.data;

  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
  });

  if (!thread) {
    job.log(`Thread ${threadId} not found — skipping`);
    return;
  }

  if (!thread.snoozedUntil) {
    job.log(`Thread ${threadId} is no longer snoozed — skipping`);
    return;
  }

  // Clear the snooze
  await prisma.thread.update({
    where: { id: threadId },
    data: { snoozedUntil: null },
  });

  // Notify the user (now with io for real-time + push delivery)
  await createNotificationIfAllowed(prisma, {
    userId,
    type: 'SNOOZE_REMINDER',
    title: 'Snoozed thread is back',
    body: thread.subject,
    data: { threadId },
  }, io);

  // Emit thread update so the UI refreshes
  emitThreadsUpdated(io, [userId], [threadId]);

  job.log(`Thread ${threadId} unsnoozed and notification sent`);
}

export function createSnoozeWorker(io: Server): Worker<SnoozeJobData> {
  const worker = new Worker<SnoozeJobData>(
    'snooze',
    (job) => processSnooze(job, io),
    {
      connection: getQueueConnection(),
      concurrency: 3,
    },
  );

  worker.on('completed', (job) => {
    console.log(`[snooze-worker] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[snooze-worker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
