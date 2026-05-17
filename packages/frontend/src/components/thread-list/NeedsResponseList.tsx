import { useMemo } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { ThreadItem } from './ThreadItem';
import { Check, Sparkles, Clock, AlertCircle, Users, AtSign } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { Tooltip } from '../ui/Tooltip';
import { useAccounts } from '../../hooks/useAccounts';

/**
 * Special folder view for "Needs Response" — the AI-curated list of threads
 * the user owes a reply to. Renders two groups (top 5 urgent, divider,
 * next 5 recent) instead of the standard infinite scroll. Each card has a
 * "Done" button (in the email viewer) that fires the dismiss mutation so
 * the user can clear an item without needing to reply / archive / delete.
 *
 * v2 additions:
 *   - Per-account picker chip row at the top
 *   - Deadline pill on each row when the AI extracted a due date
 *   - Hover tooltip with reason + score + flags (CC'd / internal teammate)
 */
export function NeedsResponseList() {
  const settings = useQuery(api.needsResponse.getSettings, {});
  const updateSettings = useMutation(api.needsResponse.updateSettings);
  const { data: accountsData } = useAccounts();
  const data = useQuery(api.needsResponse.list, {});
  const { selectedThreadId, setSelectedThread } = useUiStore();

  const isLoading = data === undefined;
  const urgent = data?.topUrgent ?? [];
  const recent = data?.topRecent ?? [];
  const total = urgent.length + recent.length;
  const accounts = accountsData ?? [];
  const filterIds = useMemo(
    () => new Set((settings?.perAccountFilter ?? []).map((id) => id as string)),
    [settings],
  );
  const showPicker = accounts.length > 1;

  const toggleAccount = async (id: Id<'mailAccounts'>) => {
    if (!settings) return;
    const cur = (settings.perAccountFilter ?? []) as Array<Id<'mailAccounts'>>;
    const has = filterIds.has(id as string);
    let next: Array<Id<'mailAccounts'>>;
    if (has) {
      next = cur.filter((x) => (x as string) !== (id as string));
    } else {
      next = [...cur, id];
    }
    await updateSettings({
      perAccountFilter: next.length === 0 ? null : next,
    });
  };

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      {showPicker && (
        <div className="flex flex-wrap gap-1.5 border-b border-border bg-surface/40 px-3 py-2">
          <button
            onClick={() => {
              if (filterIds.size > 0) {
                void updateSettings({ perAccountFilter: null });
              }
            }}
            className={
              'rounded-full border px-2 py-0.5 text-[10px] transition-colors ' +
              (filterIds.size === 0
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-white text-text-tertiary hover:text-text-primary')
            }
          >
            All
          </button>
          {accounts.map((a) => {
            const id = a.id as Id<'mailAccounts'>;
            const active = filterIds.size > 0 && filterIds.has(id as string);
            return (
              <button
                key={a.id as string}
                onClick={() => void toggleAccount(id)}
                className={
                  'rounded-full border px-2 py-0.5 text-[10px] transition-colors ' +
                  (active
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-white text-text-tertiary hover:text-text-primary')
                }
              >
                {a.displayName || a.email}
              </button>
            );
          })}
        </div>
      )}

      {total === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-50">
            <Check className="h-6 w-6 text-green-500" />
          </div>
          <p className="mt-3 text-sm font-medium text-text-primary">Caught up</p>
          <p className="mt-1 max-w-[260px] text-xs text-text-tertiary">
            Nothing waiting on a reply right now. New asks will show up here automatically.
          </p>
        </div>
      ) : (
        <>
          {urgent.length > 0 && (
            <>
              <SectionHeader icon={<Sparkles className="h-3 w-3" />} label="Priority" hint="Most likely to need you right now" />
              {urgent.map((t: any) => (
                <NeedsResponseRow
                  key={t.id}
                  thread={t}
                  selected={selectedThreadId === t.id}
                  onSelect={() => setSelectedThread(t.id)}
                />
              ))}
            </>
          )}
          {recent.length > 0 && (
            <>
              <SectionHeader icon={<Clock className="h-3 w-3" />} label="Recent" hint="Latest inbound asks" />
              {recent.map((t: any) => (
                <NeedsResponseRow
                  key={t.id}
                  thread={t}
                  selected={selectedThreadId === t.id}
                  onSelect={() => setSelectedThread(t.id)}
                />
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

function SectionHeader({ icon, label, hint }: { icon: React.ReactNode; label: string; hint: string }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-border bg-surface/90 px-4 py-1.5 backdrop-blur">
      <span className="text-text-tertiary">{icon}</span>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-secondary">
        {label}
      </span>
      <span className="text-[10px] text-text-tertiary">·</span>
      <span className="truncate text-[10px] text-text-tertiary">{hint}</span>
    </div>
  );
}

function NeedsResponseRow({
  thread,
  selected,
  onSelect,
}: {
  thread: any;
  selected: boolean;
  onSelect: () => void;
}) {
  const select = (_id: string) => onSelect();
  const reason: string | null = thread.needsResponseReason ?? null;
  const score: number = thread.needsResponseScore ?? thread.needsResponseDisplayScore ?? 0;
  const dueBy: number | null = thread.needsResponseDueBy ?? null;
  const userIsCcd: boolean = thread.needsResponseUserIsCcd === true;
  const isTeamInternal: boolean = thread.needsResponseSenderIsTeamInternal === true;
  const deadlineDescriptor = describeDeadline(dueBy);

  // Tooltip text: short and scannable. Lines join with " · " since the
  // Tooltip primitive expects a plain string.
  const tooltipParts: string[] = [];
  if (reason) tooltipParts.push(reason);
  tooltipParts.push(`Score: ${score}`);
  if (deadlineDescriptor) tooltipParts.push(`Due: ${deadlineDescriptor.label}`);
  if (isTeamInternal) tooltipParts.push('Internal teammate');
  if (userIsCcd) tooltipParts.push("You were CC'd");
  const tooltipContent = tooltipParts.join('  ·  ');

  // Swap the raw email snippet for the AI's one-line reason in this view —
  // the reason is what makes the Needs Response folder useful. The
  // original snippet still surfaces inside the email viewer.
  const threadForRow = reason
    ? {
        ...thread,
        emails:
          thread.emails && thread.emails.length > 0
            ? [
                {
                  ...thread.emails[0],
                  snippet: reason,
                },
                ...thread.emails.slice(1),
              ]
            : thread.emails,
      }
    : thread;

  return (
    <Tooltip content={tooltipContent} side="right" delayDuration={400}>
      <div className="relative">
        <ThreadItem
          thread={threadForRow}
          isSelected={selected}
          isMultiSelected={false}
          onSelect={select}
          onShiftClick={select}
          onCtrlClick={select}
        />
        {/* Inline badge stack: deadline / CC / internal flags. Positioned
            top-right so the row's existing avatar/timestamp slots stay
            untouched. Pointer-events-none so the row click still wins. */}
        <div className="pointer-events-none absolute right-2 top-2 flex items-center gap-1">
          {deadlineDescriptor && (
            <span
              className={
                'flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[9px] font-medium ' +
                deadlineDescriptor.classes
              }
            >
              <AlertCircle className="h-2.5 w-2.5" />
              {deadlineDescriptor.label}
            </span>
          )}
          {userIsCcd && (
            <span className="flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-700">
              <AtSign className="h-2.5 w-2.5" />
              CC
            </span>
          )}
          {isTeamInternal && (
            <span className="flex items-center gap-0.5 rounded-full bg-blue-50 px-1.5 py-0.5 text-[9px] font-medium text-blue-700">
              <Users className="h-2.5 w-2.5" />
              Team
            </span>
          )}
        </div>
      </div>
    </Tooltip>
  );
}

interface DeadlineDescriptor {
  label: string;
  classes: string;
}

function describeDeadline(dueByMs: number | null): DeadlineDescriptor | null {
  if (!dueByMs) return null;
  const diffHours = (dueByMs - Date.now()) / 3_600_000;
  if (diffHours < -24) return null; // Past deadline by more than a day — drop the pill.
  let label: string;
  if (diffHours < 0) label = 'Overdue';
  else if (diffHours < 24) label = `Due in ${Math.max(1, Math.round(diffHours))}h`;
  else if (diffHours < 24 * 7) label = `Due in ${Math.round(diffHours / 24)}d`;
  else label = new Date(dueByMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  let classes: string;
  if (diffHours < 24) classes = 'bg-red-50 text-red-700';
  else if (diffHours < 72) classes = 'bg-orange-50 text-orange-700';
  else classes = 'bg-slate-100 text-slate-600';
  return { label, classes };
}
