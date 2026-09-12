import { useEffect, useRef, useState } from 'react';
import { useAction, useMutation, usePaginatedQuery, useQuery } from 'convex/react';
import { Check, CheckCheck, Clock3, RefreshCw, Users } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';
import { useAnyHistoricalSyncInProgress } from '../../hooks/useHistoricalSync';

function waitingLabel(at: number) {
  const hours = Math.max(0, Math.floor((Date.now() - at) / 3600000));
  return hours < 1 ? 'Just arrived' : hours < 24 ? `Waiting ${hours}h` : `Waiting ${Math.floor(hours / 24)}d`;
}
export function ClientsList() {
  const { selectedAccountId, selectedThreadId, setSelectedThread, setVisibleThreadIds } = useUiStore();
  const importStatus = useAnyHistoricalSyncInProgress();
  const sync = useQuery(api.clients.status, {});
  const refresh = useAction(api.clientWorkflow.directory);
  const dismiss = useMutation(api.clients.dismiss);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [dismissing, setDismissing] = useState<string | null>(null);
  const { results, status, loadMore } = usePaginatedQuery(api.clients.list, sync ? { ...(selectedAccountId ? { accountId: selectedAccountId as Id<'mailAccounts'> } : {}) } : 'skip', { initialNumItems: 50 });
  const previous = useRef<string[]>([]);
  const refreshDirectory = async () => {
    setRefreshing(true); setError('');
    try { await refresh({}); } catch (e) { setError(e instanceof Error ? e.message : 'Could not refresh clients'); }
    finally { setRefreshing(false); }
  };
  useEffect(() => { void refreshDirectory(); }, []); // Refresh when entering the view; cron keeps it current afterward.
  useEffect(() => {
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
  }, [results, selectedThreadId, setSelectedThread, setVisibleThreadIds, status]);
  const incomplete = status === 'CanLoadMore' || status === 'LoadingMore';
  const loading = sync === undefined || refreshing && !sync?.syncedAt || status === 'LoadingFirstPage' && !!sync;
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
      <div><p className="text-sm font-semibold text-text-primary">Awaiting your reply <span className="ml-1 text-primary">{results.length}{incomplete ? '+' : ''}</span></p>
        <p className="mt-0.5 text-[11px] text-text-tertiary">Oldest first · includes archived mail</p></div>
      <button aria-label="Refresh clients from ERP" onClick={() => void refreshDirectory()} disabled={refreshing} className="rounded-lg p-2 text-text-tertiary hover:bg-white"><RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} /></button>
    </div>
    {(error || sync?.error) && <div role="alert" className="border-b border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">{error || sync?.error}<button onClick={() => void refreshDirectory()} className="ml-2 font-semibold underline">Retry</button></div>}
    {sync?.indexing && <p role="status" className="border-b border-border px-4 py-2 text-xs text-text-secondary">Checking your email history. More conversations may appear…</p>}
    {sync?.syncedAt && <p className="px-4 pt-2 text-[10px] text-text-tertiary">Clients updated {new Date(sync.syncedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>}
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {loading ? <p role="status" className="p-8 text-center text-xs text-text-secondary">Loading your client conversations…</p> : sync === null ? <p className="p-6 text-xs text-text-secondary">Clients is available for Choquer team members.</p> : results.length === 0 && sync?.syncedAt && !sync.indexing && !importStatus.inProgress && !incomplete && !error && !sync.error ? <div className="flex h-full min-h-56 flex-col items-center justify-center px-4 text-center"><span className="rounded-full bg-emerald-50 p-4"><CheckCheck className="h-7 w-7 text-emerald-600" /></span><h3 className="mt-4 text-sm font-semibold text-text-primary">You’re caught up</h3><p className="mt-1 text-xs text-text-secondary">No client conversations waiting for your reply.</p></div> : null}
      {results.map(row => <article key={row._id} className={cn('mb-2 rounded-xl border bg-white p-3 transition-colors', selectedThreadId === row.threadId ? 'border-primary/40 bg-primary/5' : 'border-border hover:border-primary/20')}>
        <button onClick={() => setSelectedThread(row.threadId)} className="block w-full text-left">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-primary"><Users className="h-3 w-3" /><span className="truncate">{row.clientName}</span></div>
          <div className="mt-2 flex items-center justify-between gap-2"><span className="truncate text-xs font-medium text-text-primary">{row.senderName || row.sender}</span>{!row.isRead && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}</div>
          <p className="mt-1 truncate text-[13px] font-semibold text-text-primary">{row.subject || '(No subject)'}</p>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-secondary">{row.snippet}</p>
        </button>
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border/60 pt-2"><span className={cn('flex items-center gap-1 text-[10px]', Date.now() - row.waitingAt! > 86400000 ? 'text-amber-700' : 'text-text-tertiary')}><Clock3 className="h-3 w-3" />{waitingLabel(row.waitingAt!)}</span>
          <button disabled={dismissing === row.threadId} onClick={async () => { setDismissing(row.threadId); try { await dismiss({ threadId: row.threadId, latestEmailId: row.latestEmailId! }); } catch (e) { toast.error(e instanceof Error ? e.message : 'Could not clear conversation'); } finally { setDismissing(null); } }} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-medium text-text-secondary hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50"><Check className="h-3 w-3" />No reply needed</button></div>
      </article>)}
      {incomplete && <button onClick={() => loadMore(50)} disabled={status === 'LoadingMore'} className="w-full rounded-lg py-3 text-xs font-medium text-primary">{status === 'LoadingMore' ? 'Loading…' : 'Load more conversations'}</button>}
    </div>
  </div>;
}
