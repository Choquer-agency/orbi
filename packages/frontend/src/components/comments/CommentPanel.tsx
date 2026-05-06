import { useState, useRef, useEffect } from 'react';
import { Send, UserPlus, X } from 'lucide-react';
import * as Avatar from '@radix-ui/react-avatar';
import DOMPurify from 'dompurify';
import { useAddComment, useResolveComment, useAddReaction } from '../../hooks/useComments';
import { useAuthStore } from '../../stores/authStore';
import { formatExactTime, getInitials, cn } from '../../lib/utils';
import { getAvatarColor } from '../../lib/constants';

interface CommentPanelProps {
  threadId: string;
  comments: any[];
}

const QUICK_REACTIONS = ['👍', '✅', '👀', '❤️', '🎉', '💡'];

// Mock team members — in production these come from API
const TEAM_MEMBERS = [
  { id: '1', name: 'Sarah Chen', email: 'sarah@orbi.agency' },
  { id: '2', name: 'Mike Torres', email: 'mike@orbi.agency' },
  { id: '3', name: 'Sophie Kim', email: 'sophie@orbi.agency' },
  { id: '4', name: 'Alex Rivera', email: 'alex@orbi.agency' },
  { id: '5', name: 'Jordan Lee', email: 'jordan@orbi.agency' },
];

