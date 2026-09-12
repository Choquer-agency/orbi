// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ThreadList } from './ThreadList';
import { useUiStore } from '../../stores/uiStore';

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  local: vi.fn(),
  rows: [] as Array<Record<string, unknown>>,
}));
const empty = {
  data: { pages: [{ data: [], total: 0 }] },
  isLoading: false,
  isError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  refetch: async () => {},
  fetchNextPage: async () => {},
};
vi.mock('../../hooks/useMailboxSearch', () => ({
  useMailboxSearch: (...args: unknown[]) => {
    mocks.search(...args);
    return {
      ...empty,
      data: { pages: [{ data: mocks.rows, total: mocks.rows.length }] },
      partial: false,
    };
  },
}));
vi.mock('../../hooks/useThreads', () => ({
  useThreads: (...args: unknown[]) => {
    mocks.local(...args);
    return empty;
  },
  useUpdateThread: () => ({ mutate: vi.fn() }),
  usePrefetchAdjacentThreads: () => {},
  useIdleThreadPrefetch: () => {},
  useThreadHoverPrefetch: () => vi.fn(),
}));
vi.mock('../../hooks/useAccounts', () => ({ useAccounts: () => ({ data: [] }) }));
vi.mock('../../lib/contactDirectory', () => ({
  useInstantContactSearch: (q: string) => ({
    data: {
      data: q.toLowerCase().startsWith('mi')
        ? [
            {
              id: 'mike',
              primaryEmail: 'mike@example.com',
              displayName: 'Mike Nunn',
              totalEmailCount: 36,
            },
          ]
        : [],
    },
  }),
}));
vi.mock('../../hooks/useHistoricalSync', () => ({
  useAnyHistoricalSyncInProgress: () => ({ inProgress: false }),
}));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../hooks/usePullToRefresh', () => ({
  usePullToRefresh: () => ({ scrollRef: { current: null }, pullDistance: 0, isRefreshing: false }),
}));
vi.mock('../../hooks/useNotifications', () => ({
  useMarkThreadNotificationsRead: () => async () => {},
}));
vi.mock('../navigation/NavigationDropdown', () => ({ NavigationDropdown: () => null }));
vi.mock('../scheduled/ScheduledEmailList', () => ({ ScheduledEmailList: () => null }));
vi.mock('./NeedsResponseList', () => ({ NeedsResponseList: () => null }));
vi.mock('./ThreadItem', () => ({
  ThreadItem: ({ thread }: { thread: { subject: string } }) => <div>{thread.subject}</div>,
}));
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    button: ({
      children,
      onClick,
      'aria-label': label,
    }: {
      children: React.ReactNode;
      onClick: () => void;
      'aria-label': string;
    }) => (
      <button aria-label={label} onClick={onClick}>
        {children}
      </button>
    ),
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  mocks.search.mockClear();
  mocks.local.mockClear();
  mocks.rows = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  useUiStore.setState({
    selectedAccountId: null,
    selectedFolder: 'inbox',
    selectedThreadId: null,
    selectedThreadIds: new Set(),
    threadListFilter: 'all',
    contactSearchEmail: null,
    teamViewUserId: null,
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const openSearch = () => {
  render(<ThreadList />);
  fireEvent.click(screen.getByRole('button', { name: 'Open search' }));
  return screen.getByRole('combobox');
};
const debounce = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(251);
  });
};

it('searches a typed full name without silently selecting the suggested sender', async () => {
  const input = openSearch();
  fireEvent.change(input, { target: { value: 'Mike Nunn' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await debounce();
  expect(mocks.search).toHaveBeenLastCalledWith('Mike Nunn', undefined, true);
});

it('selects a person with an explicit participant filter and a visible name', async () => {
  const input = openSearch();
  fireEvent.change(input, { target: { value: 'Mike' } });
  fireEvent.click(screen.getByRole('option', { name: 'Mike Nunn mike@example.com' }));
  await debounce();
  expect(mocks.search).toHaveBeenLastCalledWith('with:mike@example.com', undefined, true);
  expect(screen.getByRole('button', { name: 'Remove with: Mike Nunn' })).toBeTruthy();
});

it('allows spaces in the From field and serializes the complete name on Enter', async () => {
  const input = openSearch();
  fireEvent.change(input, { target: { value: 'from:' } });
  fireEvent.change(input, { target: { value: 'Mike ' } });
  expect((input as HTMLInputElement).value).toBe('Mike ');
  fireEvent.change(input, { target: { value: 'Mike Nunn' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await debounce();
  expect(mocks.search).toHaveBeenLastCalledWith('from:"Mike Nunn"', undefined, true);
});

it('supports keyboard selection and removing the entire person filter', async () => {
  const input = openSearch();
  fireEvent.change(input, { target: { value: 'Mike' } });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  fireEvent.keyDown(input, { key: 'Enter' });
  await debounce();
  fireEvent.click(screen.getByRole('button', { name: 'Remove with: Mike Nunn' }));
  await debounce();
  expect(mocks.search).toHaveBeenLastCalledWith('', undefined, true);
});

it('does not let a hidden unread tab remove read search matches', async () => {
  useUiStore.setState({ threadListFilter: 'unread' });
  mocks.rows = [
    {
      id: 'thread1',
      subject: 'Read message from Mike',
      isRead: true,
      lastReceivedAt: Date.now(),
      lastMessageAt: Date.now(),
      emails: [],
    },
  ];
  const input = openSearch();
  fireEvent.change(input, { target: { value: 'Mike' } });
  await debounce();
  expect(screen.getByText('Read message from Mike')).toBeTruthy();
});
