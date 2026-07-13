import { useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  ClipboardCheck,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  RotateCcw,
  X,
  Settings2,
  Reply,
  Clock,
  OctagonAlert,
} from 'lucide-react';
import { NavigationDropdown } from '../navigation/NavigationDropdown';
import { Tooltip } from '../ui/Tooltip';
import { useUiStore } from '../../stores/uiStore';
import {
  useMyWorkspace,
  useCommitmentsDashboard,
  useTrackingAccounts,
  useSetCommitmentTracking,
  useCompleteCommitment,
  useReopenCommitment,
  useDismissCommitment,
  useSetCommitmentStuck,
  useSnoozeCommitment,
} from '../../hooks/useWorkspace';
import { reportMutationError } from '../../lib/mutationErrors';
import { cn } from '../../lib/utils';
import type { Id } from '@convex/_generated/dataModel';

type Status = 'OPEN' | 'COMPLETED' | 'DISMISSED';

const TABS: Array<{ id: Status; label: string }> = [
  { id: 'OPEN', label: 'Open' },
  { id: 'COMPLETED', label: 'Completed' },
  { id: 'DISMISSED', label: 'Dismissed' },
];

interface Row {
  id: string;
  userId: string;
  threadId: string;
  direction: 'INBOUND' | 'OUTBOUND';
  description: string;
  counterpartyEmail: string;
  counterpartyName: string | null;
  requestedAt: number;
  dueAtHint: number | null;
  status: Status;
  completedAt: number | null;
  completionNote: string | null;
  dismissedAt: number | null;
  isStuck: boolean;
  snoozedUntil: number | null;
  threadSubject: string;
  memberName: string | null;
  memberEmail: string | null;
}

function fmtDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function dayLabel(ms: number): string {
  const today = startOfDay(Date.now());
  const day = startOfDay(ms);
  if (day === today) return 'Today';
  if (day === today - 86_400_000) return 'Yesterday';
  return fmtDate(ms);
}

// Group OPEN rows Notion-style: what needs attention first.
function groupOpen(rows: Row[]): Array<{ label: string; rows: Row[]; muted?: boolean }> {
  const now = Date.now();
  const todayStart = startOfDay(now);
  const tomorrowStart = todayStart + 86_400_000;
  const snoozed: Row[] = [];
  const overdue: Row[] = [];
  const today: Row[] = [];
  const upcoming: Row[] = [];
  const noDue: Row[] = [];
  for (const r of rows) {
    if (r.snoozedUntil && r.snoozedUntil > now) snoozed.push(r);
    else if (r.dueAtHint && r.dueAtHint < todayStart) overdue.push(r);
    else if (r.dueAtHint && r.dueAtHint < tomorrowStart) today.push(r);
    else if (r.dueAtHint) upcoming.push(r);
    else noDue.push(r);
  }
  return [
    { label: 'Overdue', rows: overdue },
    { label: 'Today', rows: today },
    { label: 'Upcoming', rows: upcoming },
    { label: 'No deadline', rows: noDue },
    { label: 'Snoozed', rows: snoozed, muted: true },
  ].filter((g) => g.rows.length > 0);
}

// Group closed rows by the day they were completed/dismissed.
function groupClosed(rows: Row[]): Array<{ label: string; rows: Row[] }> {
  const byDay = new Map<number, Row[]>();
  for (const r of rows) {
    const ts = r.completedAt ?? r.dismissedAt ?? r.requestedAt;
    const day = startOfDay(ts);
    const list = byDay.get(day) ?? [];
    list.push(r);
    byDay.set(day, list);
  }
  return Array.from(byDay.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([day, list]) => ({ label: dayLabel(day), rows: list }));
}

