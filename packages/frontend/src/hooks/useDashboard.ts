import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface DashboardMetrics {
  averageMinutes: number;
  medianMinutes: number;
  totalReplies: number;
}

interface NeedsReplyItem {
  contactEmail: string;
  contactName: string | null;
  threadId: string;
  threadSubject: string;
  waitingHours: number;
  lastMessageAt: string;
}

interface Task {
  id: string;
  threadId: string;
  description: string;
  contactEmail: string | null;
  contactName: string | null;
  taskType: 'PROMISE' | 'DEADLINE' | 'CHANGE_REQUEST' | 'ACTION_ITEM';
  deadline: string | null;
  status: 'OPEN' | 'DONE' | 'AUTO_RESOLVED';
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  thread: { subject: string };
}

interface PendingComment {
  id: string;
  bodyText: string;
  bodyHtml: string;
  createdAt: string;
  author: { id: string; name: string; avatarUrl: string | null };
  thread: { id: string; subject: string };
}

export function useDashboardMetrics() {
  return useQuery({
    queryKey: ['dashboard', 'metrics'],
    queryFn: () => api.get<DashboardMetrics>('/dashboard/metrics'),
    staleTime: 5 * 60 * 1000,
  });
}

export function useNeedsReply() {
  return useQuery({
    queryKey: ['dashboard', 'needs-reply'],
    queryFn: () => api.get<{ data: NeedsReplyItem[] }>('/dashboard/needs-reply'),
  });
}

export function useDashboardTasks(status: 'open' | 'done' | 'all' = 'open') {
  return useQuery({
    queryKey: ['dashboard', 'tasks', status],
    queryFn: () => api.get<{ data: Task[]; total: number; hasMore: boolean }>(`/dashboard/tasks?status=${status}`),
  });
}

export function useToggleTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'DONE' | 'OPEN' }) =>
      api.patch(`/dashboard/tasks/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dashboard', 'tasks'] }),
  });
}

export function usePendingComments() {
  return useQuery({
    queryKey: ['dashboard', 'pending-comments'],
    queryFn: () => api.get<{ data: PendingComment[] }>('/dashboard/pending-comments'),
  });
}
