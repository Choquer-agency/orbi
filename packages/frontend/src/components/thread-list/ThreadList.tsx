import { useThreads } from '../../hooks/useThreads';
import { useUiStore } from '../../stores/uiStore';
import { cn, formatRelativeTime, getInitials, truncate } from '../../lib/utils';

export function ThreadList() {
  const { selectedAccountId, selectedThreadId, setSelectedThread } = useUiStore();
  const { data, isLoading } = useThreads({ accountId: selectedAccountId ?? undefined });
  const threads = data?.data ?? [];

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-900">Inbox</h2>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">
          Inbox
          {threads.length > 0 && (
            <span className="ml-2 text-xs font-normal text-gray-400">{threads.length}</span>
          )}
        </h2>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto">
        {threads.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <p className="text-sm text-gray-500">No emails yet</p>
            <p className="mt-1 text-xs text-gray-400">Connect an email account to get started</p>
          </div>
        ) : (
          threads.map((thread: any) => {
            const latestEmail = thread.emails?.[0];
            const isSelected = selectedThreadId === thread.id;
            const commentCount = thread._count?.comments ?? 0;

            return (
              <button
                key={thread.id}
                onClick={() => setSelectedThread(thread.id)}
                className={cn(
                  'flex w-full gap-3 border-b border-gray-100 px-4 py-3 text-left transition-colors',
                  isSelected ? 'bg-blue-50' : 'hover:bg-gray-50',
                  !thread.isRead && 'bg-white',
                )}
              >
                {/* Avatar */}
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-200 text-[11px] font-medium text-gray-600">
                  {getInitials(latestEmail?.fromName || latestEmail?.fromAddress || '?')}
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between">
                    <span
                      className={cn(
                        'truncate text-sm',
                        !thread.isRead ? 'font-semibold text-gray-900' : 'text-gray-700',
                      )}
                    >
                      {latestEmail?.fromName || latestEmail?.fromAddress || 'Unknown'}
                    </span>
                    <span className="ml-2 shrink-0 text-xs text-gray-400">
                      {formatRelativeTime(thread.lastMessageAt)}
                    </span>
                  </div>
                  <p
                    className={cn(
                      'truncate text-sm',
                      !thread.isRead ? 'font-medium text-gray-900' : 'text-gray-600',
                    )}
                  >
                    {thread.subject}
                  </p>
                  <p className="truncate text-xs text-gray-400">
                    {truncate(latestEmail?.snippet || '', 80)}
                  </p>
                  {/* Badges */}
                  <div className="mt-1 flex items-center gap-2">
                    {thread.messageCount > 1 && (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500">
                        {thread.messageCount}
                      </span>
                    )}
                    {commentCount > 0 && (
                      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600">
                        {commentCount} comment{commentCount > 1 ? 's' : ''}
                      </span>
                    )}
                    {thread.isStarred && (
                      <span className="text-[10px] text-yellow-500">&#9733;</span>
                    )}
                  </div>
                </div>

                {/* Unread indicator */}
                {!thread.isRead && (
                  <div className="mt-2 h-2 w-2 shrink-0 rounded-full bg-blue-500" />
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
