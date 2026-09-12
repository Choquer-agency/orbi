// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMailboxSearch } from './useMailboxSearch';
import type { Id } from '../../../../convex/_generated/dataModel';

const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('convex/react', () => ({
  useAction: () => search,
  useQuery: (_api: unknown, args: 'skip' | { emailIds: string[] }) =>
    args === 'skip' ? undefined : args.emailIds.map((id) => ({ id })),
}));
const result = (ids: string[], next = false) => ({
  imported: ids.length,
  matched: ids.length,
  emailIds: ids,
  nextCursors: next ? [{ accountId: 'account-a', cursor: 'page-2' }] : [],
  failedAccounts: 0,
  searchedAccounts: 1,
});
const settleTyping = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(301);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  search.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('mailbox search lifecycle', () => {
  it('debounces provider requests while a person name is being typed', async () => {
    search.mockResolvedValue(result(['mike']));
    const hook = renderHook(({ query }) => useMailboxSearch(query), {
      initialProps: { query: 'Mi' },
    });
    hook.rerender({ query: 'Mike Nunn' });
    await settleTyping();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'Mike Nunn' }));
    expect(hook.result.current.data?.pages[0].data).toEqual([{ id: 'mike' }]);
  });
  it('ignores a previous query that finishes after the current query', async () => {
    let finishOld!: (value: ReturnType<typeof result>) => void;
    search
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce(result(['rick']));
    const hook = renderHook(({ query }) => useMailboxSearch(query), {
      initialProps: { query: 'Mike' },
    });
    await settleTyping();
    hook.rerender({ query: 'Rick' });
    await settleTyping();
    await act(async () => {
      finishOld(result(['mike']));
    });
    expect(hook.result.current.data?.pages[0].data).toEqual([{ id: 'rick' }]);
  });
  it('never carries another account’s results into a new scope', async () => {
    search
      .mockResolvedValueOnce(result(['account-a-email']))
      .mockResolvedValueOnce(result(['account-b-email']));
    const hook = renderHook(
      ({ account }) => useMailboxSearch('Mike', account as Id<'mailAccounts'>),
      { initialProps: { account: 'account-a' } },
    );
    await settleTyping();
    hook.rerender({ account: 'account-b' });
    expect(hook.result.current.data?.pages[0].data).toEqual([]);
    await settleTyping();
    expect(hook.result.current.data?.pages[0].data).toEqual([{ id: 'account-b-email' }]);
  });
  it('loads provider cursors and deduplicates overlapping message IDs', async () => {
    search
      .mockResolvedValueOnce(result(['one'], true))
      .mockResolvedValueOnce(result(['one', 'two']));
    const hook = renderHook(() => useMailboxSearch('Mike'));
    await settleTyping();
    await act(async () => {
      await hook.result.current.fetchNextPage();
    });
    expect(search.mock.calls[1][0].cursors).toEqual([{ accountId: 'account-a', cursor: 'page-2' }]);
    expect(hook.result.current.data?.pages[0].data).toEqual([{ id: 'one' }, { id: 'two' }]);
    expect(hook.result.current.hasNextPage).toBe(false);
  });
  it('reports a failed provider search as incomplete and allows retry', async () => {
    search.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(result(['recovered']));
    const hook = renderHook(() => useMailboxSearch('Mike'));
    await settleTyping();
    expect(hook.result.current.partial).toBe(true);
    await act(async () => {
      await hook.result.current.refetch();
    });
    expect(hook.result.current.partial).toBe(false);
    expect(hook.result.current.data?.pages[0].data).toEqual([{ id: 'recovered' }]);
  });
  it('does not search the viewer’s provider when browsing a teammate', async () => {
    renderHook(() => useMailboxSearch('Mike', undefined, false));
    await settleTyping();
    expect(search).not.toHaveBeenCalled();
  });
});
