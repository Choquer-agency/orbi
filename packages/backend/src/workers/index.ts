import type { Worker } from 'bullmq';
import type { Server } from 'socket.io';
import { createEmailSendWorker } from './email-send.worker.js';
import { scheduledSendWorker } from './scheduled-send.worker.js';
import { pendingSendWorker } from './pending-send.worker.js';
import { createClassifyEmailWorker } from './classify-email.worker.js';
import { createFollowUpWorker, scheduleFollowUpChecks } from './follow-up.worker.js';
import { createGmailSyncWorker, scheduleGmailSyncs } from './gmail-sync.worker.js';
import { gmailHistoricalSyncWorker } from './gmail-historical-sync.worker.js';
import { createMicrosoftSyncWorker, scheduleMicrosoftSyncs } from './microsoft-sync.worker.js';
import { microsoftHistoricalSyncWorker } from './microsoft-historical-sync.worker.js';
import { createSnoozeWorker } from './snooze.worker.js';

let activeWorkers: Worker[] = [];
let followUpInterval: ReturnType<typeof setInterval> | null = null;
let gmailSyncInterval: ReturnType<typeof setInterval> | null = null;
let microsoftSyncInterval: ReturnType<typeof setInterval> | null = null;

export function startWorkers(io: Server): void {
  activeWorkers = [
    createEmailSendWorker(io),
    scheduledSendWorker,
    pendingSendWorker,
    createClassifyEmailWorker(io),
    createFollowUpWorker(io),
    createGmailSyncWorker(io),
    gmailHistoricalSyncWorker,
    createMicrosoftSyncWorker(io),
    microsoftHistoricalSyncWorker,
    createSnoozeWorker(io),
  ];

  console.log(`[workers] Started ${activeWorkers.length} worker(s): ${activeWorkers.map((w) => w.name).join(', ')}`);

  // Run follow-up scheduler every hour
  followUpInterval = setInterval(() => {
    scheduleFollowUpChecks().catch((err) =>
      console.error('[follow-up-scheduler] Error:', err.message),
    );
  }, 60 * 60 * 1000);

  // Run Gmail sync every 5 seconds for near-real-time inbox
  // Incremental sync = 2 quota units (history.list), well within Gmail's 250 units/sec limit.
  // BullMQ job deduplication prevents overlapping syncs per account.
  scheduleGmailSyncs().catch((err) =>
    console.error('[gmail-sync-scheduler] Initial sync error:', err.message),
  );
  gmailSyncInterval = setInterval(() => {
    scheduleGmailSyncs().catch((err) =>
      console.error('[gmail-sync-scheduler] Error:', err.message),
    );
  }, 5 * 1000);

  // Run Microsoft sync every 5 seconds (delta queries are lightweight)
  scheduleMicrosoftSyncs().catch((err) =>
    console.error('[microsoft-sync-scheduler] Initial sync error:', err.message),
  );
  microsoftSyncInterval = setInterval(() => {
    scheduleMicrosoftSyncs().catch((err) =>
      console.error('[microsoft-sync-scheduler] Error:', err.message),
    );
  }, 5 * 1000);
}

export async function stopWorkers(): Promise<void> {
  if (followUpInterval) clearInterval(followUpInterval);
  if (gmailSyncInterval) clearInterval(gmailSyncInterval);
  if (microsoftSyncInterval) clearInterval(microsoftSyncInterval);
  await Promise.all(activeWorkers.map((w) => w.close()));
  console.log('[workers] All workers stopped');
}
