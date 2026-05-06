import type { PrismaClient } from '@prisma/client';
import { getGmailClient, syncSingleThread } from './gmail-sync.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HistoricalSyncProgress {
  syncedThreads: number;
  totalThreads: number;
  pageToken?: string;
  startedAt: string;
  lastBatchAt: string;
  error?: string;
}

/**
 * Full historical Gmail sync — paginates through ALL threads and imports them.
 * Stores progress in the Account record for resumability.
 */
export async function historicalSyncGmailAccount(
  prisma: PrismaClient,
  accountId: string,
  onProgress?: (progress: HistoricalSyncProgress) => void,
): Promise<void> {
  const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  const gmail = await getGmailClient(prisma, accountId);

  // Gather user emails for contact extraction
  const userAccounts = await prisma.account.findMany({
    where: { userId: account.userId },
    select: { email: true },
  });
  const userEmails = userAccounts.map((a) => a.email.toLowerCase());

  // Check for existing progress (resume support)
  const existingProgress = account.historicalSyncProgress as HistoricalSyncProgress | null;
  let syncedThreads = existingProgress?.syncedThreads ?? 0;
  let resumePageToken = existingProgress?.pageToken ?? undefined;
  let totalThreads = existingProgress?.totalThreads ?? 0;
  const startedAt = existingProgress?.startedAt ?? new Date().toISOString();

  // Mark as in-progress
  await prisma.account.update({
    where: { id: accountId },
    data: {
      historicalSyncStatus: 'IN_PROGRESS',
      historicalSyncProgress: {
        syncedThreads,
        totalThreads,
        pageToken: resumePageToken,
        startedAt,
        lastBatchAt: new Date().toISOString(),
      } as any,
    },
  });

  try {
    let pageToken: string | undefined = resumePageToken;
    let isFirstPage = !resumePageToken;

    // Paginate through all threads
    while (true) {
      const listRes = await gmail.users.threads.list({
        userId: 'me',
        maxResults: 100,
        q: '-in:spam -in:trash',
        pageToken,
      });

      // Use resultSizeEstimate as total estimate, update each page
      if (listRes.data.resultSizeEstimate) {
        // Keep the higher of current estimate or synced count
        totalThreads = Math.max(listRes.data.resultSizeEstimate, syncedThreads);
        isFirstPage = false;
      }

      const threadIds = listRes.data.threads?.map((t) => t.id!) ?? [];
      if (threadIds.length === 0) break;

      // Process in batches of 25
      for (let i = 0; i < threadIds.length; i += 25) {
        const batch = threadIds.slice(i, i + 25);

        for (const gmailThreadId of batch) {
          let retries = 0;
          while (retries < 3) {
            try {
              await syncSingleThread(prisma, gmail, accountId, gmailThreadId, account.userId, userEmails);
              syncedThreads++;
              // Rate limit: 130ms between threads.get calls (~192 quota units/sec)
              await delay(130);
              break;
            } catch (err: any) {
              if (err.code === 429 || err.status === 429) {
                // Rate limited — wait and retry
                const retryAfter = parseInt(err.headers?.['retry-after'] || '60', 10);
                console.log(`[historical-sync] Rate limited, waiting ${retryAfter}s`);
                await delay(retryAfter * 1000);
                retries++;
              } else if (err.code >= 500 && retries < 2) {
                // Server error — retry with backoff
                await delay(Math.pow(2, retries) * 1000);
                retries++;
              } else {
                // Skip this thread on other errors
                console.error(`[historical-sync] Failed thread ${gmailThreadId}: ${err.message}`);
                break;
              }
            }
          }
        }

        // Update progress after each batch
        const progress: HistoricalSyncProgress = {
          syncedThreads,
          totalThreads,
          pageToken: listRes.data.nextPageToken ?? pageToken,
          startedAt,
          lastBatchAt: new Date().toISOString(),
        };

        await prisma.account.update({
          where: { id: accountId },
          data: { historicalSyncProgress: progress as any },
        });

        onProgress?.(progress);
      }

      pageToken = listRes.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }

    // Update syncCursor for future incremental syncs
    const profile = await gmail.users.getProfile({ userId: 'me' });

    await prisma.account.update({
      where: { id: accountId },
      data: {
        historicalSyncStatus: 'COMPLETED',
        historicalSyncCompletedAt: new Date(),
        historicalSyncProgress: {
          syncedThreads,
          totalThreads: syncedThreads,
          startedAt,
          lastBatchAt: new Date().toISOString(),
        } as any,
        ...(profile.data.historyId
          ? { syncCursor: profile.data.historyId, lastSyncAt: new Date() }
          : {}),
      },
    });

    console.log(`[historical-sync] Completed for ${account.email}: ${syncedThreads} threads synced`);
  } catch (err: any) {
    // Store error and mark as failed
    await prisma.account.update({
      where: { id: accountId },
      data: {
        historicalSyncStatus: 'FAILED',
        historicalSyncProgress: {
          syncedThreads,
          totalThreads,
          pageToken: resumePageToken,
          startedAt,
          lastBatchAt: new Date().toISOString(),
          error: err.message,
        } as any,
      },
    });

    console.error(`[historical-sync] Failed for ${account.email}: ${err.message}`);
    throw err;
  }
}
