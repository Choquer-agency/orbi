import { useEffect, useRef, useState } from 'react';
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

  // Reset pageCount when the underlying query identity changes (folder, search,
  // account, etc.) so a fresh filter doesn't carry over a huge limit from the
  // previous one.
  const filterKey = JSON.stringify({
    accountId: params.accountId,
    folder: params.folder,
    isArchived: params.isArchived,
    search: params.search,
    from: params.from,
    category: params.category,
  });
  const prevFilterKey = useRef(filterKey);
  useEffect(() => {
    if (prevFilterKey.current !== filterKey) {
      prevFilterKey.current = filterKey;
      setPageCount(1);
    }
  }, [filterKey]);

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

  // Keep the last result around so the list doesn't blank out while a larger
  // page is being fetched. We only reset this when the filter identity
  // changes — paginating to a bigger limit on the same query should never
  // hide the rows we already have.
  const lastResultRef = useRef<ThreadListResponse | undefined>(undefined);
  const lastFilterKeyRef = useRef(filterKey);
  if (lastFilterKeyRef.current !== filterKey) {
    lastFilterKeyRef.current = filterKey;
    lastResultRef.current = undefined;
  }
  if (result !== undefined) {
    lastResultRef.current = result;
  }
  const displayResult = result ?? lastResultRef.current;

  const isLoading = displayResult === undefined;
  // We're fetching the next page when pagination has been requested
  // (pageCount > 1) but the new (larger) subscription hasn't returned yet.
  const isFetchingNextPage =
    pageCount > 1 && result === undefined && lastResultRef.current !== undefined;
  const pages: ThreadListResponse[] = displayResult ? [displayResult] : [];
  // Trust the server's hasMore, BUT — if the server returned fewer rows than
  // we asked for, the request hit a server-side cap (or there genuinely aren't
  // more rows). Either way, growing pageCount further won't help, so we must
  // report hasNextPage=false to stop the IntersectionObserver from looping.
  const requestedRows = limit * pageCount;
  const returnedRows = displayResult?.data.length ?? 0;
  const hasNextPage = (displayResult?.hasMore ?? false) && returnedRows >= requestedRows;

  return {
    data: displayResult ? { pages, pageParams: [1] } : undefined,
    isLoading,
    isFetching: result === undefined,
    isError: false,
    error: undefined,
    fetchNextPage: async () => {
      if (hasNextPage) setPageCount((c) => c + 1);
    },
    hasNextPage,
    isFetchingNextPage,
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
