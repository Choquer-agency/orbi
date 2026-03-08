import { useState } from 'react';
import { Archive, Reply, Forward, Star, Trash2, MoreHorizontal, MessageSquare } from 'lucide-react';
import { useThread, useUpdateThread } from '../../hooks/useThreads';
import { useUiStore } from '../../stores/uiStore';
import { formatRelativeTime, getInitials, cn } from '../../lib/utils';
import { CommentPanel } from '../comments/CommentPanel';
import { ComposeInline } from '../compose/ComposeInline';
import DOMPurify from 'dompurify';

export function EmailViewer() {
  const { selectedThreadId } = useUiStore();
  const { data, isLoading } = useThread(selectedThreadId);
  const updateThread = useUpdateThread();
  const [showComments, setShowComments] = useState(true);
  const [replyMode, setReplyMode] = useState<'reply' | 'forward' | null>(null);

  if (!selectedThreadId) {
    return (
      <div className="flex h-full items-center justify-center bg-gray-50">
        <div className="text-center">
          <p className="text-sm text-gray-500">Select a conversation to read</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
      </div>
    );
  }

  const thread = data?.data;
  if (!thread) return null;

  const emails = thread.emails ?? [];
  const commentCount = thread.comments?.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      {/* Thread header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-6 py-3">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold text-gray-900">
          {thread.subject}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => updateThread.mutate({ id: thread.id, isStarred: !thread.isStarred })}
            className={cn(
              'rounded p-1.5 hover:bg-gray-100',
              thread.isStarred ? 'text-yellow-500' : 'text-gray-400',
            )}
            title="Star"
          >
            <Star className="h-4 w-4" fill={thread.isStarred ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={() => updateThread.mutate({ id: thread.id, isArchived: true })}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            title="Archive"
          >
            <Archive className="h-4 w-4" />
          </button>
          <button
            onClick={() => updateThread.mutate({ id: thread.id, isTrashed: true })}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-500"
            title="Delete"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            onClick={() => setShowComments(!showComments)}
            className={cn(
              'rounded p-1.5 hover:bg-gray-100',
              showComments ? 'text-blue-600' : 'text-gray-400',
            )}
            title="Internal comments"
          >
            <MessageSquare className="h-4 w-4" />
            {commentCount > 0 && (
              <span className="ml-0.5 text-[10px]">{commentCount}</span>
            )}
          </button>
        </div>
      </div>

      {/* Email messages */}
      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-4">
          {emails.map((email: any, index: number) => (
            <div key={email.id} className={cn('mb-4', index < emails.length - 1 && 'border-b border-gray-100 pb-4')}>
              {/* Email header */}
              <div className="mb-3 flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-200 text-xs font-medium text-gray-600">
                    {getInitials(email.fromName || email.fromAddress)}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-gray-900">
                      {email.fromName || email.fromAddress}
                    </div>
                    <div className="text-xs text-gray-400">
                      to {(email.toAddresses as any[])?.map((a: any) => a.name || a.email).join(', ')}
                    </div>
                  </div>
                </div>
                <span className="text-xs text-gray-400">
                  {formatRelativeTime(email.receivedAt)}
                </span>
              </div>

              {/* Email body */}
              <div className="prose prose-sm max-w-none text-gray-700">
                {email.bodyHtml ? (
                  <div
                    dangerouslySetInnerHTML={{
                      __html: DOMPurify.sanitize(email.bodyHtml, {
                        FORBID_TAGS: ['script', 'style'],
                        FORBID_ATTR: ['onerror', 'onclick', 'onload'],
                      }),
                    }}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap font-sans text-sm">{email.bodyText}</pre>
                )}
              </div>

              {/* Attachments */}
              {email.attachments?.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {email.attachments.map((att: any) => (
                    <div
                      key={att.id}
                      className="flex items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1.5 text-xs text-gray-600"
                    >
                      <span>{att.filename}</span>
                      <span className="text-gray-400">
                        ({(att.size / 1024).toFixed(0)} KB)
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Internal comments panel */}
        {showComments && (
          <CommentPanel threadId={thread.id} comments={thread.comments ?? []} />
        )}
      </div>

      {/* Reply bar */}
      <div className="border-t border-gray-200">
        {replyMode ? (
          <ComposeInline
            threadId={thread.id}
            mode={replyMode}
            onClose={() => setReplyMode(null)}
          />
        ) : (
          <div className="flex items-center gap-2 px-6 py-3">
            <button
              onClick={() => setReplyMode('reply')}
              className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Reply className="h-3.5 w-3.5" />
              Reply
            </button>
            <button
              onClick={() => setReplyMode('forward')}
              className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              <Forward className="h-3.5 w-3.5" />
              Forward
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
