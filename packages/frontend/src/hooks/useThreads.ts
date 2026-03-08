import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface ThreadListParams {
  accountId?: string;
  isArchived?: boolean;
  page?: number;
  limit?: number;
}

export function useThreads(params: ThreadListParams = {}) {
  const query = new URLSearchParams();
  if (params.accountId) query.set('accountId', params.accountId);
  if (params.isArchived !== undefined) query.set('isArchived', String(params.isArchived));
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));

  return useQuery({
    queryKey: ['threads', params],
    queryFn: () => api.get<any>(`/threads?${query.toString()}`),
  });
}

export function useThread(threadId: string | null) {
  return useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api.get<any>(`/threads/${threadId}`),
    enabled: !!threadId,
  });
}

export function useUpdateThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [key: string]: any }) =>
      api.patch(`/threads/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });
}

export function useSharedThreads() {
  return useQuery({
    queryKey: ['threads', 'shared'],
    queryFn: () => api.get<any>('/threads/shared'),
  });
}
