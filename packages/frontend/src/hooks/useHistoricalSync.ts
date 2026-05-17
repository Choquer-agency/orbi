import { useState } from 'react';
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

interface SyncStatusData {
  historicalSyncStatus: 'IDLE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  historicalSyncProgress: {
    syncedThreads: number;
    totalThreads: number;
    pageToken?: string;
    startedAt: string;
    lastBatchAt: string;
    error?: string;
  } | null;
  historicalSyncCompletedAt: string | null;
  lastSyncAt: string | null;
}

function toIso(ts: number | string | null | undefined): string | null {
  if (ts === null || ts === undefined) return null;
  if (typeof ts === 'string') return ts;
  return new Date(ts).toISOString();
}

export function useHistoricalSyncStatus(accountId: string | null) {
  const data = useQuery(
    api.mailAccounts.getSyncStatus,
    accountId ? { accountId: accountId as Id<'mailAccounts'> } : 'skip',
  );
  const shaped = data
    ? {
        data: {
          historicalSyncStatus:
            (data.historicalSyncStatus as SyncStatusData['historicalSyncStatus']) ??
            'IDLE',
          historicalSyncProgress: data.historicalSyncProgress
            ? {
                syncedThreads:
                  // Gmail uses syncedThreads / totalThreads; Microsoft uses
                  // syncedMessages / totalMessages — normalize for the UI.
                  (data.historicalSyncProgress as {
                    syncedThreads?: number;
                    syncedMessages?: number;
                  }).syncedThreads ??
                  (data.historicalSyncProgress as { syncedMessages?: number })
                    .syncedMessages ??
                  0,
                totalThreads:
                  (data.historicalSyncProgress as {
                    totalThreads?: number;
                    totalMessages?: number;
                  }).totalThreads ??
                  (data.historicalSyncProgress as { totalMessages?: number })
                    .totalMessages ??
                  0,
                pageToken:
                  (data.historicalSyncProgress as { pageToken?: string })
                    .pageToken,
                startedAt:
                  toIso(
                    (data.historicalSyncProgress as { startedAt?: number | string })
                      .startedAt ?? null,
                  ) ?? '',
                lastBatchAt:
                  toIso(
                    (data.historicalSyncProgress as {
                      lastBatchAt?: number | string;
                    }).lastBatchAt ?? null,
                  ) ?? '',
                error: (data.historicalSyncProgress as { error?: string }).error,
              }
            : null,
          historicalSyncCompletedAt: toIso(
            data.historicalSyncCompletedAt ?? null,
          ),
          lastSyncAt: toIso(data.lastSyncAt ?? null),
        } satisfies SyncStatusData,
      }
    : undefined;
  return {
    data: shaped,
    isLoading: accountId ? data === undefined : false,
  };
}

/**
 * Aggregate historical-sync state across all the user's accounts. Powers the
 * global "Importing N / ~M…" pill in the thread list and the
 * "still indexing contacts" footer in compose autocomplete.
 */
export function useAnyHistoricalSyncInProgress() {
  const { isAuthenticated } = useConvexAuth();
  const data = useQuery(
    api.mailAccounts.anyHistoricalSync,
    isAuthenticated ? {} : 'skip',
  );
  return {
    inProgress: data?.inProgress ?? false,
    syncedThreads: data?.syncedThreads ?? 0,
    totalThreads: data?.totalThreads ?? 0,
    accountEmail: data?.accountEmail ?? null,
    contactBackfillInProgress: data?.contactBackfillInProgress ?? false,
    isLoading: data === undefined && isAuthenticated,
  };
}

export function useStartContactBackfill() {
  const fn = useMutation(api.contacts.startContactBackfill);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (accountId: string) => {
    setIsPending(true);
    try {
      return await fn({ accountId: accountId as Id<'mailAccounts'> });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useStartHistoricalSync() {
  const fn = useMutation(api.mailAccounts.triggerHistoricalSync);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (accountId: string) => {
    setIsPending(true);
    try {
      return await fn({ accountId: accountId as Id<'mailAccounts'> });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}
