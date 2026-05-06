import { Clock, Target } from 'lucide-react';
import { useDashboardMetrics } from '../../hooks/useDashboard';

const TARGET_MINUTES = 8 * 60; // 8 hours

function formatDuration(minutes: number): string {
  if (minutes < 1) return '< 1m';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function ResponseTimeCard() {
  const { data, isLoading } = useDashboardMetrics();

  const isOnTarget = data ? data.averageMinutes <= TARGET_MINUTES : false;

  return (
    <div className="rounded-lg border border-border bg-white p-7 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
          <Clock className="h-4 w-4 text-primary" />
        </div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-tertiary">
          Avg. Response Time
        </h3>
      </div>

      {isLoading ? (
        <div className="mt-5 flex items-end gap-3">
          <div className="h-9 w-24 animate-pulse rounded-lg bg-surface" />
          <div className="mb-1 h-4 w-16 animate-pulse rounded bg-surface" />
        </div>
      ) : !data || data.totalReplies === 0 ? (
        <div className="mt-5">
          <p className="text-[28px] font-light tracking-tight text-text-tertiary">—</p>
          <p className="mt-2 text-[12px] text-text-tertiary">No reply data yet</p>
        </div>
      ) : (
        <>
          <div className="mt-5 flex items-end gap-3">
            <span className={`text-[32px] font-light leading-none tracking-tight ${isOnTarget ? 'text-green-600' : 'text-red-500'}`}>
              {formatDuration(data.averageMinutes)}
            </span>
            <span className={`mb-1 flex items-center gap-1 text-[12px] ${isOnTarget ? 'text-green-600' : 'text-red-400'}`}>
              <Target className="h-3 w-3" />
              Target time: 8 hours
            </span>
          </div>
          <p className="mt-3 text-[12px] text-text-tertiary">
            Based on {data.totalReplies} {data.totalReplies === 1 ? 'reply' : 'replies'} you sent
          </p>
        </>
      )}
    </div>
  );
}
