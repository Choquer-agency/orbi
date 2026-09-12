// @vitest-environment jsdom
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getFunctionName } from 'convex/server';
import { ClientsList } from './ClientsList';
import { NoReplyNeeded } from './NoReplyNeeded';
import { useUiStore } from '../../stores/uiStore';

const mock = vi.hoisted(() => ({
  state: {} as any, listeners: new Set<() => void>(), refresh: vi.fn(), error: vi.fn(),
  reject: (_error: Error) => {},
}));
function snapshot() { return useSyncExternalStore(fn => { mock.listeners.add(fn); return () => mock.listeners.delete(fn); }, () => mock.state); }
function emit() { for (const listener of mock.listeners) listener(); }
vi.mock('convex/react', () => ({
  useAction: () => mock.refresh,
  useQuery: (ref: any) => { const state = snapshot(); return getFunctionName(ref) === 'clients:status' ? state.sync : state.pending; },
  usePaginatedQuery: () => ({ results: snapshot().list.page, status: 'Exhausted', loadMore: vi.fn() }),
  useMutation: () => ({ withOptimisticUpdate: (update: any) => async (args: any) => {
    const before = mock.state;
    update({
      getQuery: () => mock.state.pending,
      getAllQueries: () => [{ args: {}, value: mock.state.list }],
      setQuery: (ref: any, _args: any, value: any) => { mock.state = { ...mock.state, [getFunctionName(ref) === 'clients:list' ? 'list' : 'pending']: value }; },
    }, args);
    emit();
    try { await new Promise((_resolve, reject) => { mock.reject = reject; }); }
    catch (error) { mock.state = before; emit(); throw error; }
  } }),
}));
vi.mock('../../hooks/useThreads', () => ({ useThreadHoverPrefetch: () => vi.fn(), usePrefetchAdjacentThreads: vi.fn() }));
vi.mock('../../hooks/useHistoricalSync', () => ({ useAnyHistoricalSyncInProgress: () => ({ inProgress: false }) }));
vi.mock('../thread-list/ThreadItem', () => ({ ThreadItem: ({ thread, onSelect }: any) => <button onClick={() => onSelect(thread.id)}>{thread.subject}</button> }));
vi.mock('react-hot-toast', () => ({ default: { error: mock.error } }));
beforeEach(() => {
  vi.clearAllMocks();
  mock.state = { sync: { syncedAt: Date.now(), indexing: false, error: null }, pending: { latestEmailId: 'email1' },
    list: { page: ['one', 'two'].map((name, i) => ({ threadId: name, latestEmailId: `email${i + 1}`, thread: { id: name, subject: name } })), isDone: true, continueCursor: '' } };
  useUiStore.setState({ selectedAccountId: null, selectedThreadId: 'one', selectedThreadIds: new Set(), visibleThreadIds: [] });
});
afterEach(cleanup);

it('removes and advances before the server responds, then restores the row if saving fails', async () => {
  render(<><ClientsList /><NoReplyNeeded threadId="one" emailId="email1" /></>);
  fireEvent.click(screen.getByRole('button', { name: 'No reply needed' }));
  expect(screen.queryByRole('button', { name: 'one' })).toBeNull();
  expect(useUiStore.getState().selectedThreadId).toBe('two');
  await act(async () => mock.reject(new Error('Connection failed')));
  expect(screen.getByRole('button', { name: 'one' })).toBeTruthy();
  expect(mock.error).toHaveBeenCalledWith('Connection failed');
});

it('keeps loaded rows when toggled back without refreshing the ERP or changing Today selection while hidden', () => {
  const view = render(<ClientsList active />);
  view.rerender(<ClientsList active={false} />);
  act(() => {
    mock.state = { ...mock.state, list: { ...mock.state.list, page: mock.state.list.page.slice(1) } };
    emit();
  });
  expect(useUiStore.getState().selectedThreadId).toBe('one');
  view.rerender(<ClientsList active />);
  expect(screen.getByRole('button', { name: 'two' })).toBeTruthy();
  expect(mock.refresh).not.toHaveBeenCalled();
});

it('does not hide a newer message when applying a dismissal of an older message', () => {
  mock.state.list.page[0].latestEmailId = 'new-email';
  render(<><ClientsList /><NoReplyNeeded threadId="one" emailId="email1" /></>);
  fireEvent.click(screen.getByRole('button', { name: 'No reply needed' }));
  expect(screen.getByRole('button', { name: 'one' })).toBeTruthy();
});
