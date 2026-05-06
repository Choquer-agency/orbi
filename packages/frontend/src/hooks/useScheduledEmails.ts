import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface ScheduledEmail {
  id: string;
  userId: string;
  accountId: string;
  threadId: string | null;
  parentEmailId: string | null;
  mode: string;
  toAddresses: { email: string; name?: string }[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  sendAt: string;
  status: string;
  cancelledAt: string | null;
  createdAt: string;
  account?: { email: string; displayName: string | null };
}

export function useScheduledEmails(status?: string) {
  return useQuery({
    queryKey: ['scheduled-emails', status],
    queryFn: () =>
      api.get<{ data: ScheduledEmail[] }>(
        `/scheduled-emails${status ? `?status=${status}` : ''}`,
      ),
    select: (res) => res.data,
  });
}

export function useThreadScheduledEmails(threadId: string | null | undefined) {
  const { data: all } = useScheduledEmails();
  if (!threadId || !all) return [];
  return all.filter(
    (e) => e.threadId === threadId && (e.status === 'SCHEDULED' || e.status === 'SENDING'),
  );
}

export function useCreateScheduledEmail() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      accountId: string;
      threadId?: string;
      parentEmailId?: string;
      mode?: string;
      to: { email: string; name?: string }[];
      cc?: { email: string; name?: string }[];
      bcc?: { email: string; name?: string }[];
      subject: string;
      bodyHtml: string;
      bodyText: string;
      sendAt: string;
    }) => api.post<{ data: ScheduledEmail }>('/scheduled-emails', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-emails'] });
    },
  });
}

export function useCancelScheduledEmail() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/scheduled-emails/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-emails'] });
    },
  });
}

export function useUpdateScheduledEmail() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Record<string, any>) =>
      api.patch(`/scheduled-emails/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-emails'] });
    },
  });
}

export function useSendScheduledNow() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, undoWindowSeconds }: { id: string; undoWindowSeconds?: number }) =>
      api.post<{ data: { id: string; threadId: string; undoDeadlineAt: string | null } }>(
        `/scheduled-emails/${id}/send-now`,
        undoWindowSeconds ? { undoWindowSeconds } : undefined,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled-emails'] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });
}
