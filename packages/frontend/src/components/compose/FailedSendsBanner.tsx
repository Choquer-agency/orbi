import { useState } from 'react';
import { AlertTriangle, RefreshCw, Trash2, X } from 'lucide-react';
import { useQuery, useMutation } from 'convex/react';
import { api as convexApi } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import toast from 'react-hot-toast';
import { Tooltip } from '../ui/Tooltip';

// Global "a send failed" surface. Failed sends used to be visible only as a
// small badge inside the open thread — a failed reply in a thread you never
// re-opened was effectively invisible. This banner sits above the undo pills
// and stays until each failure is retried, discarded, or dismissed for the
// session. Convex reactivity keeps it live: the sweep-stuck-sends cron
// marking a wedged send FAILED pops it here within seconds.
export function FailedSendsBanner() {
  const result = useQuery(convexApi.emails.listFailed, {});
  const retrySend = useMutation(convexApi.emails.retrySend);
  const discardSend = useMutation(convexApi.emails.discardFailedSend);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const failed = (result?.data ?? []).filter((e) => !dismissed.has(e.id));
  if (failed.length === 0) return null;

  const markBusy = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const handleRetry = async (id: string) => {
    markBusy(id, true);
    try {
      await retrySend({ emailId: id as Id<'emails'> });
      toast.success('Send retried');
    } catch (err: any) {
      toast.error(err?.message || 'Retry failed');
    } finally {
      markBusy(id, false);
    }
  };

  const handleDiscard = async (id: string) => {
    markBusy(id, true);
    try {
      await discardSend({ emailId: id as Id<'emails'> });
      toast.success('Discarded');
    } catch (err: any) {
      toast.error(err?.message || 'Discard failed');
    } finally {
      markBusy(id, false);
    }
  };

  const shown = failed.slice(0, 3);
  const extra = failed.length - shown.length;

  return (
    <div className="fixed bottom-20 left-1/2 z-50 w-[440px] max-w-[calc(100vw-2rem)] -translate-x-1/2">
      <div className="rounded-xl border border-red-200 bg-white shadow-lg dark:border-red-900/60 dark:bg-zinc-900">
        <div className="flex items-center gap-2 border-b border-red-100 px-4 py-2 dark:border-red-900/40">
          <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
          <span className="text-sm font-medium text-red-700 dark:text-red-400">
            {failed.length === 1
              ? 'An email failed to send'
              : `${failed.length} emails failed to send`}
          </span>
          <button
            type="button"
            onClick={() => setDismissed(new Set(failed.map((e) => e.id)))}
            className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
            aria-label="Dismiss for now"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {shown.map((e) => {
            const to = e.toAddresses?.[0]?.email ?? '';
            const isBusy = busy.has(e.id);
            return (
              <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-zinc-800 dark:text-zinc-200">
                    {e.subject || '(no subject)'}
                    {to && <span className="text-zinc-400"> → {to}</span>}
                  </div>
                  {e.sendError && (
                    <div className="truncate text-xs text-red-500/90" title={e.sendError}>
                      {e.sendError}
                    </div>
                  )}
                </div>
                <Tooltip content="Retry send">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleRetry(e.id)}
                    className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  >
                    <RefreshCw className={`h-4 w-4 ${isBusy ? 'animate-spin' : ''}`} />
                  </button>
                </Tooltip>
                <Tooltip content="Discard this email">
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => handleDiscard(e.id)}
                    className="rounded-md p-1.5 text-zinc-500 hover:bg-red-50 hover:text-red-600 disabled:opacity-40 dark:hover:bg-red-950/50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </Tooltip>
              </li>
            );
          })}
        </ul>
        {extra > 0 && (
          <div className="px-4 pb-2 text-xs text-zinc-400">and {extra} more…</div>
        )}
      </div>
    </div>
  );
}
