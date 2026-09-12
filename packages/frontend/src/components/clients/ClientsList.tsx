import { useEffect, useRef, useState } from 'react';
import { useAction, usePaginatedQuery, useQuery } from 'convex/react';
import { CheckCheck, RefreshCw } from 'lucide-react';
import { api } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';
import { useAnyHistoricalSyncInProgress } from '../../hooks/useHistoricalSync';

import { ThreadItem } from '../thread-list/ThreadItem';
import { useThreadHoverPrefetch, usePrefetchAdjacentThreads } from '../../hooks/useThreads';

export function ClientsList({ active = true }: { active?: boolean }) {
  const { selectedAccountId, selectedThreadId, setSelectedThread, setVisibleThreadIds, selectedThreadIds, toggleThreadSelection, selectThreadRange } = useUiStore();
  const importStatus = useAnyHistoricalSyncInProgress();
  const sync = useQuery(api.clients.status, {});
  const refresh = useAction(api.clientWorkflow.directory);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const { results, status, loadMore } = usePaginatedQuery(api.clients.list, sync ? { ...(selectedAccountId ? { accountId: selectedAccountId as Id<'mailAccounts'> } : {}) } : 'skip', { initialNumItems: 50 });
  const previous = useRef<string[]>([]);
  const initialized = useRef(false);
  const prefetchThread = useThreadHoverPrefetch();
  const selectedIndex = results.findIndex(row => row.threadId === selectedThreadId);
  usePrefetchAdjacentThreads(null,
    active ? results[selectedIndex + 1]?.threadId ?? null : null,
    active ? results[selectedIndex + 2]?.threadId ?? null : null);
  const refreshDirectory = async () => {
    setRefreshing(true); setError('');
    try { await refresh({}); } catch (e) { setError(e instanceof Error ? e.message : 'Could not refresh clients'); }
    finally { setRefreshing(false); }
  };
  useEffect(() => {
    if (!active || sync === undefined || sync === null || initialized.current) return;
    initialized.current = true;
    if (!sync.syncedAt) void refreshDirectory();
  }, [active, sync]); // Existing directories are maintained by the cron, not by toggles.
  useEffect(() => {
    if (!active) return;
    const ids = results.map(row => row.threadId as string);
    if (status === 'LoadingFirstPage') return;
    const old = previous.current;
    if (selectedThreadId && old.includes(selectedThreadId) && !ids.includes(selectedThreadId)) {
      const index = old.indexOf(selectedThreadId);
      const next = old.slice(index + 1).find(id => ids.includes(id)) ?? ids[0] ?? null;
      setSelectedThread(next);
    }
    previous.current = ids;
    setVisibleThreadIds(ids);
  }, [active, results, selectedThreadId, setSelectedThread, setVisibleThreadIds, status]);
  const incomplete = status === 'CanLoadMore' || status === 'LoadingMore';
  const loading = sync === undefined || refreshing && !sync?.syncedAt || status === 'LoadingFirstPage' && !!sync;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
      <div><p className="text-sm font-semibold text-text-primary">Awaiting your reply <span className="ml-1 text-primary">{results.length}{incomplete ? '+' : ''}</span></p>
        <p className="mt-0.5 text-[11px] text-text-tertiary">Since Jun 11, 2026 · oldest first</p></div>
      <button aria-label="Refresh clients from ERP" onClick={() => void refreshDirectory()} disabled={refreshing} className="rounded-lg p-2 text-text-tertiary hover:bg-white"><RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} /></button>
    </div>
    {(error || sync?.error) && <div role="alert" className="border-b border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">{error || sync?.error}<button onClick={() => void refreshDirectory()} className="ml-2 font-semibold underline">Retry</button></div>}
    {sync?.indexing && <p role="status" className="border-b border-border px-4 py-2 text-xs text-text-secondary">Checking your email history. More conversations may appear…</p>}
    {sync?.syncedAt && <p className="px-4 pt-2 text-[10px] text-text-tertiary">Clients updated {new Date(sync.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto">
      {loading ? <p role="status" className="p-8 text-center text-xs text-text-secondary">Loading your client conversations…</p> : sync === null ? <p className="p-6 text-xs text-text-secondary">Clients is available for Choquer team members.</p> : results.length === 0 && sync?.syncedAt && !sync.indexing && !importStatus.inProgress && !incomplete && !error && !sync.error ? <div className="flex h-full min-h-56 flex-col items-center justify-center px-4 text-center"><span className="rounded-full bg-emerald-50 p-4"><CheckCheck className="h-7 w-7 text-emerald-600" /></span><h3 className="mt-4 text-sm font-semibold text-text-primary">You’re caught up</h3><p className="mt-1 text-xs text-text-secondary">No client conversations waiting for your reply.</p></div> : null}
      {results.map(row => <ThreadItem
        key={row.threadId}
        thread={row.thread}
        isSelected={selectedThreadId === row.threadId}
        isMultiSelected={selectedThreadIds.has(row.threadId)}
        onSelect={setSelectedThread}
        onShiftClick={id => selectThreadRange(id, results.map(item => item.threadId))}
        onCtrlClick={toggleThreadSelection}
        accountColor={row.thread.accountColor}
        onPrefetch={prefetchThread}
      />)}
      {incomplete && <button onClick={() => loadMore(50)} disabled={status === 'LoadingMore'} className="w-full rounded-lg py-3 text-xs font-medium text-primary">{status === 'LoadingMore' ? 'Loading…' : 'Load more conversations'}</button>}
    </div>
  </div>;
}
