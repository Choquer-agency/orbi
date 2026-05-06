import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface InboxSplit {
  id: string;
  category: string;
  label: string;
  position: number;
  isEnabled: boolean;
}

export function useInboxSplits() {
  return useQuery({
    queryKey: ['inbox-splits'],
    queryFn: () => api.get<{ data: InboxSplit[] }>('/settings/inbox-splits'),
    select: (res) => res.data,
  });
}

export function useUpdateInboxSplits() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (splits: { category: string; label: string; position: number; isEnabled: boolean }[]) =>
      api.put('/settings/inbox-splits', splits),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox-splits'] });
    },
  });
}
