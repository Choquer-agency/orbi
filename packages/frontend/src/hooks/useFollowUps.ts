import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface FollowUpWatch {
  id: string;
  threadId: string;
  emailId: string;
  contactEmail: string;
  intervals: number[];
  currentStep: number;
  nextCheckAt: string;
  status: string;
  thread?: { subject: string; snippet: string };
  events?: FollowUpEvent[];
}

interface FollowUpEvent {
  id: string;
  type: string;
  draftBody: string | null;
  draftTone: string | null;
  createdAt: string;
}

export function useFollowUps(status?: string) {
  return useQuery({
    queryKey: ['follow-ups', status],
    queryFn: () =>
      api.get<{ data: FollowUpWatch[] }>(
        `/follow-ups${status ? `?status=${status}` : ''}`,
      ),
    select: (res) => res.data,
  });
}

export function useFollowUp(id: string | undefined) {
  return useQuery({
    queryKey: ['follow-up', id],
    queryFn: () => api.get<{ data: FollowUpWatch }>(`/follow-ups/${id}`),
    select: (res) => res.data,
    enabled: !!id,
  });
}

export function useCreateFollowUp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      threadId: string;
      emailId: string;
      contactEmail: string;
      intervals?: number[];
    }) => api.post<{ data: FollowUpWatch }>('/follow-ups', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['follow-ups'] });
    },
  });
}

export function useCancelFollowUp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/follow-ups/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['follow-ups'] });
    },
  });
}

export function useSendFollowUp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ watchId, eventId }: { watchId: string; eventId: string }) =>
      api.post(`/follow-ups/${watchId}/send`, { eventId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['follow-ups'] });
    },
  });
}
