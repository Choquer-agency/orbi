import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface Handoff {
  id: string;
  threadId: string;
  fromUserId: string;
  toUserId: string;
  note: string | null;
  transferSla: boolean;
  transferFollowUps: boolean;
  status: string;
  acceptedAt: string | null;
  createdAt: string;
  thread?: { id: string; subject: string; snippet: string; lastMessageAt: string };
  fromUser?: { id: string; name: string; avatarUrl: string | null };
}

export function useHandoffs(status?: string) {
  return useQuery({
    queryKey: ['handoffs', status],
    queryFn: () =>
      api.get<{ data: Handoff[] }>(
        `/handoffs${status ? `?status=${status}` : ''}`,
      ),
    select: (res) => res.data,
  });
}

export function useCreateHandoff() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      threadId,
      toUserId,
      note,
      transferSla,
      transferFollowUps,
    }: {
      threadId: string;
      toUserId: string;
      note?: string;
      transferSla?: boolean;
      transferFollowUps?: boolean;
    }) =>
      api.post(`/threads/${threadId}/handoff`, {
        toUserId,
        note,
        transferSla,
        transferFollowUps,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['handoffs'] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });
}

export function useRespondToHandoff() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'accept' | 'decline' }) =>
      api.patch(`/handoffs/${id}`, { action }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['handoffs'] });
    },
  });
}

export function useReturnHandoff() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.post(`/handoffs/${id}/return`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['handoffs'] });
    },
  });
}
