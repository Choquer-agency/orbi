import { useState } from 'react';
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

function shapeNotification(n: any) {
  return {
    id: n._id ?? n.id,
    userId: n.userId,
    type: n.type,
    title: n.title,
    body: n.body ?? null,
    data: n.data ?? null,
    isRead: n.isRead,
    createdAt: n._creationTime ?? n.createdAt,
  };
}

export function useNotifications() {
  const { isAuthenticated } = useConvexAuth();
  const result = useQuery(api.notifications.list, isAuthenticated ? {} : 'skip');
  if (result === undefined) {
    return { data: undefined, isLoading: true };
  }
  return {
    data: {
      data: result.data.map(shapeNotification),
      total: result.total,
      unreadCount: result.unreadCount,
      page: result.page,
      limit: result.limit,
      hasMore: result.hasMore,
    },
    isLoading: false,
  };
}

export function useUnreadCount() {
  const { isAuthenticated } = useConvexAuth();
  const result = useQuery(api.notifications.unreadCount, isAuthenticated ? {} : 'skip');
  if (result === undefined) {
    return { data: undefined, isLoading: true };
  }
  // Preserve `{ data: { count } }` shape so consumers can do `unreadData?.data?.count`.
  return { data: { data: { count: result.count } }, isLoading: false };
}

export function useMarkAsRead() {
  const fn = useMutation(api.notifications.markRead);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    id: string,
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const result = await fn({ id: id as Id<'notifications'> });
      opts?.onSuccess?.(result);
      return result;
    } catch (err) {
      opts?.onError?.(err);
      throw err;
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useMarkAllRead() {
  const fn = useMutation(api.notifications.markAllRead);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    _?: void,
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const result = await fn({});
      opts?.onSuccess?.(result);
      return result;
    } catch (err) {
      opts?.onError?.(err);
      throw err;
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}
