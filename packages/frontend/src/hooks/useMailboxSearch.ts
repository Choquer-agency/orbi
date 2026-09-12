import { useCallback, useEffect, useRef, useState } from 'react';
import { useAction, useQuery } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

type Cursor = { accountId: Id<'mailAccounts'>; cursor: string };
interface SearchState {
  key: string;
  emailIds: Id<'emails'>[];
  batchIds: Id<'emails'>[];
  revision: number;
  cursors: Cursor[];
  pending: boolean;
  failed: boolean;
  capped: boolean;
}
const empty = (key: string): SearchState => ({
  key,
  emailIds: [],
  batchIds: [],
  revision: 0,
  cursors: [],
  pending: false,
  failed: false,
  capped: false,
});

/** Provider search is keyed by query AND account; late responses cannot leak
 * into a new search. Keep matching IDs, not a second local text predicate. */
export function useMailboxSearch(query: string, accountId?: Id<'mailAccounts'>, enabled = true) {
  const search = useAction(api.searchProvider.searchViaProvider);
  const key = enabled && query ? JSON.stringify([query, accountId ?? null]) : '';
  const [state, setState] = useState<SearchState>(() => empty(''));
  const currentKey = useRef(key);
  currentKey.current = key;
  const generation = useRef(0);
  const busy = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const run = useCallback(
    async (append: boolean) => {
      if (!key || (append && busy.current)) return;
      const request = ++generation.current;
      busy.current = true;
      const previous = stateRef.current.key === key ? stateRef.current : empty(key);
      const revision = append ? previous.revision : request;
      setState({ ...(append ? previous : empty(key)), revision, pending: true });
      try {
        const result = await search({
          query,
          ...(accountId ? { accountId } : {}),
          maxResults: 50,
          ...(append ? { cursors: previous.cursors } : {}),
        });
        if (request !== generation.current || key !== currentKey.current) return;
        const ids = [...new Set([...(append ? previous.emailIds : []), ...result.emailIds])];
        setState({
          key,
          revision,
          emailIds: ids.slice(0, 2000),
          batchIds: result.emailIds.filter((id) => ids.indexOf(id) < 2000),
          cursors: result.nextCursors,
          pending: false,
          failed:
            (append && previous.failed) ||
            result.failedAccounts > 0 ||
            result.searchedAccounts === 0,
          capped: ids.length > 2000 || (ids.length === 2000 && result.nextCursors.length > 0),
        });
      } catch {
        if (request === generation.current && key === currentKey.current)
          setState({ ...previous, pending: false, failed: true });
      } finally {
        if (request === generation.current) busy.current = false;
      }
    },
    [key, query, accountId, search],
  );

  const invalidate = useCallback(() => {
    ++generation.current;
    busy.current = false;
  }, []);

  useEffect(() => {
    if (!key) {
      ++generation.current;
      busy.current = false;
      setState(empty(''));
      return;
    }
    // Local suggestions react immediately; wait for typing to settle before
    // making provider requests. Cleanup also invalidates requests on unmount.
    const timer = setTimeout(() => {
      void run(false);
    }, 300);
    return () => {
      clearTimeout(timer);
      invalidate();
    };
  }, [key, run, invalidate]);

  const active = state.key === key ? state : empty(key);
  const rows = useQuery(
    api.searchProviderData.results,
    key && active.batchIds.length ? { emailIds: active.batchIds } : 'skip',
  );
  const lastRows = useRef<{
    key: string;
    pages: Map<string, NonNullable<typeof rows>>;
    rows: NonNullable<typeof rows>;
  }>({ key: '', pages: new Map(), rows: [] });
  const rowsKey = `${key}:${active.revision}`;
  if (rows !== undefined) {
    const pages =
      lastRows.current.key === rowsKey
        ? lastRows.current.pages
        : new Map<string, NonNullable<typeof rows>>();
    // Replace this batch, including removals (e.g. a result just trashed).
    pages.set(active.batchIds.join(','), rows);
    const merged = new Map([...pages.values()].flat().map((row) => [row.id, row]));
    lastRows.current = {
      key: rowsKey,
      pages,
      rows: [...merged.values()].sort((a, b) => b.lastReceivedAt - a.lastReceivedAt),
    };
  }
  const visibleRows = lastRows.current.key === rowsKey ? lastRows.current.rows : [];
  const pending =
    !!key &&
    (state.key !== key || active.pending || (active.batchIds.length > 0 && rows === undefined));
  const hasMore = active.cursors.length > 0 && !active.capped;
  return {
    data: key
      ? {
          pages: [{ data: visibleRows, total: visibleRows.length, page: 1, limit: 50, hasMore }],
          pageParams: [1],
        }
      : undefined,
    isLoading: pending && !visibleRows.length,
    isFetching: pending,
    isFetchingNextPage: pending && !!visibleRows.length,
    isError: false,
    partial: active.failed,
    capped: active.capped,
    hasNextPage: hasMore,
    fetchNextPage: async () => {
      if (hasMore && !pending && !active.failed) await run(true);
    },
    refetch: async () => {
      await run(false);
    },
  };
}
