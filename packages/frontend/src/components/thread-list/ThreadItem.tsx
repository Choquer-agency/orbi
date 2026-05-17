import { useRef, useState } from 'react';
import { AlarmClockOff, Archive, CalendarDays, Clock, Forward, FolderInput, Inbox, Mail, MailOpen, Moon, Reply, Star, Sun, Trash2 } from 'lucide-react';
import * as Avatar from '@radix-ui/react-avatar';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { motion, useMotionValue, useMotionValueEvent, useTransform, useAnimate } from 'framer-motion';
import toast from 'react-hot-toast';
import { useUpdateThread, useSnoozeThread, useUnsnoozeThread } from '../../hooks/useThreads';
import { useContactNameResolver } from '../../hooks/useContacts';
import { cn, formatRelativeTime, getInitials, getCompanyLogoUrls } from '../../lib/utils';
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
}

const SWIPE_REVEAL = 80; // Distance to reveal action buttons

export function ThreadItem({ thread, isSelected, isMultiSelected, onSelect, onShiftClick, onCtrlClick, accountColor }: ThreadItemProps) {
  const updateThread = useUpdateThread();
  const unsnoozeThread = useUnsnoozeThread();
  const setPendingReplyMode = useUiStore((s) => s.setPendingReplyMode);
  const isMobile = useIsMobile();
  const x = useMotionValue(0);
  const [scope, animate] = useAnimate();

  const resolveName = useContactNameResolver();
  const latestEmail = thread.emails?.[0];
  const commentCount = thread._count?.comments ?? 0;
  // Pill on the thread card reflects either:
  //   - the AI classifier's "marketing" tag (our own signal), or
  //   - the provider's SPAM label (Gmail / Outlook anti-spam, source of truth).
  // We removed AI-driven spam classification — see classifier.ts — so the
  // spam pill only fires when the upstream provider marked it as spam.
  const hasTriageLabel = thread.labels?.some((l: string) => l.startsWith('triage:'));
  const hasGmailSpam = thread.labels?.includes('SPAM');
  const hasMarketingClassification = latestEmail?.classification?.category === 'marketing';
  const classification = hasGmailSpam
    ? { category: 'spam', confidence: 1, urgency: 'low', summary: '' }
    : (hasTriageLabel || hasMarketingClassification)
      ? latestEmail?.classification
      : null;
  // If the latest email's From parsing failed (calendar invites etc.),
  // fall back to a non-self participant from the thread.
  let senderName = resolveName(latestEmail?.fromAddress, latestEmail?.fromName);
  if (senderName === '—' && thread.participantEmails?.length) {
    const fallback = thread.participantEmails.find(
      (e: string) => e && !e.includes('@choquer'),
    ) || thread.participantEmails[0];
    if (fallback) senderName = resolveName(fallback, null);
  }
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

  const rowContent = (
    <button
      onClick={(e) => {
        if (e.shiftKey) {
          e.preventDefault();
          onShiftClick(thread.id);
        } else if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          onCtrlClick(thread.id);
        } else {
          onSelect(thread.id);
        }
      }}
      aria-label={`${!thread.isRead ? 'Unread: ' : ''}${thread.subject || 'No subject'}, from ${senderName}, ${formatRelativeTime(thread.lastReceivedAt ?? thread.lastMessageAt)}`}
      className={cn(
        'group relative flex w-full min-w-0 items-center gap-3 overflow-hidden pl-3 pr-5 text-left transition-colors',
        isMobile ? 'py-3.5' : 'py-2.5',
        isMultiSelected
          ? 'bg-primary/10 ring-1 ring-inset ring-primary/20'
          : isSelected
            ? 'bg-selected'
            : 'hover:bg-surface-warm',
      )}
    >
      {/* Unread dot — pinned to the left of the row, centered vertically */}
      <div className="flex w-2 shrink-0 items-center justify-center">
        {!thread.isRead && (
          <span className="h-2 w-2 rounded-full bg-unread" />
        )}
      </div>

      {/* Avatar wrapped in a colored ring with a surface-colored gap.
          Three concentric layers — outer 32px disc filled with the account
          color (2px stroke visible), a 2px cream/surface ring around the
          inner avatar, then the 24px avatar itself. The cream gap lets the
          color stroke "float" around the favicon.
          The inner avatar prefers the sender's company favicon and falls
          back to colored initials when the domain is generic or the logo
          fails to load. */}
      <div
        className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-full"
        style={accountColor ? { backgroundColor: accountColor } : undefined}
      >
        <Avatar.Root
          className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full bg-white ring-2 ring-surface"
        >
          <SenderLogo email={latestEmail?.fromAddress} alt={senderName} />
          <Avatar.Fallback
            className={cn(
              'flex h-full w-full items-center justify-center rounded-full text-[9px] font-bold',
              avatarColor.bg,
              avatarColor.text,
            )}
            delayMs={300}
          >
            {getInitials(senderName)}
          </Avatar.Fallback>
        </Avatar.Root>
      </div>

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
            <span className="shrink-0 rounded bg-surface px-1 py-0.5 text-[10px] text-text-tertiary">
              {thread.messageCount}
            </span>
          )}
        </div>
        <p className="overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-text-tertiary">
          {latestEmail?.snippet || ''}
        </p>
        {/* Badges */}
        {(commentCount > 0 || thread.isStarred || classification || thread.hasDraft || thread.snoozedUntil) && (
          <div className="mt-0.5 flex items-center gap-1.5">
            {thread.snoozedUntil && (
              <span className="flex items-center gap-0.5 rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-600">
                <Clock className="h-2.5 w-2.5" />
                {formatRelativeTime(thread.snoozedUntil)}
              </span>
            )}
            {thread.hasDraft && (
              <span className="rounded bg-amber-50 px-1 py-0.5 text-[10px] font-medium text-amber-600">
                Draft
              </span>
            )}
            {classification && (
              <CategoryPill category={classification.category} />
            )}
            {commentCount > 0 && (
              <span className="rounded bg-comments-bg px-1 py-0.5 text-[10px] font-medium text-amber-600">
                {commentCount}
              </span>
            )}
            {thread.isStarred && (
              <Star className="h-2.5 w-2.5 fill-yellow-400 text-yellow-400" />
            )}
          </div>
        )}
      </div>


      {/* Hover quick actions — desktop only */}
      {!isMobile && (
        <div className="absolute right-2 top-2.5 flex gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
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
    </button>
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

/**
 * Renders the sender's company logo with a graceful fallback chain.
 * Cycles through providers via Radix's onLoadingStatusChange (the underlying
 * <Avatar.Image> uses an internal Image() loader and never fires a plain
 * onError on the rendered <img>). Once all providers fail it returns null
 * and the surrounding <Avatar.Fallback /> takes over with colored initials.
 */
function SenderLogo({ email, alt }: { email?: string | null; alt: string }) {
  const urls = getCompanyLogoUrls(email);
  const [attempt, setAttempt] = useState(0);
  if (urls.length === 0 || attempt >= urls.length) return null;
  return (
    <Avatar.Image
      key={urls[attempt]}
      src={urls[attempt]}
      alt={alt}
      onLoadingStatusChange={(status) => {
        if (status === 'error') setAttempt((i) => i + 1);
      }}
      className="h-full w-full object-contain"
    />
  );
}
