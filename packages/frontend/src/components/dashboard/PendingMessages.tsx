import { MessageSquare, ArrowRight } from 'lucide-react';
import * as Avatar from '@radix-ui/react-avatar';
import { usePendingComments } from '../../hooks/useDashboard';
import { useUiStore } from '../../stores/uiStore';
import { getAvatarColor } from '../../lib/constants';
import { cn, getInitials, truncate } from '../../lib/utils';

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const d = new Date(dateStr).getTime();
  const diffMs = now - d;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function PendingMessages() {
  const { data, isLoading } = usePendingComments();
  const { setSelectedFolder, setSelectedThread } = useUiStore();
  const comments = data?.data ?? [];

  const navigateToThread = (threadId: string) => {
    setSelectedFolder('inbox');
    setSelectedThread(threadId);
  };

  return (
    <div className="rounded-lg border border-border bg-white px-10 py-8 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-50">
          <MessageSquare className="h-4 w-4 text-amber-500" />
        </div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-tertiary">
          Team Messages
        </h3>
        {comments.length > 0 && (
          <span className="ml-auto rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-600">
            {comments.length}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="mt-5 space-y-3">
          {[1, 2].map((i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="h-8 w-8 animate-pulse rounded-full bg-surface" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-20 animate-pulse rounded bg-surface" />
                <div className="h-8 w-full animate-pulse rounded bg-surface" />
              </div>
            </div>
          ))}
        </div>
      ) : comments.length === 0 ? (
        <div className="mt-6 flex flex-col items-center py-4 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50">
            <MessageSquare className="h-5 w-5 text-emerald-500" />
          </div>
          <p className="mt-2 text-[12px] font-medium text-text-secondary">No pending messages</p>
          <p className="mt-0.5 text-[11px] text-text-tertiary">Internal comments will appear here</p>
        </div>
      ) : (
        <div className="mt-4 space-y-1">
          {comments.map((comment) => {
            const color = getAvatarColor(comment.author.name);

            return (
              <button
                key={comment.id}
                onClick={() => navigateToThread(comment.thread.id)}
                className="group flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface"
              >
                <Avatar.Root className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full">
                  <Avatar.Fallback
                    className={cn(
                      'flex h-full w-full items-center justify-center rounded-full text-[11px] font-bold',
                      color.bg,
                      color.text,
                    )}
                  >
                    {getInitials(comment.author.name)}
                  </Avatar.Fallback>
                </Avatar.Root>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[12px] font-medium text-text-primary">
                      {comment.author.name}
                    </span>
                    <span className="text-[10px] text-text-tertiary">
                      {timeAgo(comment.createdAt)}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-text-secondary">
                    {comment.bodyText}
                  </p>
                  <p className="mt-1 truncate text-[10px] text-text-tertiary">
                    {truncate(comment.thread.subject, 45)}
                  </p>
                </div>

                <ArrowRight className="mt-2 h-3.5 w-3.5 shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
