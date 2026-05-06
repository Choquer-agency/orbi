import { useQuery, useInfiniteQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '../lib/api';

interface ThreadListParams {
  accountId?: string;
  folder?: string;
  isArchived?: boolean;
  search?: string;
  from?: string;
  category?: string;
}

interface ThreadListResponse {
  data: any[];
  total: number;
  page: number;
  limit: number;
  hasMore: boolean;
}

export function useThreads(params: ThreadListParams = {}) {
  const buildQuery = (page: number) => {
    const query = new URLSearchParams();
    if (params.accountId) query.set('accountId', params.accountId);
    if (params.folder) query.set('folder', params.folder);
    if (params.isArchived !== undefined) query.set('isArchived', String(params.isArchived));
    if (params.search) query.set('search', params.search);
    if (params.from) query.set('from', params.from);
    if (params.category) query.set('category', params.category);
    query.set('page', String(page));
    query.set('limit', (params.search || params.from) ? '20' : '50');
    return query.toString();
  };

  return useInfiniteQuery<ThreadListResponse>({
    queryKey: ['threads', params],
    queryFn: ({ pageParam }) => api.get<ThreadListResponse>(`/threads?${buildQuery(pageParam as number)}`),
    initialPageParam: 1,
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.page + 1 : undefined,
  });
}

export function useThread(threadId: string | null) {
  return useQuery({
    queryKey: ['thread', threadId],
    queryFn: () => api.get<any>(`/threads/${threadId}`),
    enabled: !!threadId,
    placeholderData: keepPreviousData,
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

export function useSnoozeThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, snoozedUntil }: { id: string; snoozedUntil: string }) =>
      api.patch(`/threads/${id}/snooze`, { snoozedUntil }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });
}

export function useUnsnoozeThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/threads/${id}/snooze`),
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
