import { useState } from 'react';
import { Check, Smile } from 'lucide-react';
import { useAddComment, useResolveComment, useAddReaction } from '../../hooks/useComments';
import { useAuthStore } from '../../stores/authStore';
import { formatRelativeTime, getInitials, cn } from '../../lib/utils';

interface CommentPanelProps {
  threadId: string;
  comments: any[];
}

const QUICK_REACTIONS = ['👍', '✅', '👀', '❤️', '🎉', '💡'];

export function CommentPanel({ threadId, comments }: CommentPanelProps) {
  const { user } = useAuthStore();
  const addComment = useAddComment();
  const resolveComment = useResolveComment();
  const addReaction = useAddReaction();
  const [newComment, setNewComment] = useState('');
  const [showReactions, setShowReactions] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;

    await addComment.mutateAsync({
      threadId,
      bodyHtml: `<p>${newComment}</p>`,
      bodyText: newComment,
    });
    setNewComment('');
  };

  return (
    <div className="border-t border-amber-200 bg-amber-50/50">
      <div className="px-6 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-amber-700">
          Internal — not visible to client
        </span>
      </div>

      {/* Comments list */}
      <div className="max-h-64 overflow-y-auto px-6">
        {comments.length === 0 ? (
          <p className="py-3 text-xs text-gray-400">No internal comments yet</p>
        ) : (
          comments.map((comment: any) => (
            <div
              key={comment.id}
              className={cn(
                'mb-3 rounded-md border bg-white p-3',
                comment.isResolved ? 'border-green-200 opacity-60' : 'border-gray-200',
              )}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="flex h-6 w-6 items-center justify-center rounded-full bg-gray-200 text-[10px] font-medium text-gray-600">
                    {getInitials(comment.author?.name || '?')}
                  </div>
                  <span className="text-xs font-medium text-gray-900">
                    {comment.author?.name}
                  </span>
                  <span className="text-xs text-gray-400">
                    {formatRelativeTime(comment.createdAt)}
                  </span>
                  {comment.isEdited && (
                    <span className="text-[10px] text-gray-400">(edited)</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() =>
                      setShowReactions(showReactions === comment.id ? null : comment.id)
                    }
                    className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                  >
                    <Smile className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => resolveComment.mutate(comment.id)}
                    className={cn(
                      'rounded p-1 hover:bg-gray-100',
                      comment.isResolved ? 'text-green-500' : 'text-gray-400 hover:text-green-500',
                    )}
                    title={comment.isResolved ? 'Unresolve' : 'Resolve'}
                  >
                    <Check className="h-3 w-3" />
                  </button>
                </div>
              </div>

              <div
                className="mt-1 text-sm text-gray-700"
                dangerouslySetInnerHTML={{ __html: comment.bodyHtml }}
              />

              {/* Reactions */}
              {comment.reactions?.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {groupReactions(comment.reactions).map(({ emoji, count, hasUserReacted }) => (
                    <button
                      key={emoji}
                      onClick={() => addReaction.mutate({ commentId: comment.id, emoji })}
                      className={cn(
                        'flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs',
                        hasUserReacted
                          ? 'border-blue-200 bg-blue-50 text-blue-600'
                          : 'border-gray-200 hover:bg-gray-50',
                      )}
                    >
                      <span>{emoji}</span>
                      <span>{count}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Reaction picker */}
              {showReactions === comment.id && (
                <div className="mt-2 flex gap-1">
                  {QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => {
                        addReaction.mutate({ commentId: comment.id, emoji });
                        setShowReactions(null);
                      }}
                      className="rounded p-1 hover:bg-gray-100"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* New comment input */}
      <form onSubmit={handleSubmit} className="border-t border-amber-200 px-6 py-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Add an internal comment... Use @name to mention"
            className="flex-1 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={!newComment.trim() || addComment.isPending}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            Post
          </button>
        </div>
      </form>
    </div>
  );
}

function groupReactions(
  reactions: any[],
): { emoji: string; count: number; hasUserReacted: boolean }[] {
  const grouped = new Map<string, { count: number; hasUserReacted: boolean }>();
  const currentUserId = useAuthStore.getState().user?.id;

  for (const r of reactions) {
    const existing = grouped.get(r.emoji) || { count: 0, hasUserReacted: false };
    existing.count++;
    if (r.userId === currentUserId) existing.hasUserReacted = true;
    grouped.set(r.emoji, existing);
  }

  return Array.from(grouped.entries()).map(([emoji, data]) => ({ emoji, ...data }));
}
