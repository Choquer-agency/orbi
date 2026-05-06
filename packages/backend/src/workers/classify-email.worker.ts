import { Worker, Job } from 'bullmq';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { getQueueConnection } from '../queues/connection.js';
import { EmailClassifier, isTriageCategory } from '../services/ai/email-classifier.js';
import { MeetingDetector } from '../services/ai/meeting-detector.js';
import { emitThreadsUpdated } from '../services/socket-events.js';
import { createNotificationIfAllowed } from '../services/notifications.js';
import type { ClassifyEmailJobData } from '../queues/classify-email.queue.js';

const prisma = new PrismaClient();
const classifier = new EmailClassifier(prisma);
const meetingDetector = new MeetingDetector(prisma);

export function createClassifyEmailWorker(io: Server): Worker<ClassifyEmailJobData> {
  async function processClassifyEmail(job: Job<ClassifyEmailJobData>): Promise<void> {
    const { emailId } = job.data;
    job.log(`Classifying email ${emailId}`);

    // Resolve the userId from the email's account
    const emailRecord = await prisma.email.findUnique({
      where: { id: emailId },
      select: {
        threadId: true,
        subject: true,
        account: { select: { userId: true } },
      },
    });

    if (!emailRecord) {
      job.log(`Email ${emailId} not found, skipping`);
      return;
    }

    const userId = emailRecord.account.userId;

    // Use context-aware classification for better triage accuracy
    const result = await classifier.classifyWithContext(emailId, userId);
    const classification = result.classification;

    if (!classification) {
      job.log(`Email ${emailId} classification skipped`);
      return;
    }

    job.log(`Email ${emailId} classified as ${classification.category} (confidence: ${classification.confidence})`);

    // If classified as meeting_scheduling, trigger meeting detection
    if (classification.category === 'meeting_scheduling' && classification.confidence >= 0.7) {
      try {
        await meetingDetector.detect(emailId);
        job.log(`Meeting detection triggered for email ${emailId}`);
      } catch (err: any) {
        job.log(`Meeting detection failed: ${err.message}`);
      }
    }

    // Auto-sort triage categories when user has it enabled
    if (isTriageCategory(classification.category)) {
      const triageSettings = await prisma.triageSettings.findUnique({
        where: { userId },
      });

      if (triageSettings?.autoSortEnabled) {
        const threshold = triageSettings.confidenceThreshold;

        if (classification.confidence >= threshold) {
          const thread = await prisma.thread.findUnique({
            where: { id: emailRecord.threadId },
            select: { labels: true },
          });

          const labels = (thread?.labels ?? []) as string[];
          const filtered = labels.filter((l: string) => !l.startsWith('triage:'));
          filtered.push(`triage:${classification.category}`);

          await prisma.thread.update({
            where: { id: emailRecord.threadId },
            data: { labels: filtered },
          });

          job.log(`Auto-sorted thread ${emailRecord.threadId} to triage:${classification.category}`);

          // Create a notification for the toast (with real-time push)
          await createNotificationIfAllowed(
            prisma,
            {
              userId,
              type: 'ASSIGNMENT',
              title: 'Email auto-filed',
              body: `"${emailRecord.subject}" filed to ${classification.category}`,
              data: {
                type: 'triage_auto_sort',
                threadId: emailRecord.threadId,
                category: classification.category,
              },
            },
            io,
          );

          emitThreadsUpdated(io, userId, [emailRecord.threadId]);
        } else {
          job.log(`Confidence ${classification.confidence} below threshold ${threshold}, skipping auto-sort`);
        }
      }
    }

    // Check routing rules
    const rules = await prisma.routingRule.findMany({
      where: { category: classification.category, isActive: true },
      orderBy: { priority: 'desc' },
    });

    if (rules.length > 0 && classification.confidence >= 0.85) {
      const rule = rules[0];
      if (rule.assignToUserId) {
        await createNotificationIfAllowed(
          prisma,
          {
            userId: rule.assignToUserId,
            type: 'ASSIGNMENT',
            title: `Email routed to you: ${classification.category}`,
            body: classification.summary || emailRecord.subject,
            data: { threadId: emailRecord.threadId, emailId, category: classification.category },
          },
          io,
        );
      }
    }
  }

  const worker = new Worker<ClassifyEmailJobData>(
    'classify-email',
    processClassifyEmail,
    {
      connection: getQueueConnection(),
      concurrency: 3,
    },
  );

  worker.on('completed', (job) => {
    console.log(`[classify-email] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[classify-email] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