export function CommitmentsPage() {
  const workspace = useMyWorkspace();
  const enabled = !!workspace;
  const [tab, setTab] = useState<Status>('OPEN');
  const [memberFilter, setMemberFilter] = useState<string>('');
  const [showTracking, setShowTracking] = useState(false);
  // Checked-circle animation: ids ticked locally so the circle fills before
  // the reactive query removes the row from the Open tab.
  const [justDone, setJustDone] = useState<Set<string>>(new Set());

  const dashboard = useCommitmentsDashboard({
    status: tab,
    memberUserId: memberFilter ? (memberFilter as Id<'users'>) : undefined,
    enabled,
  });
  const trackingAccounts = useTrackingAccounts(enabled && showTracking);
  const setTracking = useSetCommitmentTracking();
  const complete = useCompleteCommitment();
  const reopen = useReopenCommitment();
  const dismiss = useDismissCommitment();
  const setStuck = useSetCommitmentStuck();
  const snooze = useSnoozeCommitment();

  const enterTeamView = useUiStore((s) => s.enterTeamView);
  const setSelectedThread = useUiStore((s) => s.setSelectedThread);
  const setSelectedFolder = useUiStore((s) => s.setSelectedFolder);
  const setPendingReplyMode = useUiStore((s) => s.setPendingReplyMode);

  const filterMembers = useMemo(
    () => (workspace?.members ?? []).filter((m) => m.canView || m.isSelf),
    [workspace],
  );

  const rows = (dashboard?.data ?? []) as Row[];
  const groups = useMemo(
    () => (tab === 'OPEN' ? groupOpen(rows) : groupClosed(rows)),
    [rows, tab],
  );

  if (workspace === undefined || workspace === null) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-4 pb-3 pt-[30px]">
          <NavigationDropdown />
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">
          {workspace === undefined
            ? 'Loading…'
            : "Team features aren't enabled for this account."}
        </div>
      </div>
    );
  }

  const openThread = (row: Row, replyNow = false) => {
    if (row.userId !== workspace.viewerId) {
      enterTeamView(row.userId, row.memberName);
    } else {
      setSelectedFolder('inbox');
    }
    setSelectedThread(row.threadId);
    if (replyNow) setPendingReplyMode('reply');
  };

  const markDone = (row: Row) => {
    setJustDone((prev) => new Set(prev).add(row.id));
    complete({ commitmentId: row.id as Id<'commitments'> }).catch((err) =>
      reportMutationError(err),
    );
  };

  const snoozeOptions = () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const threeDays = new Date(now);
    threeDays.setDate(threeDays.getDate() + 3);
    threeDays.setHours(9, 0, 0, 0);
    const nextWeek = new Date(now);
    nextWeek.setDate(nextWeek.getDate() + 7);
    nextWeek.setHours(9, 0, 0, 0);
    return [
      { label: 'Tomorrow', until: tomorrow.getTime() },
      { label: 'In 3 days', until: threeDays.getTime() },
      { label: 'Next week', until: nextWeek.getTime() },
    ];
  };

  const renderRow = (row: Row, muted: boolean) => {
    const done = tab === 'COMPLETED' || justDone.has(row.id);
    return (
      <div
        key={row.id}
        className={cn(
          'group flex items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface',
          muted && 'opacity-55',
        )}
      >
        {/* Circle checkbox */}
        <Tooltip
          side="top"
          content={
            tab === 'OPEN'
              ? 'Mark done — logs it as completed with today’s date'
              : 'Put this back on the Open list'
          }
        >
          <button
            onClick={() => {
              if (tab === 'OPEN') markDone(row);
              else
                reopen({ commitmentId: row.id as Id<'commitments'> }).catch((err) =>
                  reportMutationError(err),
                );
            }}
            className={cn(
              'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px] transition-all',
              done
                ? 'border-primary bg-primary text-white'
                : 'border-text-tertiary/50 text-transparent hover:border-primary hover:text-primary/40',
            )}
          >
            <Check size={11} strokeWidth={3} />
          </button>
        </Tooltip>

        {/* Text — clickable to open the email */}
        <button
          onClick={() => openThread(row)}
          className="min-w-0 flex-1 text-left"
        >
          <span
            className={cn(
              'text-sm leading-snug text-text-primary',
              done && 'text-text-tertiary line-through',
            )}
          >
            {row.description}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-text-tertiary">
            <span
              className={cn(
                'inline-flex items-center gap-0.5',
                row.direction === 'INBOUND' ? 'text-sky-600' : 'text-violet-600',
              )}
            >
              {row.direction === 'INBOUND' ? (
                <ArrowDownLeft size={10} />
              ) : (
                <ArrowUpRight size={10} />
              )}
              {row.counterpartyName ?? row.counterpartyEmail}
            </span>
            <span>· {row.memberName ?? row.memberEmail}</span>
            {tab === 'OPEN' && row.dueAtHint && (
              <span
                className={cn(
                  row.dueAtHint < Date.now() && 'font-semibold text-red-500',
                )}
              >
                · due {fmtDate(row.dueAtHint)}
              </span>
            )}
            {row.isStuck && tab === 'OPEN' && (
              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-px font-medium text-amber-700">
                <OctagonAlert size={9} /> Stuck
              </span>
            )}
            {row.snoozedUntil && row.snoozedUntil > Date.now() && (
              <span>· reminds {fmtDate(row.snoozedUntil)}</span>
            )}
            {row.completedAt && (
              <span className="text-emerald-600">
                · done {fmtDate(row.completedAt)}
                {row.completionNote ? ` — ${row.completionNote}` : ''}
              </span>
            )}
            {row.dismissedAt && <span>· dismissed {fmtDate(row.dismissedAt)}</span>}
          </span>
        </button>

        {/* Hover actions */}
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {tab === 'OPEN' ? (
            <>
              <Tooltip side="top" content="Reply — opens the email with a reply ready to write">
                <button
                  onClick={() => openThread(row, true)}
                  className="rounded-md p-1.5 text-text-tertiary hover:bg-white hover:text-primary"
                >
                  <Reply size={14} />
                </button>
              </Tooltip>
              <Tooltip
                side="top"
                content={
                  row.isStuck
                    ? 'Remove the Stuck flag'
                    : 'Mark as stuck — flags it so you know it’s blocked'
                }
              >
                <button
                  onClick={() =>
                    setStuck({
                      commitmentId: row.id as Id<'commitments'>,
                      stuck: !row.isStuck,
                    }).catch((err) => reportMutationError(err))
                  }
                  className={cn(
                    'rounded-md p-1.5 hover:bg-white',
                    row.isStuck
                      ? 'text-amber-600'
                      : 'text-text-tertiary hover:text-amber-600',
                  )}
                >
                  <OctagonAlert size={14} />
                </button>
              </Tooltip>
              <DropdownMenu.Root>
                <Tooltip side="top" content="Remind me later — hides it until it pops back up">
                  <DropdownMenu.Trigger asChild>
                    <button className="rounded-md p-1.5 text-text-tertiary hover:bg-white hover:text-primary">
                      <Clock size={14} />
                    </button>
                  </DropdownMenu.Trigger>
                </Tooltip>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="z-50 w-[150px] rounded-lg border border-border bg-white p-1 shadow-lg"
                    sideOffset={4}
                    align="end"
                  >
                    {snoozeOptions().map((opt) => (
                      <DropdownMenu.Item
                        key={opt.label}
                        onSelect={() =>
                          snooze({
                            commitmentId: row.id as Id<'commitments'>,
                            until: opt.until,
                          }).catch((err) => reportMutationError(err))
                        }
                        className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-text-primary outline-none hover:bg-surface"
                      >
                        {opt.label}
                      </DropdownMenu.Item>
                    ))}
                    {row.snoozedUntil && row.snoozedUntil > Date.now() && (
                      <DropdownMenu.Item
                        onSelect={() =>
                          snooze({
                            commitmentId: row.id as Id<'commitments'>,
                          }).catch((err) => reportMutationError(err))
                        }
                        className="cursor-pointer rounded-md px-2.5 py-1.5 text-xs text-text-tertiary outline-none hover:bg-surface"
                      >
                        Wake up now
                      </DropdownMenu.Item>
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
              <Tooltip
                side="top"
                content="Dismiss — not a real request; kept in the Dismissed tab"
              >
                <button
                  onClick={() =>
                    dismiss({ commitmentId: row.id as Id<'commitments'> }).catch(
                      (err) => reportMutationError(err),
                    )
                  }
                  className="rounded-md p-1.5 text-text-tertiary hover:bg-white hover:text-red-500"
                >
                  <X size={14} />
                </button>
              </Tooltip>
            </>
          ) : (
            <Tooltip side="top" content="Reopen — put this back on the Open list">
              <button
                onClick={() =>
                  reopen({ commitmentId: row.id as Id<'commitments'> }).catch((err) =>
                    reportMutationError(err),
                  )
                }
                className="rounded-md p-1.5 text-text-tertiary hover:bg-white hover:text-primary"
              >
                <RotateCcw size={14} />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header with nav dropdown — the main menu must stay reachable from
          every full-page view. */}
      <div className="border-b border-border px-4 pb-3 pt-[30px]">
        <NavigationDropdown />
      </div>
      <div className="flex-1 overflow-y-auto px-8 pb-10 pt-8">
        <div className="mx-auto w-full max-w-3xl">
          <div className="mb-1 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ClipboardCheck size={20} className="text-primary" />
              <h1 className="text-xl font-bold text-text-primary">Commitments</h1>
            </div>
            <div className="flex items-center gap-2">
              {filterMembers.length > 1 && (
                <select
                  value={memberFilter}
                  onChange={(e) => setMemberFilter(e.target.value)}
                  className="rounded-lg border border-border bg-white px-2 py-1.5 text-xs text-text-primary"
                >
                  <option value="">Everyone</option>
                  {filterMembers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.isSelf ? 'Me' : m.name ?? m.email}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={() => setShowTracking((v) => !v)}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface"
              >
                <Settings2 size={13} />
                Tracking
              </button>
            </div>
          </div>
          <p className="mb-5 text-sm text-text-tertiary">
            Client requests in, promises out — checked off automatically when a reply says
            it's done. Nothing is deleted, only logged.
          </p>

          {showTracking && (
            <div className="mb-6 rounded-xl border border-border bg-white p-4">
              <div className="mb-2 text-sm font-semibold text-text-primary">
                Which mailboxes are tracked
              </div>
              <p className="mb-3 text-xs text-text-tertiary">
                Tracking is off by default. Turning it on runs a small AI check on new
                mail in that mailbox (capped at a couple of dollars a day across the
                whole team).
              </p>
              {trackingAccounts === undefined ? (
                <div className="text-xs text-text-tertiary">Loading accounts…</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {trackingAccounts.map((entry) =>
                    entry.accounts.map((a) => (
                      <label
                        key={a.id}
                        className="flex cursor-pointer items-center justify-between rounded-lg border border-border px-3 py-2"
                      >
                        <span className="text-sm text-text-primary">
                          {a.email}
                          <span className="ml-2 text-xs text-text-tertiary">
                            {entry.member.isSelf
                              ? 'you'
                              : entry.member.name ?? entry.member.email}
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={a.commitmentTrackingEnabled}
                          onChange={(e) =>
                            setTracking({
                              accountId: a.id as Id<'mailAccounts'>,
                              enabled: e.target.checked,
                            }).catch((err) => reportMutationError(err))
                          }
                          className="h-4 w-4 accent-primary"
                        />
                      </label>
                    )),
                  )}
                </div>
              )}
            </div>
          )}

          <div className="mb-6 flex gap-1 rounded-lg bg-surface p-1 w-fit">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  'rounded-md px-3 py-1 text-xs font-medium transition-colors',
                  tab === t.id
                    ? 'bg-white text-text-primary shadow-sm'
                    : 'text-text-tertiary hover:text-text-secondary',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {dashboard === undefined ? (
            <div className="py-12 text-center text-sm text-text-tertiary">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-text-tertiary">
              {tab === 'OPEN'
                ? 'Nothing open. New client requests and outgoing promises will appear here.'
                : `No ${tab.toLowerCase()} items yet.`}
            </div>
          ) : (
            <div className="flex flex-col gap-7">
              {groups.map((g) => (
                <div key={g.label}>
                  <h2
                    className={cn(
                      'mb-1.5 px-2 text-sm font-bold',
                      g.label === 'Overdue' ? 'text-red-500' : 'text-text-primary',
                    )}
                  >
                    {g.label}
                  </h2>
                  <div className="flex flex-col">
                    {g.rows.map((row) => renderRow(row, !!(g as { muted?: boolean }).muted))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
