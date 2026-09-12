import { useState } from 'react';
import { useMutation, useQuery } from 'convex/react';
import { Check } from 'lucide-react';
import toast from 'react-hot-toast';
import { api } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';

export function NoReplyNeeded({ threadId, emailId }: { threadId: string; emailId: string }) {
  const pending = useQuery(api.clients.replyNeeded, { threadId: threadId as Id<'threads'> });
  const dismiss = useMutation(api.clients.dismiss).withOptimisticUpdate((store, args) => {
    const current = store.getQuery(api.clients.replyNeeded, { threadId: args.threadId });
    if (current?.latestEmailId === args.latestEmailId) store.setQuery(api.clients.replyNeeded, { threadId: args.threadId }, null);
    for (const query of store.getAllQueries(api.clients.list)) {
      if (!query.value) continue;
      store.setQuery(api.clients.list, query.args, { ...query.value,
        page: query.value.page.filter(row => row.threadId !== args.threadId || row.latestEmailId !== args.latestEmailId) });
    }
    // Convex restores these cached results automatically if saving fails.
  });
  const [busy, setBusy] = useState(false);
  if (!pending?.latestEmailId || pending.latestEmailId !== emailId) return null;
  return <button
    disabled={busy}
    onKeyDown={event => event.stopPropagation()}
    className="mr-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-emerald-50 hover:text-emerald-700 disabled:opacity-50"
    onClick={async event => {
      event.stopPropagation();
      setBusy(true);
      try { await dismiss({ threadId: threadId as Id<'threads'>, latestEmailId: pending.latestEmailId! }); }
      catch (error) { toast.error(error instanceof Error ? error.message : 'Could not clear conversation'); }
      finally { setBusy(false); }
    }}
  ><Check className="h-3 w-3" />{busy ? 'Clearing…' : 'No reply needed'}</button>;
}