export function CommentPanel({ threadId, comments }: CommentPanelProps) {
  const { user } = useAuthStore();
  const addComment = useAddComment();
  const resolveComment = useResolveComment();
  const addReaction = useAddReaction();
  const [newComment, setNewComment] = useState('');
  const [showReactions, setShowReactions] = useState<string | null>(null);
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [taggedMembers, setTaggedMembers] = useState<typeof TEAM_MEMBERS>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll on new comments
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [comments.length]);

  const filteredMembers = TEAM_MEMBERS.filter(
    (m) =>
      !taggedMembers.find((t) => t.id === m.id) &&
      (m.name.toLowerCase().includes(tagSearch.toLowerCase()) ||
        m.email.toLowerCase().includes(tagSearch.toLowerCase())),
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;

    const mentions = taggedMembers.map((m) => `@${m.name}`).join(' ');
    const fullText = mentions ? `${mentions} ${newComment}` : newComment;

    const escapedText = fullText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    await addComment.mutateAsync({
      threadId,
      bodyHtml: `<p>${escapedText}</p>`,
      bodyText: fullText,
    });
    setNewComment('');
    setTaggedMembers([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const addTag = (member: (typeof TEAM_MEMBERS)[0]) => {
    setTaggedMembers([...taggedMembers, member]);
    setShowTagMenu(false);
    setTagSearch('');
    inputRef.current?.focus();
  };

  const removeTag = (id: string) => {
    setTaggedMembers(taggedMembers.filter((m) => m.id !== id));
  };

  const isOwnMessage = (comment: any) => comment.author?.id === user?.id;

  return (
    <div className="overflow-hidden rounded-lg bg-amber-50/60 ring-1 ring-amber-200/60">
      {/* Chat messages */}
      <div ref={scrollRef} className="max-h-72 overflow-y-auto px-3 py-3">
        {comments.length === 0 ? null : (
          <div className="space-y-2">
            {comments.map((comment: any) => {
              const own = isOwnMessage(comment);
              const authorName = comment.author?.name || 'Unknown';
              const color = getAvatarColor(authorName);

              return (
                <div key={comment.id} className={cn('flex gap-2', own && 'flex-row-reverse')}>
                  {/* Avatar — only for other people */}
                  {!own && (
                    <Avatar.Root className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full">
                      <Avatar.Fallback
                        className={cn(
                          'flex h-full w-full items-center justify-center rounded-full text-[9px] font-bold',
                          color.bg,
                          color.text,
                        )}
                      >
                        {getInitials(authorName)}
                      </Avatar.Fallback>
                    </Avatar.Root>
                  )}

                  <div className={cn('max-w-[75%]', own && 'items-end')}>
                    {/* Name + time */}
                    <div
                      className={cn(
                        'mb-0.5 flex items-center gap-1.5',
                        own && 'flex-row-reverse',
                      )}
                    >
                      {!own && (
                        <span className="text-[11px] font-semibold text-text-primary">
                          {authorName}
                        </span>
                      )}
                      <span className="text-[10px] text-text-tertiary">
                        {formatExactTime(comment.createdAt)}
                      </span>
                      {comment.isResolved && (
                        <span className="text-[10px] text-green-500">resolved</span>
                      )}
                    </div>

                    {/* Bubble */}
                    <div
                      className={cn(
                        'group relative rounded-lg px-3 py-2 text-[13px] leading-relaxed',
                        own
                          ? 'rounded-br-lg bg-primary text-white'
                          : 'rounded-bl-lg bg-white text-text-primary ring-1 ring-border/40',
                      )}
                    >
                      <div
                        dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(comment.bodyHtml) }}
                        className="[&_p]:m-0"
                      />

                      {/* Hover actions */}
                      <div
                        className={cn(
                          'absolute top-0.5 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100',
                          own ? '-left-16' : '-right-16',
                        )}
                      >
                        <button
                          onClick={() =>
                            setShowReactions(
                              showReactions === comment.id ? null : comment.id,
                            )
                          }
                          className="rounded-lg bg-white p-1 text-text-tertiary shadow-sm ring-1 ring-border hover:text-text-primary"
                          title="React"
                        >
                          😊
                        </button>
                        <button
                          onClick={() => resolveComment.mutate(comment.id)}
                          className={cn(
                            'rounded-lg bg-white p-1 text-[11px] shadow-sm ring-1 ring-border',
                            comment.isResolved ? 'text-green-500' : 'text-text-tertiary hover:text-green-500',
                          )}
                          title={comment.isResolved ? 'Unresolve' : 'Resolve'}
                        >
                          ✓
                        </button>
                      </div>
                    </div>

                    {/* Reactions */}
                    {comment.reactions?.length > 0 && (
                      <div className={cn('mt-1 flex flex-wrap gap-1', own && 'justify-end')}>
                        {groupReactions(comment.reactions).map(
                          ({ emoji, count, hasUserReacted }) => (
                            <button
                              key={emoji}
                              onClick={() =>
                                addReaction.mutate({ commentId: comment.id, emoji })
                              }
                              className={cn(
                                'flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[10px]',
                                hasUserReacted
                                  ? 'border-primary/30 bg-selected text-primary'
                                  : 'border-border bg-white',
                              )}
                            >
                              {emoji} {count}
                            </button>
                          ),
                        )}
                      </div>
                    )}

                    {/* Reaction picker */}
                    {showReactions === comment.id && (
                      <div className={cn('mt-1 flex gap-0.5', own && 'justify-end')}>
                        {QUICK_REACTIONS.map((emoji) => (
                          <button
                            key={emoji}
                            onClick={() => {
                              addReaction.mutate({ commentId: comment.id, emoji });
                              setShowReactions(null);
                            }}
                            className="rounded-lg p-1 text-sm hover:bg-white"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Tagged members */}
      {taggedMembers.length > 0 && (
        <div className="flex flex-wrap gap-1 border-t border-amber-200/60 px-3 py-2">
          {taggedMembers.map((m) => (
            <span
              key={m.id}
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
            >
              @{m.name}
              <button onClick={() => removeTag(m.id)} className="hover:text-primary/70">
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Tag dropdown */}
      {showTagMenu && (
        <div className="border-t border-amber-200/60 bg-white p-2">
          <input
            type="text"
            value={tagSearch}
            onChange={(e) => setTagSearch(e.target.value)}
            placeholder="Search team members..."
            className="mb-2 w-full rounded-lg border border-border px-2.5 py-1.5 text-[12px] outline-none placeholder:text-text-tertiary focus:border-primary"
            autoFocus
          />
          <div className="max-h-32 overflow-y-auto">
            {filteredMembers.map((m) => {
              const mc = getAvatarColor(m.name);
              return (
                <button
                  key={m.id}
                  onClick={() => addTag(m)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface"
                >
                  <div
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded-full text-[8px] font-bold',
                      mc.bg,
                      mc.text,
                    )}
                  >
                    {getInitials(m.name)}
                  </div>
                  <div>
                    <span className="text-[12px] font-medium text-text-primary">{m.name}</span>
                    <span className="ml-1.5 text-[11px] text-text-tertiary">{m.email}</span>
                  </div>
                </button>
              );
            })}
            {filteredMembers.length === 0 && (
              <p className="py-2 text-center text-[11px] text-text-tertiary">No members found</p>
            )}
          </div>
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-amber-200/60 px-3 py-2">
        <button
          type="button"
          onClick={() => setShowTagMenu(!showTagMenu)}
          className={cn(
            'rounded-lg p-1.5 transition-colors',
            showTagMenu ? 'bg-primary/10 text-primary' : 'text-text-tertiary hover:bg-surface hover:text-text-primary',
          )}
          title="Tag team member"
        >
          <UserPlus className="h-3.5 w-3.5" />
        </button>
        <input
          ref={inputRef}
          type="text"
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Write a message..."
          className="min-w-0 flex-1 rounded-lg border border-amber-200/80 bg-white px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400/50"
        />
        <button
          type="submit"
          disabled={!newComment.trim() || addComment.isPending}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-white transition-colors hover:bg-amber-600 disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
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
