import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { getQueueConnection } from '../queues/connection.js';
import { FollowUpAgent } from '../services/ai/follow-up-agent.js';
import { createNotificationIfAllowed } from '../services/notifications.js';
import { addFollowUpCheckJob } from '../queues/follow-up.queue.js';
import type { FollowUpCheckJobData } from '../queues/follow-up.queue.js';

const prisma = new PrismaClient();
const agent = new FollowUpAgent(prisma);

async function processFollowUpCheck(job: Job<FollowUpCheckJobData>, io: Server): Promise<void> {
  const { watchId } = job.data;
  job.log(`Checking follow-up watch ${watchId}`);

  const result = await agent.checkWatch(watchId);

  if (!result) {
    job.log(`Watch ${watchId} not found or inactive`);
    return;
  }

  job.log(`Watch ${watchId}: ${result.status}`);

  if (result.status === 'drafted') {
    // Notify the user that a follow-up draft is ready
    const watch = await prisma.followUpWatch.findUnique({
      where: { id: watchId },
      include: { thread: true },
    });

    if (watch) {
      await createNotificationIfAllowed(prisma, {
        userId: watch.userId,
        type: 'SLA_WARNING',
        title: `Follow-up ready: ${watch.thread.subject}`,
        body: `No reply from ${watch.contactEmail} — a ${result.tone} follow-up draft is ready.`,
        data: { threadId: watch.threadId, watchId, type: 'follow_up_draft' },
      }, io);
    }
  }
}

export function createFollowUpWorker(io: Server): Worker<FollowUpCheckJobData> {
  const worker = new Worker<FollowUpCheckJobData>(
    'follow-up-check',
    (job) => processFollowUpCheck(job, io),
    {
      connection: getQueueConnection(),
      concurrency: 3,
    },
  );

  worker.on('completed', (job) => {
    console.log(`[follow-up-check] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[follow-up-check] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

// Scheduler: runs every hour, enqueues check jobs for watches that are due
export async function scheduleFollowUpChecks(): Promise<void> {
  const dueWatches = await prisma.followUpWatch.findMany({
    where: {
      status: 'WATCHING',
      nextCheckAt: { lte: new Date() },
    },
    select: { id: true },
  });

  for (const watch of dueWatches) {
    await addFollowUpCheckJob(watch.id);
  }

  if (dueWatches.length > 0) {
    console.log(`[follow-up-scheduler] Enqueued ${dueWatches.length} follow-up checks`);
  }
}
