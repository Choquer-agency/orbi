import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

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

// ─── Metrics ──────────────────────────────────────────────────

export function useDashboardMetrics() {
  const data = useQuery(api.dashboard.metrics, {});
  return {
    data: data as DashboardMetrics | undefined,
    isLoading: data === undefined,
  };
}

// ─── Needs Reply ──────────────────────────────────────────────

export function useNeedsReply() {
  const data = useQuery(api.dashboard.needsReply, {});
  const shaped = data
    ? (data as Array<{
        contactEmail: string;
        contactName: string | null;
        threadId: string;
        threadSubject: string;
        waitingHours: number;
        lastMessageAt: number;
      }>).map((r): NeedsReplyItem => ({
        contactEmail: r.contactEmail,
        contactName: r.contactName,
        threadId: r.threadId,
        threadSubject: r.threadSubject,
        waitingHours: r.waitingHours,
        lastMessageAt: new Date(r.lastMessageAt).toISOString(),
      }))
    : undefined;
  return {
    data: shaped ? { data: shaped } : undefined,
    isLoading: data === undefined,
  };
}

// ─── Tasks ────────────────────────────────────────────────────

function shapeTask(t: {
  _id: string;
  threadId: string;
  description: string;
  contactEmail?: string | null;
  contactName?: string | null;
  taskType: Task['taskType'];
  deadline?: number | null;
  status: Task['status'];
  resolvedAt?: number | null;
  resolvedBy?: string | null;
  _creationTime: number;
  thread?: { subject: string } | null;
}): Task {
  return {
    id: t._id,
    threadId: t.threadId,
    description: t.description,
    contactEmail: t.contactEmail ?? null,
    contactName: t.contactName ?? null,
    taskType: t.taskType,
    deadline: t.deadline ? new Date(t.deadline).toISOString() : null,
    status: t.status,
    resolvedAt: t.resolvedAt ? new Date(t.resolvedAt).toISOString() : null,
    resolvedBy: t.resolvedBy ?? null,
    createdAt: new Date(t._creationTime).toISOString(),
    thread: { subject: t.thread?.subject ?? '' },
  };
}

export function useDashboardTasks(status: 'open' | 'done' | 'all' = 'open') {
  const result = useQuery(api.dashboard.taskList, { status });
  const shaped = result
    ? {
        data: (result.data as Array<Parameters<typeof shapeTask>[0]>).map(
          shapeTask,
        ),
        total: result.total,
        hasMore: result.hasMore,
      }
    : undefined;
  return {
    data: shaped,
    isLoading: result === undefined,
  };
}

export function useToggleTask() {
  const fn = useMutation(api.tasks.markDone);
  const [isPending, setIsPending] = useState(false);
  const mutate = async ({
    id,
    status,
  }: {
    id: string;
    status: 'DONE' | 'OPEN';
  }) => {
    setIsPending(true);
    try {
      return await fn({
        id: id as Id<'tasks'>,
        status,
      });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

// ─── Pending Comments ─────────────────────────────────────────

export function usePendingComments() {
  const data = useQuery(api.dashboard.pendingComments, {});
  const shaped = data
    ? (data as Array<{
        _id: string;
        bodyText: string;
        bodyHtml: string;
        _creationTime: number;
        author: { id: string; name: string | null; avatarUrl: string | null } | null;
        thread: { id: string; subject: string } | null;
      }>).map((c): PendingComment => ({
        id: c._id,
        bodyText: c.bodyText,
        bodyHtml: c.bodyHtml,
        createdAt: new Date(c._creationTime).toISOString(),
        author: {
          id: c.author?.id ?? '',
          name: c.author?.name ?? '',
          avatarUrl: c.author?.avatarUrl ?? null,
        },
        thread: {
          id: c.thread?.id ?? '',
          subject: c.thread?.subject ?? '',
        },
      }))
    : undefined;
  return {
    data: shaped ? { data: shaped } : undefined,
    isLoading: data === undefined,
  };
}
