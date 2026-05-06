import { Mail, ArrowRight } from 'lucide-react';
import * as Avatar from '@radix-ui/react-avatar';
import { useNeedsReply } from '../../hooks/useDashboard';
import { useUiStore } from '../../stores/uiStore';
import { getAvatarColor } from '../../lib/constants';
import { cn, getInitials, truncate } from '../../lib/utils';

function formatWaiting(hours: number): string {
  if (hours < 1) return '< 1h';
  if (hours < 24) return `${hours}h`;
  const d = Math.floor(hours / 24);
  return `${d}d`;
}

export function NeedsReplyList() {
  const { data, isLoading } = useNeedsReply();
  const { setSelectedFolder, setSelectedThread } = useUiStore();
  const items = data?.data ?? [];

  const navigateToThread = (threadId: string) => {
    setSelectedFolder('inbox');
    setSelectedThread(threadId);
  };

  return (
    <div className="rounded-lg border border-border bg-white p-7 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-50">
          <Mail className="h-4 w-4 text-red-500" />
        </div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-tertiary">
          Needs Your Reply
        </h3>
        {items.length > 0 && (
          <span className="ml-auto rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-600">
            {items.length}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="mt-5 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="h-8 w-8 animate-pulse rounded-full bg-surface" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-24 animate-pulse rounded bg-surface" />
                <div className="h-2.5 w-40 animate-pulse rounded bg-surface" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-6 flex flex-col items-center py-4 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50">
            <Mail className="h-5 w-5 text-emerald-500" />
          </div>
          <p className="mt-2 text-[12px] font-medium text-text-secondary">All caught up</p>
          <p className="mt-0.5 text-[11px] text-text-tertiary">No pending replies</p>
        </div>
      ) : (
        <div className="mt-4 space-y-1">
          {items.map((item) => {
            const name = item.contactName || item.contactEmail;
            const color = getAvatarColor(name);

            return (
              <button
                key={item.threadId}
                onClick={() => navigateToThread(item.threadId)}
                className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface"
              >
                <Avatar.Root className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full">
                  <Avatar.Fallback
                    className={cn(
                      'flex h-full w-full items-center justify-center rounded-full text-[11px] font-bold',
                      color.bg,
                      color.text,
                    )}
                  >
                    {getInitials(name)}
                  </Avatar.Fallback>
                </Avatar.Root>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-medium text-text-primary">
                      {item.contactName || item.contactEmail}
                    </span>
                  </div>
                  <p className="truncate text-[11px] text-text-tertiary">
                    {truncate(item.threadSubject, 50)}
                  </p>
                </div>

                <span
                  className={cn(
                    'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                    item.waitingHours >= 24
                      ? 'bg-red-50 text-red-600'
                      : item.waitingHours >= 4
                        ? 'bg-amber-50 text-amber-600'
                        : 'bg-surface text-text-tertiary',
                  )}
                >
                  {formatWaiting(item.waitingHours)}
                </span>

                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
