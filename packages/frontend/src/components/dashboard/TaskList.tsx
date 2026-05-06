import { useState } from 'react';
import { CheckSquare, Square, Check, ExternalLink } from 'lucide-react';
import { useDashboardTasks, useToggleTask } from '../../hooks/useDashboard';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';

const TYPE_STYLES: Record<string, { label: string; className: string }> = {
  PROMISE: { label: 'Promise', className: 'bg-violet-50 text-violet-600' },
  DEADLINE: { label: 'Deadline', className: 'bg-red-50 text-red-600' },
  CHANGE_REQUEST: { label: 'Change', className: 'bg-amber-50 text-amber-600' },
  ACTION_ITEM: { label: 'Action', className: 'bg-sky-50 text-sky-600' },
};

function formatDeadline(deadline: string | null): { text: string; urgency: 'overdue' | 'today' | 'upcoming' | 'none' } | null {
  if (!deadline) return null;
  const d = new Date(deadline);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000);

  if (diffDays < 0) return { text: `${Math.abs(diffDays)}d overdue`, urgency: 'overdue' };
  if (diffDays === 0) return { text: 'Due today', urgency: 'today' };
  if (diffDays === 1) return { text: 'Due tomorrow', urgency: 'upcoming' };
  return {
    text: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    urgency: diffDays <= 3 ? 'upcoming' : 'none',
  };
}

export function TaskList() {
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const { data, isLoading } = useDashboardTasks(tab);
  const toggleTask = useToggleTask();
  const { setSelectedFolder, setSelectedThread, setHighlightText } = useUiStore();
  const tasks = data?.data ?? [];

  const navigateToThread = (threadId: string, highlightText?: string) => {
    setSelectedFolder('inbox');
    setSelectedThread(threadId);
    if (highlightText) setHighlightText(highlightText);
  };

  return (
    <div className="rounded-lg border border-border bg-white px-10 py-8 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-50">
          <CheckSquare className="h-4 w-4 text-violet-500" />
        </div>
        <h3 className="text-[12px] font-semibold uppercase tracking-wider text-text-tertiary">
          Tasks
        </h3>
        {tab === 'open' && tasks.length > 0 && (
          <span className="ml-auto rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-600">
            {data?.total ?? tasks.length}
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="mt-4 flex gap-1">
        <button
          onClick={() => setTab('open')}
          className={cn(
            'rounded-lg px-3 py-1 text-[11px] font-medium transition-colors',
            tab === 'open'
              ? 'bg-selected text-primary'
              : 'text-text-secondary hover:bg-surface hover:text-text-primary',
          )}
        >
          Open
        </button>
        <button
          onClick={() => setTab('done')}
          className={cn(
            'rounded-lg px-3 py-1 text-[11px] font-medium transition-colors',
            tab === 'done'
              ? 'bg-selected text-primary'
              : 'text-text-secondary hover:bg-surface hover:text-text-primary',
          )}
        >
          Done
        </button>
      </div>

      {isLoading ? (
        <div className="mt-4 space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="h-4 w-4 animate-pulse rounded bg-surface" />
              <div className="h-3 w-48 animate-pulse rounded bg-surface" />
            </div>
          ))}
        </div>
      ) : tasks.length === 0 ? (
        <div className="mt-4 flex flex-col items-center py-4 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-50">
            <Check className="h-5 w-5 text-emerald-500" />
          </div>
          <p className="mt-2 text-[12px] font-medium text-text-secondary">
            {tab === 'open' ? 'No open tasks' : 'No completed tasks'}
          </p>
          <p className="mt-0.5 text-[11px] text-text-tertiary">
            {tab === 'open' ? 'Tasks extracted from emails will appear here' : 'Completed tasks will show here'}
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-0.5">
          {tasks.map((task) => {
            const typeStyle = TYPE_STYLES[task.taskType] || TYPE_STYLES.ACTION_ITEM;
            const deadline = formatDeadline(task.deadline);
            const isDone = task.status !== 'OPEN';

            return (
              <div
                key={task.id}
                className="group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-surface"
              >
                <button
                  onClick={() =>
                    toggleTask.mutate({
                      id: task.id,
                      status: isDone ? 'OPEN' : 'DONE',
                    })
                  }
                  className="mt-0.5 shrink-0 text-text-tertiary transition-colors hover:text-primary"
                >
                  {isDone ? (
                    <CheckSquare className="h-4 w-4 text-emerald-500" />
                  ) : (
                    <Square className="h-4 w-4" />
                  )}
                </button>

                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      'text-[12px] leading-snug',
                      isDone
                        ? 'text-text-tertiary line-through'
                        : 'text-text-primary',
                    )}
                  >
                    {task.description}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                        typeStyle.className,
                      )}
                    >
                      {typeStyle.label}
                    </span>
                    {deadline && (
                      <span
                        className={cn(
                          'text-[10px] font-medium',
                          deadline.urgency === 'overdue' && 'text-red-600',
                          deadline.urgency === 'today' && 'text-amber-600',
                          deadline.urgency === 'upcoming' && 'text-text-secondary',
                          deadline.urgency === 'none' && 'text-text-tertiary',
                        )}
                      >
                        {deadline.text}
                      </span>
                    )}
                    {task.contactName && (
                      <span className="text-[10px] text-text-tertiary">
                        {task.contactName}
                      </span>
                    )}
                    {task.status === 'AUTO_RESOLVED' && (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600">
                        Auto-resolved
                      </span>
                    )}
                  </div>
                </div>

                <button
                  onClick={() => navigateToThread(task.threadId, task.description)}
                  className="mt-0.5 shrink-0 rounded-lg p-1 text-text-tertiary opacity-0 transition-all hover:bg-white hover:text-primary group-hover:opacity-100"
                  title="Go to thread"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
