import { useState } from 'react';
import {
  Bell,
  MessageSquare,
  CheckSquare,
  Square,
  ArrowRight,
  CheckCheck,
  ExternalLink,
} from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import * as Avatar from '@radix-ui/react-avatar';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import { useUnreadCount, useNotifications, useMarkAsRead, useMarkAllRead } from '../../hooks/useNotifications';
import { usePendingComments, useDashboardTasks, useToggleTask } from '../../hooks/useDashboard';
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

const TASK_TYPE_STYLES: Record<string, { label: string; className: string }> = {
  PROMISE: { label: 'Promise', className: 'bg-violet-50 text-violet-600' },
  DEADLINE: { label: 'Deadline', className: 'bg-red-50 text-red-600' },
  CHANGE_REQUEST: { label: 'Change', className: 'bg-amber-50 text-amber-600' },
  ACTION_ITEM: { label: 'Action', className: 'bg-sky-50 text-sky-600' },
};

type Tab = 'all' | 'messages' | 'tasks';

export function NotificationPopover() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('all');
  const { data: unreadData } = useUnreadCount();
  const unreadCount = unreadData?.data?.count ?? 0;

  const { data: notifData } = useNotifications();
  const markAsRead = useMarkAsRead();
  const markAllRead = useMarkAllRead();

  const { data: commentsData } = usePendingComments();
  const { data: tasksData } = useDashboardTasks('open');
  const toggleTask = useToggleTask();
  const { setSelectedFolder, setSelectedThread, setHighlightText } = useUiStore();

  const comments = commentsData?.data ?? [];
  const tasks = tasksData?.data ?? [];
  const notifications = notifData?.data ?? [];

  const navigateToThread = (threadId: string, highlightText?: string) => {
    setSelectedFolder('inbox');
    setSelectedThread(threadId);
    if (highlightText) setHighlightText(highlightText);
    setOpen(false);
  };

  const goToDashboard = () => {
    setSelectedFolder('dashboard');
    setOpen(false);
  };

  const totalItems = comments.length + tasks.length;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="relative rounded-lg p-1.5 text-text-secondary transition-colors hover:bg-white/60 hover:text-text-primary">
          <Bell className="h-4 w-4" />
          {(unreadCount > 0 || totalItems > 0) && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-unread px-1 text-[10px] font-medium text-white">
              {unreadCount > 0
                ? unreadCount > 99
                  ? '99+'
                  : unreadCount
                : totalItems}
            </span>
          )}
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={8}
          className="z-50 w-[380px] rounded-lg border border-border bg-white shadow-lg outline-none"
          style={{ maxHeight: 'calc(100vh - 80px)' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-[13px] font-semibold text-text-primary">Notifications</h3>
            <div className="flex items-center gap-2">
              {unreadCount > 0 && (
                <button
                  onClick={() => markAllRead.mutate()}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary"
                >
                  <CheckCheck className="h-3 w-3" />
                  Mark all read
                </button>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 border-b border-border/60 px-4 py-1.5">
            {(['all', 'messages', 'tasks'] as const).map((t) => {
              const count = t === 'all' ? totalItems : t === 'messages' ? comments.length : tasks.length;
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors',
                    tab === t
                      ? 'bg-selected text-primary'
                      : 'text-text-secondary hover:bg-surface hover:text-text-primary',
                  )}
                >
                  {t === 'all' ? 'All' : t === 'messages' ? 'Messages' : 'Tasks'}
                  {count > 0 && (
                    <span
                      className={cn(
                        'rounded-full px-1.5 py-px text-[10px] font-semibold',
                        tab === t ? 'bg-primary/10 text-primary' : 'bg-surface text-text-tertiary',
                      )}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Content */}
          <ScrollArea.Root className="max-h-[420px]">
            <ScrollArea.Viewport className="h-full w-full">
              <div className="px-2 py-2">
                {/* Team messages section */}
                {(tab === 'all' || tab === 'messages') && comments.length > 0 && (
                  <div>
                    {tab === 'all' && (
                      <div className="flex items-center gap-1.5 px-2 py-1.5">
                        <MessageSquare className="h-3 w-3 text-amber-500" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                          Team Messages
                        </span>
                      </div>
                    )}
                    {comments.slice(0, tab === 'all' ? 3 : 10).map((comment) => {
                      const color = getAvatarColor(comment.author.name);
                      return (
                        <button
                          key={comment.id}
                          onClick={() => navigateToThread(comment.thread.id, comment.bodyText)}
                          className="group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface"
                        >
                          <Avatar.Root className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full">
                            <Avatar.Fallback
                              className={cn(
                                'flex h-full w-full items-center justify-center rounded-full text-[10px] font-bold',
                                color.bg,
                                color.text,
                              )}
                            >
                              {getInitials(comment.author.name)}
                            </Avatar.Fallback>
                          </Avatar.Root>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-[11px] font-semibold text-text-primary">
                                {comment.author.name}
                              </span>
                              <span className="text-[10px] text-text-tertiary">
                                {timeAgo(comment.createdAt)}
                              </span>
                            </div>
                            <p className="mt-0.5 line-clamp-1 text-[11px] text-text-secondary">
                              {comment.bodyText}
                            </p>
                            <p className="mt-0.5 truncate text-[10px] text-text-tertiary">
                              {truncate(comment.thread.subject, 40)}
                            </p>
                          </div>
                          <ArrowRight className="mt-1.5 h-3 w-3 shrink-0 text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100" />
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Tasks section */}
                {(tab === 'all' || tab === 'tasks') && tasks.length > 0 && (
                  <div className={tab === 'all' && comments.length > 0 ? 'mt-1' : ''}>
                    {tab === 'all' && (
                      <div className="flex items-center gap-1.5 px-2 py-1.5">
                        <CheckSquare className="h-3 w-3 text-violet-500" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                          Open Tasks
                        </span>
                      </div>
                    )}
                    {tasks.slice(0, tab === 'all' ? 3 : 10).map((task) => {
                      const typeStyle = TASK_TYPE_STYLES[task.taskType] || TASK_TYPE_STYLES.ACTION_ITEM;
                      return (
                        <div
                          key={task.id}
                          className="group flex items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-surface"
                        >
                          <button
                            onClick={() =>
                              toggleTask.mutate({ id: task.id, status: 'DONE' })
                            }
                            className="mt-0.5 shrink-0 text-text-tertiary transition-colors hover:text-primary"
                          >
                            <Square className="h-3.5 w-3.5" />
                          </button>
                          <div className="min-w-0 flex-1">
                            <p className="line-clamp-1 text-[11px] leading-snug text-text-primary">
                              {task.description}
                            </p>
                            <div className="mt-0.5 flex items-center gap-1.5">
                              <span
                                className={cn(
                                  'rounded px-1.5 py-px text-[9px] font-semibold',
                                  typeStyle.className,
                                )}
                              >
                                {typeStyle.label}
                              </span>
                              {task.contactName && (
                                <span className="text-[10px] text-text-tertiary">
                                  {task.contactName}
                                </span>
                              )}
                            </div>
                          </div>
                          <button
                            onClick={() => navigateToThread(task.threadId, task.description)}
                            className="mt-0.5 shrink-0 rounded-lg p-0.5 text-text-tertiary opacity-0 transition-all hover:text-primary group-hover:opacity-100"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Notification history (mentions, etc.) */}
                {tab === 'all' && notifications.length > 0 && (
                  <div className="mt-1">
                    <div className="flex items-center gap-1.5 px-2 py-1.5">
                      <Bell className="h-3 w-3 text-text-tertiary" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                        Recent
                      </span>
                    </div>
                    {notifications.slice(0, 5).map((notif: any) => (
                      <button
                        key={notif.id}
                        onClick={() => {
                          if (!notif.isRead) markAsRead.mutate(notif.id);
                          if (notif.data?.threadId) {
                            navigateToThread(notif.data.threadId);
                          }
                        }}
                        className={cn(
                          'group flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface',
                          !notif.isRead && 'bg-primary/5',
                        )}
                      >
                        <div
                          className={cn(
                            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
                            notif.type === 'MENTION' ? 'bg-amber-50' : 'bg-surface',
                          )}
                        >
                          {notif.type === 'MENTION' ? (
                            <MessageSquare className="h-3 w-3 text-amber-500" />
                          ) : (
                            <Bell className="h-3 w-3 text-text-tertiary" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p
                            className={cn(
                              'text-[11px] leading-snug',
                              !notif.isRead ? 'font-semibold text-text-primary' : 'text-text-secondary',
                            )}
                          >
                            {notif.title}
                          </p>
                          {notif.body && (
                            <p className="mt-0.5 line-clamp-1 text-[10px] text-text-tertiary">
                              {notif.body}
                            </p>
                          )}
                          <span className="mt-0.5 text-[10px] text-text-tertiary">
                            {timeAgo(notif.createdAt)}
                          </span>
                        </div>
                        {!notif.isRead && (
                          <div className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                        )}
                      </button>
                    ))}
                  </div>
                )}

                {/* Empty state */}
                {totalItems === 0 && notifications.length === 0 && (
                  <div className="flex flex-col items-center py-8 text-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50">
                      <CheckCheck className="h-5 w-5 text-emerald-500" />
                    </div>
                    <p className="mt-2 text-[12px] font-medium text-text-secondary">
                      You're all caught up
                    </p>
                    <p className="mt-0.5 text-[11px] text-text-tertiary">
                      No pending messages or tasks
                    </p>
                  </div>
                )}
              </div>
            </ScrollArea.Viewport>
            <ScrollArea.Scrollbar
              orientation="vertical"
              className="flex w-1.5 touch-none select-none p-0.5"
            >
              <ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
            </ScrollArea.Scrollbar>
          </ScrollArea.Root>

          {/* Footer — link to full dashboard */}
          {totalItems > 0 && (
            <div className="border-t border-border px-4 py-2.5">
              <button
                onClick={goToDashboard}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[11px] font-medium text-primary transition-colors hover:bg-selected"
              >
                View full dashboard
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
