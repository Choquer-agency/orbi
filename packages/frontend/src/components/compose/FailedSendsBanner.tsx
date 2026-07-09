import { useState } from 'react';
import { AlertTriangle, RefreshCw, Trash2, X } from 'lucide-react';
import { useQuery, useMutation } from 'convex/react';
import { useUiStore } from '../../stores/uiStore';
import { api as convexApi } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import toast from 'react-hot-toast';
import { Tooltip } from '../ui/Tooltip';

// Dismissals persist across refreshes (localStorage). Keyed by
// emailId:sendAttempts so a dismissed failure stays gone, but if a RETRY of
// that same email fails again (attempts increments) the banner reappears —
// dismiss means "stop telling me about this failure", not "never warn about
// this email again".
const DISMISSED_KEY = 'orbi-dismissed-failed-sends';

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveDismissed(keys: Set<string>, currentKeys: string[]) {
  try {
    // Prune entries for emails no longer failed (retried OK / discarded) so
    // the list can't grow forever.
    const current = new Set(currentKeys);
    localStorage.setItem(
      DISMISSED_KEY,
      JSON.stringify([...keys].filter((k) => current.has(k))),
    );
  } catch {
    /* storage full/unavailable — dismissal just won't persist */
  }
}

const dismissKeyOf = (e: { id: string; sendAttempts?: number }) =>
  `${e.id}:${e.sendAttempts ?? 0}`;

// Global "a send failed" surface. Failed sends used to be visible only as a
// small badge inside the open thread — a failed reply in a thread you never
// re-opened was effectively invisible. This banner sits above the undo pills
// and stays until each failure is retried, discarded, or dismissed. Convex
// reactivity keeps it live: the sweep-stuck-sends cron marking a wedged send
// FAILED pops it here within seconds.
export function FailedSendsBanner() {
  const result = useQuery(convexApi.emails.listFailed, {});
  const retrySend = useMutation(convexApi.emails.retrySend);
  const discardSend = useMutation(convexApi.emails.discardFailedSend);
  const setSelectedThread = useUiStore((s) => s.setSelectedThread);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const all = result?.data ?? [];
  const failed = all.filter((e) => !dismissed.has(dismissKeyOf(e)));
  if (failed.length === 0) return null;

  const handleDismiss = () => {
    const next = new Set(dismissed);
    for (const e of failed) next.add(dismissKeyOf(e));
    setDismissed(next);
    saveDismissed(next, all.map(dismissKeyOf));
  };

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
            onClick={handleDismiss}
            className="ml-auto rounded p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
            aria-label="Dismiss"
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
                {/* Click to open the thread so the failed email's content can
                    be reviewed (and edited via reply) before retrying. */}
                <button
                  type="button"
                  onClick={() => setSelectedThread(e.threadId as string)}
                  className="min-w-0 flex-1 rounded-md px-1 py-0.5 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
                  title="Open this conversation"
                >
                  <div className="truncate text-sm text-zinc-800 dark:text-zinc-200">
                    {e.subject || '(no subject)'}
                    {to && <span className="text-zinc-400"> → {to}</span>}
                  </div>
                  {e.sendError && (
                    <div className="truncate text-xs text-red-500/90" title={e.sendError}>
                      {e.sendError}
                    </div>
                  )}
                </button>
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
