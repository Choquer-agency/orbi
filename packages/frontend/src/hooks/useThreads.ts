import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

// ─────────────────────────────────────────────────────────────────────────────
// Drop-in TanStack Query → Convex replacement.
//
// Public surface preserved:
//   useThreads(params)              — was useInfiniteQuery; now exposes a
//                                     compatible `{ data: { pages, ... }, isLoading,
//                                     fetchNextPage, hasNextPage, isFetchingNextPage }`.
//   useThread(threadId)             — { data, isLoading }
//   useUpdateThread()               — { mutate, mutateAsync, isPending }
//   useSnoozeThread()               — { mutate, mutateAsync, isPending }
//   useUnsnoozeThread()             — { mutate, mutateAsync, isPending }
//   useSharedThreads()              — { data, isLoading }
// ─────────────────────────────────────────────────────────────────────────────

interface ThreadListParams {
  accountId?: Id<'mailAccounts'>;
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

// Convex queries don't paginate the way useInfiniteQuery does — we issue one
// query for the requested "page size" and let the page count grow with
// fetchNextPage(). The shape mirrors `data.pages: ThreadListResponse[]` so
// existing components that loop over `pages` keep working.
export function useThreads(params: ThreadListParams = {}) {
  const [pageCount, setPageCount] = useState(1);
  const limit = params.search || params.from ? 20 : 50;

  // Single combined query — request `pageCount * limit` rows up-front. The
  // server returns a single page with `hasMore`, and we expose it as a
  // synthetic `pages` array so consumers that map over `data.pages` work.
  const queryArgs = {
    ...(params.accountId ? { accountId: params.accountId } : {}),
    ...(params.folder ? { folder: params.folder } : {}),
    ...(params.isArchived !== undefined ? { isArchived: params.isArchived } : {}),
    ...(params.search ? { search: params.search } : {}),
    ...(params.from ? { from: params.from } : {}),
    ...(params.category ? { category: params.category } : {}),
    page: 1,
    limit: limit * pageCount,
  };

  const result = useQuery(api.threads.list, queryArgs) as
    | ThreadListResponse
    | undefined;

  const isLoading = result === undefined;
  const pages: ThreadListResponse[] = result ? [result] : [];
  const hasNextPage = result?.hasMore ?? false;

  return {
    data: result ? { pages, pageParams: [1] } : undefined,
    isLoading,
    isFetching: isLoading,
    isError: false,
    error: undefined,
    fetchNextPage: async () => {
      if (hasNextPage) setPageCount((c) => c + 1);
    },
    hasNextPage,
    isFetchingNextPage: false,
    refetch: async () => {
      // Convex auto-refreshes; expose for callers that still call it.
    },
  };
}

export function useThread(threadId: Id<'threads'> | string | null) {
  const result = useQuery(
    api.threads.get,
    threadId ? { threadId: threadId as Id<'threads'> } : 'skip',
  );
  return {
    data: result,
    isLoading: threadId !== null && result === undefined,
    isError: false,
    error: undefined,
  };
}

export function useUpdateThread() {
  const fn = useMutation(api.threads.update);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (args: {
    id: Id<'threads'> | string;
    isRead?: boolean;
    isStarred?: boolean;
    isArchived?: boolean;
    isTrashed?: boolean;
    labels?: string[];
  }) => {
    setIsPending(true);
    try {
      const { id, ...rest } = args;
      return await fn({ threadId: id as Id<'threads'>, ...rest });
    } finally {
      setIsPending(false);
    }
  };

  return {
    mutate: (args: Parameters<typeof mutateAsync>[0]) => {
      void mutateAsync(args);
    },
    mutateAsync,
    isPending,
    isLoading: isPending,
  };
}

export function useSnoozeThread() {
  const fn = useMutation(api.threads.snooze);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (args: {
    id: Id<'threads'> | string;
    snoozedUntil: string | number;
  }) => {
    setIsPending(true);
    try {
      const ts =
        typeof args.snoozedUntil === 'number'
          ? args.snoozedUntil
          : Date.parse(args.snoozedUntil);
      return await fn({
        threadId: args.id as Id<'threads'>,
        snoozedUntil: ts,
      });
    } finally {
      setIsPending(false);
    }
  };

  return {
    mutate: (args: Parameters<typeof mutateAsync>[0]) => {
      void mutateAsync(args);
    },
    mutateAsync,
    isPending,
    isLoading: isPending,
  };
}

export function useUnsnoozeThread() {
  const fn = useMutation(api.threads.unsnoozeNow);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (id: Id<'threads'> | string) => {
    setIsPending(true);
    try {
      return await fn({ threadId: id as Id<'threads'> });
    } finally {
      setIsPending(false);
    }
  };

  return {
    mutate: (id: Id<'threads'> | string) => {
      void mutateAsync(id);
    },
    mutateAsync,
    isPending,
    isLoading: isPending,
  };
}

export function useSharedThreads() {
  const result = useQuery(api.threads.listShared, {});
  return {
    data: result,
    isLoading: result === undefined,
    isError: false,
    error: undefined,
  };
}
