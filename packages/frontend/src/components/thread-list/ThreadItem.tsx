import { memo, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { AlarmClockOff, Archive, CalendarDays, Clock, Forward, FolderInput, Inbox, Mail, MailOpen, Moon, Reply, Star, Sun, Trash2 } from 'lucide-react';
import * as Avatar from '@radix-ui/react-avatar';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { motion, useMotionValue, useMotionValueEvent, useTransform, useAnimate } from 'framer-motion';
import toast from 'react-hot-toast';
import { useUpdateThread, useSnoozeThread, useUnsnoozeThread } from '../../hooks/useThreads';
import { useContactNameResolver } from '../../hooks/useContacts';
import { cn, formatRelativeTime, getInitials } from '../../lib/utils';
import { getAvatarColor } from '../../lib/constants';
import { CategoryPill } from '../ui/CategoryPill';
import { SnoozePopover } from './SnoozePopover';
import { useUiStore } from '../../stores/uiStore';
import { useIsMobile } from '../../hooks/useIsMobile';
import { haptic } from '../../lib/haptics';
import { showActionSheet } from '../../lib/actionSheet';

interface ThreadItemProps {
  thread: any;
  isSelected: boolean;
  isMultiSelected: boolean;
  onSelect: (id: string) => void;
  onShiftClick: (id: string) => void;
  onCtrlClick: (id: string) => void;
  accountColor?: string;
  onPrefetch?: (id: string) => void;
}

const SWIPE_REVEAL = 80; // Distance to reveal action buttons

function ThreadItemImpl({ thread, isSelected, isMultiSelected, onSelect, onShiftClick, onCtrlClick, accountColor, onPrefetch }: ThreadItemProps) {
  const updateThread = useUpdateThread();
  const unsnoozeThread = useUnsnoozeThread();
  const setPendingReplyMode = useUiStore((s) => s.setPendingReplyMode);
  const isMobile = useIsMobile();
  const x = useMotionValue(0);
  const [scope, animate] = useAnimate();

  const resolveName = useContactNameResolver();
  const latestEmail = thread.emails?.[0];
  const commentCount = thread._count?.comments ?? 0;
  const triageCategories = ['marketing', 'spam', 'notification'];
  const hasTriageLabel = thread.labels?.some((l: string) => l.startsWith('triage:'));
  const hasTriageClassification = latestEmail?.classification && triageCategories.includes(latestEmail.classification.category);
  const classification = (hasTriageLabel || hasTriageClassification) ? latestEmail?.classification : null;
  const senderName = resolveName(latestEmail?.fromAddress, latestEmail?.fromName);
  const avatarColor = getAvatarColor(senderName);

  // Haptic feedback on swipe threshold crossing
  const swipeHapticFired = useRef(false);
  useMotionValueEvent(x, 'change', (latest) => {
    if (!swipeHapticFired.current && (latest > SWIPE_REVEAL || latest < -SWIPE_REVEAL)) {
      swipeHapticFired.current = true;
      haptic.medium();
    }
  });

  // Long-press handler for mobile action sheet
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressCancelled = useRef(false);

  const handleLongPress = async () => {
    const options = [
      { title: thread.isRead ? 'Mark as unread' : 'Mark as read' },
      { title: thread.isArchived ? 'Move to inbox' : 'Archive' },
      { title: thread.isStarred ? 'Unstar' : 'Star' },
      { title: 'Reply' },
      { title: 'Forward' },
      { title: 'Delete', destructive: true },
    ];

    const index = await showActionSheet(thread.subject || 'Thread', options);
    switch (index) {
      case 0: updateThread.mutate({ id: thread.id, isRead: !thread.isRead }); break;
      case 1:
        if (thread.isArchived) updateThread.mutate({ id: thread.id, isArchived: false, isTrashed: false });
        else updateThread.mutate({ id: thread.id, isArchived: true });
        break;
      case 2: updateThread.mutate({ id: thread.id, isStarred: !thread.isStarred }); break;
      case 3: onSelect(thread.id); setPendingReplyMode('reply'); break;
      case 4: onSelect(thread.id); setPendingReplyMode('forward'); break;
      case 5: updateThread.mutate({ id: thread.id, isTrashed: true }); break;
    }
  };

  const startLongPress = () => {
    longPressCancelled.current = false;
    longPressTimer.current = setTimeout(() => {
      if (!longPressCancelled.current) {
        handleLongPress();
      }
    }, 500);
  };

  const cancelLongPress = () => {
    longPressCancelled.current = true;
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleDragStart = () => {
    swipeHapticFired.current = false;
    cancelLongPress(); // Cancel long-press if user starts swiping
  };

  const handleDragEnd = async (_: any, info: { offset: { x: number } }) => {
    const absX = Math.abs(info.offset.x);
    if (absX > SWIPE_REVEAL) {
      // Snap to reveal position — show action buttons
      const target = info.offset.x > 0 ? SWIPE_REVEAL : -SWIPE_REVEAL;
      animate(scope.current, { x: target }, { type: 'spring', stiffness: 500, damping: 30 });
    } else {
      // Snap back
      animate(scope.current, { x: 0 }, { type: 'spring', stiffness: 500, damping: 30 });
    }
  };

  const snapBack = () => {
    animate(scope.current, { x: 0 }, { type: 'spring', stiffness: 500, damping: 30 });
  };

  const menuItemClass = 'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors text-text-primary data-[highlighted]:bg-surface';
  const dangerItemClass = 'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors text-red-600 data-[highlighted]:bg-red-50';

  const selectThread = (e: MouseEvent | KeyboardEvent) => {
    if ('shiftKey' in e && e.shiftKey) {
      e.preventDefault();
      onShiftClick(thread.id);
    } else if ('metaKey' in e && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onCtrlClick(thread.id);
    } else {
      onSelect(thread.id);
    }
  };

  const rowContent = (
    <div
      role="button"
      tabIndex={0}
      onPointerEnter={() => onPrefetch?.(thread.id)}
      onFocus={() => onPrefetch?.(thread.id)}
      onClick={selectThread}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') selectThread(e);
      }}
      aria-label={`${!thread.isRead ? 'Unread: ' : ''}${thread.subject || 'No subject'}, from ${senderName}, ${formatRelativeTime(thread.lastReceivedAt ?? thread.lastMessageAt)}`}
      className={cn(
        'group relative flex w-full min-w-0 cursor-pointer items-start gap-3 overflow-hidden px-5 text-left transition-colors focus:outline-none focus-visible:outline-none',
        isMobile ? 'py-3' : 'py-2.5',
        isMultiSelected
          ? 'bg-primary/15 ring-1 ring-inset ring-primary/30'
          : isSelected
            ? 'bg-surface-sidebar-active'
            : 'hover:bg-surface-sidebar-hover',
      )}
    >
      {/* Avatar with account color ring — aligned with the sender-name line */}
      <Avatar.Root
        className="mt-[1px] flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full"
        style={accountColor ? { boxShadow: `0 0 0 2px var(--color-surface), 0 0 0 3.5px ${accountColor}` } : undefined}
      >
        <Avatar.Fallback
          className={cn(
            'flex h-full w-full items-center justify-center rounded-full text-[10px] font-bold',
            avatarColor.bg,
            avatarColor.text,
          )}
        >
          {getInitials(senderName)}
        </Avatar.Fallback>
      </Avatar.Root>

      {/* Content */}
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex items-baseline justify-between gap-1.5">
          <span className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold text-text-primary">
            {senderName}
          </span>
          <span className="shrink-0 whitespace-nowrap text-[10px] text-text-tertiary">
            {formatRelativeTime(thread.lastReceivedAt ?? thread.lastMessageAt)}
          </span>
        </div>
        <div className="flex items-baseline justify-between gap-1.5">
          <p
            className={cn(
              'min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12px]',
              !thread.isRead ? 'font-medium text-text-primary' : 'text-text-secondary',
            )}
          >
            {thread.subject}
          </p>
          {thread.messageCount > 1 && (
            <span className="shrink-0 rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
              {thread.messageCount}
            </span>
          )}
        </div>
        {/* Snippet + inline badges — single row so all threads have a uniform height */}
        <div className="flex items-center gap-1.5">
          <p className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-text-tertiary">
            {latestEmail?.snippet || ''}
          </p>
          {(commentCount > 0 || thread.isStarred || classification || thread.hasDraft || thread.snoozedUntil) && (
            <div className="flex shrink-0 items-center gap-1">
              {thread.snoozedUntil && (
                <span className="flex items-center gap-0.5 rounded-md bg-amber-100 px-1.5 text-[10px] font-semibold leading-[16px] text-amber-700 ring-1 ring-inset ring-amber-200">
                  <Clock className="h-2.5 w-2.5" />
                  {formatRelativeTime(thread.snoozedUntil)}
                </span>
              )}
              {thread.hasDraft && (
                <span className="rounded-md bg-amber-100 px-1.5 text-[10px] font-semibold leading-[16px] text-amber-700 ring-1 ring-inset ring-amber-200">
                  Draft
                </span>
              )}
              {classification && (
                <CategoryPill category={classification.category} />
              )}
              {commentCount > 0 && (
                <span className="rounded-md bg-amber-100 px-1.5 text-[10px] font-semibold leading-[16px] text-amber-700 ring-1 ring-inset ring-amber-200">
                  {commentCount}
                </span>
              )}
              {thread.isStarred && (
                <Star className="h-2.5 w-2.5 fill-yellow-400 text-yellow-400" />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Unread indicator */}
      {!thread.isRead && (
        <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-unread" />
      )}

      {/* Hover quick actions — desktop only */}
      {!isMobile && (
        <div className="pointer-events-none absolute right-2 top-2.5 flex gap-0.5 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100">
          <button
            onClick={(e) => {
              e.stopPropagation();
              updateThread.mutate({ id: thread.id, isRead: !thread.isRead });
            }}
            className="rounded-lg bg-white p-1 text-text-tertiary shadow-sm ring-1 ring-border transition-colors hover:text-text-primary"
            title={thread.isRead ? 'Mark as unread' : 'Mark as read'}
            aria-label={thread.isRead ? 'Mark as unread' : 'Mark as read'}
          >
            {thread.isRead ? <MailOpen className="h-3 w-3" /> : <Mail className="h-3 w-3" />}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              updateThread.mutate({ id: thread.id, isArchived: true });
            }}
            className="rounded-lg bg-white p-1 text-text-tertiary shadow-sm ring-1 ring-border transition-colors hover:text-text-primary"
            title="Archive"
            aria-label="Archive"
          >
            <Archive className="h-3 w-3" />
          </button>
          {thread.snoozedUntil ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                unsnoozeThread.mutate(thread.id, {
                  onSuccess: () => toast.success('Thread unsnoozed'),
                });
              }}
              className="rounded-lg bg-white p-1 text-amber-500 shadow-sm ring-1 ring-border transition-colors hover:text-amber-600"
              title="Unsnooze"
              aria-label="Unsnooze"
            >
              <AlarmClockOff className="h-3 w-3" />
            </button>
          ) : (
            <SnoozePopover
              threadId={thread.id}
              trigger={
                <button
                  onClick={(e) => e.stopPropagation()}
                  className="rounded-lg bg-white p-1 text-text-tertiary shadow-sm ring-1 ring-border transition-colors hover:text-text-primary"
                  title="Snooze"
                  aria-label="Snooze"
                >
                  <Clock className="h-3 w-3" />
                </button>
              }
            />
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              updateThread.mutate({ id: thread.id, isStarred: !thread.isStarred });
            }}
            className={cn(
              'rounded-lg bg-white p-1 shadow-sm ring-1 ring-border transition-colors',
              thread.isStarred ? 'text-yellow-400' : 'text-text-tertiary hover:text-yellow-400',
            )}
            title="Star"
            aria-label={thread.isStarred ? 'Unstar' : 'Star'}
          >
            <Star className="h-3 w-3" fill={thread.isStarred ? 'currentColor' : 'none'} />
          </button>
        </div>
      )}
    </div>
  );

  // Mobile: wrap in swipeable motion container
  if (isMobile) {
    return (
      <div
        className="relative overflow-hidden"
        onTouchStart={startLongPress}
        onTouchMove={cancelLongPress}
        onTouchEnd={cancelLongPress}
      >
        {/* Swipe right reveal: Star + Snooze */}
        <div className="absolute inset-y-0 left-0 flex items-stretch">
          <button
            onClick={() => {
              haptic.success();
              updateThread.mutate({ id: thread.id, isStarred: !thread.isStarred });
              snapBack();
            }}
            className={cn(
              'flex w-10 items-center justify-center',
              thread.isStarred ? 'bg-yellow-400' : 'bg-yellow-400',
            )}
          >
            <Star className="h-5 w-5 text-white" fill={thread.isStarred ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={() => {
              haptic.success();
              // Quick snooze to tomorrow 8am
              const tomorrow = new Date();
              tomorrow.setDate(tomorrow.getDate() + 1);
              tomorrow.setHours(8, 0, 0, 0);
              toast.success('Snoozed until tomorrow');
              snapBack();
            }}
            className="flex w-10 items-center justify-center bg-amber-500"
          >
            <Clock className="h-5 w-5 text-white" />
          </button>
        </div>

        {/* Swipe left reveal: Read/Unread + Delete */}
        <div className="absolute inset-y-0 right-0 flex items-stretch">
          <button
            onClick={() => {
              haptic.success();
              updateThread.mutate({ id: thread.id, isRead: !thread.isRead });
              snapBack();
            }}
            className="flex w-10 items-center justify-center bg-blue-500"
          >
            {thread.isRead ? <MailOpen className="h-5 w-5 text-white" /> : <Mail className="h-5 w-5 text-white" />}
          </button>
          <button
            onClick={async () => {
              haptic.success();
              await animate(scope.current, { x: -400, opacity: 0 }, { duration: 0.2 });
              updateThread.mutate({ id: thread.id, isTrashed: true });
            }}
            className="flex w-10 items-center justify-center bg-red-500"
          >
            <Trash2 className="h-5 w-5 text-white" />
          </button>
        </div>

        {/* Draggable row */}
        <motion.div
          ref={scope}
          style={{ x }}
          drag="x"
          dragDirectionLock
          dragElastic={0.15}
          dragConstraints={{ left: -SWIPE_REVEAL, right: SWIPE_REVEAL }}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          className="relative bg-surface"
        >
          {rowContent}
        </motion.div>
      </div>
    );
  }

  // Desktop: wrap in context menu
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        {rowContent}
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-[180px] rounded-lg border border-border bg-white p-1.5 shadow-lg">
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              onSelect(thread.id);
              setPendingReplyMode('reply');
            }}
          >
            <Reply className="h-4 w-4" />
            Reply
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => {
              onSelect(thread.id);
              setPendingReplyMode('forward');
            }}
          >
            <Forward className="h-4 w-4" />
            Forward
          </ContextMenu.Item>

          <ContextMenu.Separator className="my-1.5 h-px bg-border" />

          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => updateThread.mutate({ id: thread.id, isArchived: !thread.isArchived })}
          >
            <Archive className="h-4 w-4" />
            {thread.isArchived ? 'Unarchive' : 'Archive'}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => updateThread.mutate({ id: thread.id, isStarred: !thread.isStarred })}
          >
            <Star className="h-4 w-4" fill={thread.isStarred ? 'currentColor' : 'none'} />
            {thread.isStarred ? 'Unstar' : 'Star'}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => updateThread.mutate({ id: thread.id, isRead: !thread.isRead })}
          >
            {thread.isRead ? <MailOpen className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
            {thread.isRead ? 'Mark as unread' : 'Mark as read'}
          </ContextMenu.Item>

          {thread.snoozedUntil ? (
            <ContextMenu.Item
              className={menuItemClass}
              onSelect={() => unsnoozeThread.mutate(thread.id, { onSuccess: () => toast.success('Thread unsnoozed') })}
            >
              <AlarmClockOff className="h-4 w-4" />
              Unsnooze
            </ContextMenu.Item>
          ) : (
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={cn(menuItemClass, 'data-[state=open]:bg-surface')}>
                <Clock className="h-4 w-4" />
                Snooze
                <span className="ml-auto text-[11px] text-text-tertiary">&#x25B8;</span>
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className="z-50 min-w-[160px] rounded-lg border border-border bg-white p-1.5 shadow-lg">
                  <SnoozeContextMenuItems threadId={thread.id} />
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
          )}

          <ContextMenu.Separator className="my-1.5 h-px bg-border" />

          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={cn(menuItemClass, 'data-[state=open]:bg-surface')}>
              <FolderInput className="h-4 w-4" />
              Move to
              <span className="ml-auto text-[11px] text-text-tertiary">&#x25B8;</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className="z-50 min-w-[140px] rounded-lg border border-border bg-white p-1.5 shadow-lg">
                <ContextMenu.Item
                  className={menuItemClass}
                  onSelect={() => updateThread.mutate({ id: thread.id, isArchived: false, isTrashed: false })}
                >
                  <Inbox className="h-4 w-4" />
                  Inbox
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={menuItemClass}
                  onSelect={() => updateThread.mutate({ id: thread.id, isArchived: true })}
                >
                  <Archive className="h-4 w-4" />
                  Archive
                </ContextMenu.Item>
                <ContextMenu.Item
                  className={dangerItemClass}
                  onSelect={() => updateThread.mutate({ id: thread.id, isTrashed: true })}
                >
                  <Trash2 className="h-4 w-4" />
                  Trash
                </ContextMenu.Item>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>

          <ContextMenu.Separator className="my-1.5 h-px bg-border" />

          <ContextMenu.Item
            className={dangerItemClass}
            onSelect={() => updateThread.mutate({ id: thread.id, isTrashed: true })}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

// Stable memo: re-render only when the thread, selection, or account color
// actually changes. This prevents scroll-induced rerenders from re-running
// every row's hover/transition styles, which was causing the "blink" effect
// as rows entered/left the virtualized viewport.
export const ThreadItem = memo(
  ThreadItemImpl,
  (prev, next) => {
    if (prev.isSelected !== next.isSelected) return false;
    if (prev.isMultiSelected !== next.isMultiSelected) return false;
    if (prev.accountColor !== next.accountColor) return false;
    if (prev.onSelect !== next.onSelect) return false;
    if (prev.onShiftClick !== next.onShiftClick) return false;
    if (prev.onCtrlClick !== next.onCtrlClick) return false;
    const a = prev.thread;
    const b = next.thread;
    if (a === b) return true;
    return (
      a.id === b.id &&
      a.isRead === b.isRead &&
      a.isStarred === b.isStarred &&
      a.isArchived === b.isArchived &&
      a.isTrashed === b.isTrashed &&
      a.snoozedUntil === b.snoozedUntil &&
      a.subject === b.subject &&
      a.messageCount === b.messageCount &&
      a.lastReceivedAt === b.lastReceivedAt &&
      a.lastMessageAt === b.lastMessageAt &&
      a.hasDraft === b.hasDraft &&
      (a._count?.comments ?? 0) === (b._count?.comments ?? 0) &&
      (a.emails?.[0]?.snippet ?? '') === (b.emails?.[0]?.snippet ?? '') &&
      (a.emails?.[0]?.fromAddress ?? '') === (b.emails?.[0]?.fromAddress ?? '')
    );
  },
);

function SnoozeContextMenuItems({ threadId }: { threadId: string }) {
  const snoozeThread = useSnoozeThread();
  const menuItemClass = 'flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] outline-none transition-colors text-text-primary data-[highlighted]:bg-surface';

  const handleSnooze = (date: Date) => {
    snoozeThread.mutate(
      { id: threadId, snoozedUntil: date.toISOString() },
      {
        onSuccess: () => toast.success(`Snoozed until ${date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}`),
        onError: () => toast.error('Failed to snooze'),
      },
    );
  };

  const now = new Date();
  const isPastEvening = now.getHours() >= 18;

  const laterToday = new Date(now);
  if (isPastEvening) {
    laterToday.setDate(laterToday.getDate() + 1);
    laterToday.setHours(8, 0, 0, 0);
  } else {
    laterToday.setHours(18, 0, 0, 0);
  }

  const tomorrowMorning = new Date(now);
  tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
  tomorrowMorning.setHours(8, 0, 0, 0);

  const nextMonday = new Date(now);
  const dayOfWeek = now.getDay();
  nextMonday.setDate(nextMonday.getDate() + (dayOfWeek === 0 ? 1 : 8 - dayOfWeek));
  nextMonday.setHours(8, 0, 0, 0);

  return (
    <>
      <ContextMenu.Item className={menuItemClass} onSelect={() => handleSnooze(laterToday)}>
        {isPastEvening ? <Sun className="h-4 w-4 text-amber-500" /> : <Moon className="h-4 w-4 text-indigo-400" />}
        {isPastEvening ? 'Tomorrow morning' : 'Later today'}
      </ContextMenu.Item>
      {!isPastEvening && (
        <ContextMenu.Item className={menuItemClass} onSelect={() => handleSnooze(tomorrowMorning)}>
          <Sun className="h-4 w-4 text-amber-500" />
          Tomorrow morning
        </ContextMenu.Item>
      )}
      <ContextMenu.Item className={menuItemClass} onSelect={() => handleSnooze(nextMonday)}>
        <CalendarDays className="h-4 w-4 text-blue-500" />
        Next week
      </ContextMenu.Item>
    </>
  );
}
