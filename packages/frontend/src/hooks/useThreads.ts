import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useConvex, useAction } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  getCachedPageSync,
  loadCachedPage,
  saveCachedPage,
} from '../lib/threadListCache';
import {
  getCachedThreadSync,
  loadCachedThread,
  saveCachedThread,
} from '../lib/threadBodyCache';

// Convex Ids are opaque base32-ish strings. Stale values like "current" or
// other model-emitted placeholders sometimes leak into selectedThreadId via
// persisted UI state, so guard query callers before hitting Convex.
function isLikelyConvexId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{20,}$/i.test(value);
}

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

// Keep the old infinite-query-like public shape, but fetch one bounded page at
// a time instead of increasing `limit` and re-requesting everything from page 1.
export function useThreads(params: ThreadListParams = {}) {
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState<ThreadListResponse[]>([]);
  // Larger initial window so you can scroll for a while before another fetch.
  const limit = params.search || params.from ? 40 : 80;

  const paramsKey = useMemo(
    () => JSON.stringify({
      accountId: params.accountId ?? null,
      folder: params.folder ?? null,
      isArchived: params.isArchived ?? null,
      search: params.search ?? null,
      from: params.from ?? null,
      category: params.category ?? null,
      limit,
    }),
    [
      params.accountId,
      params.folder,
      params.isArchived,
      params.search,
      params.from,
      params.category,
      limit,
    ],
  );

  // Initialise from the local snapshot cache (Spark-style "render disk first").
  // Only page-1 of each view is cached; subsequent pages are always live.
  const [cachedPage1, setCachedPage1] = useState<ThreadListResponse | null>(
    () => getCachedPageSync<ThreadListResponse>(paramsKey) ?? null,
  );
  const lastParamsKey = useRef(paramsKey);
  // Holds the previously-rendered live pages while a new view's data is
  // loading. Prevents the visible "flash to cached → flash to live" shuffle
  // when the user changes filter/split/folder.
  const [stalePages, setStalePages] = useState<ThreadListResponse[] | null>(null);

  useEffect(() => {
    // Snapshot the current pages so we can keep them on screen until the new
    // view resolves. Then reset paging state.
    setStalePages((prev) => (pages.length > 0 ? pages : prev));
    setPage(1);
    setPages([]);
    const inMem = getCachedPageSync<ThreadListResponse>(paramsKey);
    setCachedPage1(inMem ?? null);
    lastParamsKey.current = paramsKey;
    if (!inMem) {
      void loadCachedPage<ThreadListResponse>(paramsKey).then((p) => {
        if (p && lastParamsKey.current === paramsKey) {
          setCachedPage1((prev) => prev ?? p);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramsKey]);

  const queryArgs = useMemo(
    () => ({
      ...(params.accountId ? { accountId: params.accountId } : {}),
      ...(params.folder ? { folder: params.folder } : {}),
      ...(params.isArchived !== undefined ? { isArchived: params.isArchived } : {}),
      ...(params.search ? { search: params.search } : {}),
      ...(params.from ? { from: params.from } : {}),
      ...(params.category ? { category: params.category } : {}),
      page,
      limit,
    }),
    [
      params.accountId,
      params.folder,
      params.isArchived,
      params.search,
      params.from,
      params.category,
      page,
      limit,
    ],
  );

  const result = useQuery(api.threads.list, queryArgs) as
    | ThreadListResponse
    | undefined;

  useEffect(() => {
    if (!result) return;
    setPages((prev) => {
      const next = [...prev];
      next[result.page - 1] = result;
      return next.filter(Boolean);
    });
    if (result.page === 1) {
      // Persist page-1 of each view for next cold start.
      saveCachedPage<ThreadListResponse>(paramsKey, result);
      setCachedPage1(result);
      setStalePages(null);
    }
  }, [result, paramsKey]);

  // Visible pages: prefer live; otherwise the most-recent previous view's
  // pages (so filter switches feel instant); otherwise the cached snapshot.
  const livePages = pages.length > 0 ? pages : result ? [result] : [];
  const visiblePages =
    livePages.length > 0
      ? livePages
      : stalePages && stalePages.length > 0
        ? stalePages
        : cachedPage1
          ? [cachedPage1]
          : [];
  const latestPage = result ?? livePages.at(-1) ?? cachedPage1 ?? undefined;
  const hasLive = livePages.length > 0;
  const isLoading = !hasLive && !cachedPage1 && !stalePages;
  const isFetchingNextPage = result === undefined && hasLive;
  const hasNextPage = latestPage?.hasMore ?? false;

  return {
    data: visiblePages.length > 0 ? { pages: visiblePages, pageParams: visiblePages.map((p) => p.page) } : undefined,
    isLoading,
    isFetching: isLoading || isFetchingNextPage,
    isError: false,
    error: undefined,
    fetchNextPage: async () => {
      if (hasNextPage && !isFetchingNextPage) setPage((current) => current + 1);
    },
    hasNextPage,
    isFetchingNextPage,
    refetch: async () => {
      setPages([]);
      setPage(1);
    },
  };
}

export function useThread(threadId: Id<'threads'> | string | null) {
  const validId = isLikelyConvexId(threadId) ? threadId : null;
  const result = useQuery(
    api.threads.get,
    validId ? { threadId: validId as Id<'threads'> } : 'skip',
  );

  // ── Local body cache (Spark/Gmail-style) ──────────────────────────────
  // Show the previously-fetched copy of this thread while Convex resolves.
  // The cache is updated whenever live data arrives so subsequent opens are
  // instant even across app restarts.
  const [cached, setCached] = useState<unknown | undefined>(() =>
    threadId ? getCachedThreadSync(threadId as string) : undefined,
  );
  const lastThreadId = useRef<string | null>(null);

  useEffect(() => {
    const id = threadId as string | null;
    if (id !== lastThreadId.current) {
      lastThreadId.current = id;
      if (!id) {
        setCached(undefined);
        return;
      }
      const sync = getCachedThreadSync(id);
      setCached(sync);
      if (sync === undefined) {
        void loadCachedThread(id).then((p) => {
          if (lastThreadId.current === id && p !== undefined) {
            setCached(p);
          }
        });
      }
    }
  }, [threadId]);

  useEffect(() => {
    if (result && threadId) {
      saveCachedThread(threadId as string, result);
    }
  }, [result, threadId]);

  // On-demand body loader. Incremental sync only pulls headers + snippet to
  // keep fetch egress low (see convex/sync/onDemandBody.ts); the body is
  // downloaded the first time we open the thread. Convex reactivity then
  // re-runs `api.threads.get` once the emailBodies row lands, so the viewer
  // updates without any imperative re-fetch on our side.
  const ensureEmailBody = useAction(api.sync.onDemandBody.ensureEmailBody);
  const inflight = useRef<Set<string>>(new Set());
  useEffect(() => {
    const emails = (result as { emails?: Array<{ id: string; bodyHtml?: string; bodyHtmlClean?: string; bodyHtmlTrimmed?: string; bodyText?: string }> } | undefined)?.emails;
    if (!emails || emails.length === 0) return;
    for (const e of emails) {
      const hasBody =
        !!(e.bodyHtmlClean && e.bodyHtmlClean.length > 0) ||
        !!(e.bodyHtmlTrimmed && e.bodyHtmlTrimmed.length > 0) ||
        !!(e.bodyHtml && e.bodyHtml.length > 0) ||
        !!(e.bodyText && e.bodyText.length > 0);
      if (hasBody) continue;
      if (inflight.current.has(e.id)) continue;
      inflight.current.add(e.id);
      void ensureEmailBody({ emailId: e.id as Id<'emails'> })
        .catch((err) => {
          console.warn('[useThread] on-demand body fetch failed', e.id, err);
        })
        .finally(() => {
          inflight.current.delete(e.id);
        });
    }
  }, [result, ensureEmailBody]);

  const data = (result ?? cached) as typeof result;
  return {
    data,
    isLoading: threadId !== null && result === undefined && cached === undefined,
    isError: false,
    error: undefined,
  };
}

/**
 * Spark/Gmail-style adjacency prefetch.
 *
 * Subscribes to extra `api.threads.get` queries so that pressing j/k or
 * clicking nearby threads renders synchronously. Pass `null` for any slot
 * to skip it. Each fetched thread is persisted to the local body cache so
 * cold opens stay fast across app restarts.
 *
 * Convention: pass the PREV thread + up to 3 forward threads. Forward is
 * weighted because users scroll down more often than up.
 */
export function usePrefetchAdjacentThreads(
  prevId: Id<'threads'> | string | null,
  nextId: Id<'threads'> | string | null,
  next2Id?: Id<'threads'> | string | null,
  next3Id?: Id<'threads'> | string | null,
) {
  const prev = useQuery(
    api.threads.get,
    prevId ? { threadId: prevId as Id<'threads'> } : 'skip',
  );
  const next = useQuery(
    api.threads.get,
    nextId ? { threadId: nextId as Id<'threads'> } : 'skip',
  );
  const next2 = useQuery(
    api.threads.get,
    next2Id ? { threadId: next2Id as Id<'threads'> } : 'skip',
  );
  const next3 = useQuery(
    api.threads.get,
    next3Id ? { threadId: next3Id as Id<'threads'> } : 'skip',
  );
  // Persist prefetched threads to disk so reopens are instant across
  // restarts. Skip the in-flight `undefined`; only save resolved data.
  useEffect(() => {
    if (prev && prevId) saveCachedThread(prevId as string, prev);
  }, [prev, prevId]);
  useEffect(() => {
    if (next && nextId) saveCachedThread(nextId as string, next);
  }, [next, nextId]);
  useEffect(() => {
    if (next2 && next2Id) saveCachedThread(next2Id as string, next2);
  }, [next2, next2Id]);
  useEffect(() => {
    if (next3 && next3Id) saveCachedThread(next3Id as string, next3);
  }, [next3, next3Id]);
}

/**
 * Inbox-open bootstrap: warm the body cache for the first N threads in the
 * current view so the user's first click is instant. Uses requestIdleCallback
 * so it doesn't compete with initial render; throttled to 8 threads to keep
 * Convex traffic modest.
 */
export function useThreadHoverPrefetch() {
  const convex = useConvex();
  const inFlight = useRef(new Set<string>());

  return useCallback((threadId: string | null | undefined) => {
    if (!threadId) return;
    if (getCachedThreadSync(threadId) !== undefined) return;
    if (inFlight.current.has(threadId)) return;
    inFlight.current.add(threadId);
    void convex
      .query(api.threads.get, { threadId: threadId as Id<'threads'> })
      .then((result) => {
        if (result) saveCachedThread(threadId, result);
      })
      .catch(() => {})
      .finally(() => {
        inFlight.current.delete(threadId);
      });
  }, [convex]);
}

export function useIdleThreadPrefetch(threadIds: string[], count = 8) {
  const [warm, setWarm] = useState<string[]>([]);
  useEffect(() => {
    if (threadIds.length === 0) {
      setWarm([]);
      return;
    }
    const ids = threadIds.slice(0, count);
    const ric =
      (window as any).requestIdleCallback ||
      ((cb: () => void) => window.setTimeout(cb, 400));
    const handle = ric(() => setWarm(ids));
    return () => {
      const cic =
        (window as any).cancelIdleCallback ||
        ((h: number) => window.clearTimeout(h));
      cic(handle);
    };
  }, [threadIds.join('|'), count]);

  // Subscribe to up to 8 threads; persist each to disk on resolve. We can't
  // call useQuery in a loop, so we hard-code slots.
  const id0 = warm[0] ?? null;
  const id1 = warm[1] ?? null;
  const id2 = warm[2] ?? null;
  const id3 = warm[3] ?? null;
  const id4 = warm[4] ?? null;
  const id5 = warm[5] ?? null;
  const id6 = warm[6] ?? null;
  const id7 = warm[7] ?? null;
  const t0 = useQuery(api.threads.get, id0 ? { threadId: id0 as Id<'threads'> } : 'skip');
  const t1 = useQuery(api.threads.get, id1 ? { threadId: id1 as Id<'threads'> } : 'skip');
  const t2 = useQuery(api.threads.get, id2 ? { threadId: id2 as Id<'threads'> } : 'skip');
  const t3 = useQuery(api.threads.get, id3 ? { threadId: id3 as Id<'threads'> } : 'skip');
  const t4 = useQuery(api.threads.get, id4 ? { threadId: id4 as Id<'threads'> } : 'skip');
  const t5 = useQuery(api.threads.get, id5 ? { threadId: id5 as Id<'threads'> } : 'skip');
  const t6 = useQuery(api.threads.get, id6 ? { threadId: id6 as Id<'threads'> } : 'skip');
  const t7 = useQuery(api.threads.get, id7 ? { threadId: id7 as Id<'threads'> } : 'skip');
  useEffect(() => { if (t0 && id0) saveCachedThread(id0, t0); }, [t0, id0]);
  useEffect(() => { if (t1 && id1) saveCachedThread(id1, t1); }, [t1, id1]);
  useEffect(() => { if (t2 && id2) saveCachedThread(id2, t2); }, [t2, id2]);
  useEffect(() => { if (t3 && id3) saveCachedThread(id3, t3); }, [t3, id3]);
  useEffect(() => { if (t4 && id4) saveCachedThread(id4, t4); }, [t4, id4]);
  useEffect(() => { if (t5 && id5) saveCachedThread(id5, t5); }, [t5, id5]);
  useEffect(() => { if (t6 && id6) saveCachedThread(id6, t6); }, [t6, id6]);
  useEffect(() => { if (t7 && id7) saveCachedThread(id7, t7); }, [t7, id7]);
}

export function useUpdateThread() {
  // Optimistic update: patch the Convex client cache before the server
  // confirms so archive/star/read toggles feel instant. Convex automatically
  // reconciles when the real result arrives.
  const fn = useMutation(api.threads.update).withOptimisticUpdate(
    (localStore, args) => {
      const { threadId, ...patch } = args as {
        threadId: Id<'threads'>;
        isRead?: boolean;
        isStarred?: boolean;
        isArchived?: boolean;
        isTrashed?: boolean;
        labels?: string[];
      };
      // Patch the single-thread query.
      const single = localStore.getQuery(api.threads.get, { threadId });
      if (single) {
        localStore.setQuery(api.threads.get, { threadId }, { ...single, ...patch });
      }
      // Patch every thread-list query that has this thread.
      for (const q of localStore.getAllQueries(api.threads.list)) {
        if (!q.value) continue;
        const list = q.value as { data: Array<{ id: string }> };
        if (!list.data?.some?.((t) => t.id === threadId)) continue;
        const nextData = list.data.map((t) =>
          t.id === threadId ? ({ ...t, ...patch } as typeof t) : t,
        );
        // If archived/trashed and the current view isn't archived/trash,
        // drop the row from this list so the UI matches the eventual server
        // state immediately.
        const drop =
          (patch.isArchived === true && q.args?.isArchived !== true) ||
          (patch.isTrashed === true && q.args?.folder !== 'trash');
        localStore.setQuery(api.threads.list, q.args, {
          ...list,
          data: drop ? nextData.filter((t) => t.id !== threadId) : nextData,
        });
      }
    },
  );
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
