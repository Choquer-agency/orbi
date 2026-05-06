import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface BlockedSender {
  id: string;
  emailAddress: string | null;
  domain: string | null;
  reason: string | null;
  createdAt: string;
}

export function useBlockedSenders() {
  return useQuery({
    queryKey: ['blocked-senders'],
    queryFn: () => api.get<{ data: BlockedSender[] }>('/blocked-senders'),
    select: (res) => res.data,
  });
}

export function useBlockSender() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { emailAddress?: string; domain?: string; reason?: string }) =>
      api.post('/blocked-senders', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blocked-senders'] });
    },
  });
}

export function useUnblockSender() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/blocked-senders/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blocked-senders'] });
    },
  });
}
