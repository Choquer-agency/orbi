import { Activity, Send, Mail, CheckCircle2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';

interface ActivityItem {
  id: string;
  type: 'sent' | 'received' | 'resolved';
  subject: string;
  contactName: string | null;
  contactEmail: string;
  threadId: string;
  timestamp: string;
}

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

const ACTIVITY_ICONS = {
  sent: { icon: Send, color: 'text-emerald-500', bg: 'bg-emerald-50' },
  received: { icon: Mail, color: 'text-sky-500', bg: 'bg-sky-50' },
  resolved: { icon: CheckCircle2, color: 'text-violet-500', bg: 'bg-violet-50' },
} as const;

const ACTIVITY_LABELS = {
  sent: 'Replied to',
  received: 'Received from',
  resolved: 'Resolved task for',
} as const;

export function RecentActivity() {
  const { setSelectedFolder, setSelectedThread } = useUiStore();
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', 'activity'],
    queryFn: () => api.get<{ data: ActivityItem[] }>('/dashboard/activity'),
  });

  const items = data?.data ?? [];

  const navigateToThread = (threadId: string) => {
    setSelectedFolder('inbox');
    setSelectedThread(threadId);
  };

  return (
    <div className="rounded-lg border border-border bg-white px-10 py-8 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50">
          <Activity className="h-4 w-4 text-sky-500" />
        </div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-tertiary">
          Recent Activity
        </h3>
      </div>

      {isLoading ? (
        <div className="mt-5 space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="h-6 w-6 animate-pulse rounded-full bg-surface" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-32 animate-pulse rounded bg-surface" />
                <div className="h-2.5 w-44 animate-pulse rounded bg-surface" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-6 flex flex-col items-center py-4 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-surface">
            <Activity className="h-5 w-5 text-text-tertiary" />
          </div>
          <p className="mt-2 text-[12px] font-medium text-text-secondary">No recent activity</p>
          <p className="mt-0.5 text-[11px] text-text-tertiary">Your email activity will appear here</p>
        </div>
      ) : (
        <div className="mt-4 space-y-1">
          {items.map((item) => {
            const style = ACTIVITY_ICONS[item.type];
            const Icon = style.icon;

            return (
              <button
                key={item.id}
                onClick={() => navigateToThread(item.threadId)}
                className="group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface"
              >
                <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', style.bg)}>
                  <Icon className={cn('h-3.5 w-3.5', style.color)} />
                </div>

                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-text-primary">
                    <span className="text-text-secondary">{ACTIVITY_LABELS[item.type]}</span>{' '}
                    <span className="font-medium">{item.contactName || item.contactEmail}</span>
                  </p>
                  <p className="truncate text-[11px] text-text-tertiary">{item.subject}</p>
                </div>

                <span className="shrink-0 text-[10px] text-text-tertiary">
                  {timeAgo(item.timestamp)}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
