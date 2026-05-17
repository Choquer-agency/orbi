import { Bell } from 'lucide-react';
import { useQuery, useConvexAuth } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';

/**
 * Pure-display unread-inbox counter. No popover, no click action — the bell
 * just shows how many unread threads are sitting in the inbox. Count derives
 * from `threads.unreadCount` (capped at 100 server-side, displays as "99+").
 */
export function UnreadBadge() {
  const { isAuthenticated } = useConvexAuth();
  const result = useQuery(
    api.threads.unreadCount,
    isAuthenticated ? {} : 'skip',
  );
  const count = result?.count ?? 0;

  return (
    <div
      className="relative rounded-lg p-1.5 text-text-secondary"
      aria-label={count === 0 ? 'No unread emails' : `${count} unread emails`}
      title={count === 0 ? 'No unread emails' : `${count} unread`}
    >
      <Bell className="h-4 w-4" />
      {count > 0 && (
        <span className="absolute -right-1 top-0.5 flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-unread px-1 text-[8px] font-medium text-white">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </div>
  );
}
