import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

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

export function useHistoricalSyncStatus(accountId: string | null) {
  return useQuery({
    queryKey: ['sync-status', accountId],
    queryFn: () => api.get<{ data: SyncStatusData }>(`/accounts/${accountId}/sync-status`),
    enabled: !!accountId,
    refetchInterval: (query) => {
      const status = query.state.data?.data?.historicalSyncStatus;
      // Poll every 4s while in progress, otherwise don't auto-refetch
      return status === 'IN_PROGRESS' ? 4000 : false;
    },
  });
}

export function useStartHistoricalSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => api.post(`/accounts/${accountId}/historical-sync`),
    onSuccess: (_data, accountId) => {
      queryClient.invalidateQueries({ queryKey: ['sync-status', accountId] });
    },
  });
}
