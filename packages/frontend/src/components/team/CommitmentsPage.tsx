import { useMemo, useState } from 'react';
import {
  ClipboardCheck,
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  RotateCcw,
  X,
  Settings2,
  ExternalLink,
} from 'lucide-react';
import { NavigationDropdown } from '../navigation/NavigationDropdown';
import { useUiStore } from '../../stores/uiStore';
import {
  useMyWorkspace,
  useCommitmentsDashboard,
  useTrackingAccounts,
  useSetCommitmentTracking,
  useCompleteCommitment,
  useReopenCommitment,
  useDismissCommitment,
} from '../../hooks/useWorkspace';
import { reportMutationError } from '../../lib/mutationErrors';
import type { Id } from '@convex/_generated/dataModel';

type Status = 'OPEN' | 'COMPLETED' | 'DISMISSED';

const TABS: Array<{ id: Status; label: string }> = [
  { id: 'OPEN', label: 'Open' },
  { id: 'COMPLETED', label: 'Completed' },
  { id: 'DISMISSED', label: 'Dismissed' },
];

function fmtDate(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: new Date(ms).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

function isOverdue(dueAtHint: number | null): boolean {
  return !!dueAtHint && dueAtHint < Date.now();
}

export function CommitmentsPage() {
  const workspace = useMyWorkspace();
  const enabled = !!workspace;
  const [tab, setTab] = useState<Status>('OPEN');
  const [memberFilter, setMemberFilter] = useState<string>('');
  const [showTracking, setShowTracking] = useState(false);

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

  const enterTeamView = useUiStore((s) => s.enterTeamView);
  const setSelectedThread = useUiStore((s) => s.setSelectedThread);
  const setSelectedFolder = useUiStore((s) => s.setSelectedFolder);

  const filterMembers = useMemo(
    () => (workspace?.members ?? []).filter((m) => m.canView || m.isSelf),
    [workspace],
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

  const openThread = (row: { userId: string; threadId: string; memberName: string | null }) => {
    if (row.userId !== workspace.viewerId) {
      enterTeamView(row.userId, row.memberName);
    } else {
      setSelectedFolder('inbox');
    }
    setSelectedThread(row.threadId);
  };

  const rows = dashboard?.data ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* Header with nav dropdown — the main menu must stay reachable from
          every full-page view. */}
      <div className="border-b border-border px-4 pb-3 pt-[30px]">
        <NavigationDropdown />
      </div>
      <div className="flex-1 overflow-y-auto px-8 pb-10 pt-8">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ClipboardCheck size={20} className="text-primary" />
            <h1 className="text-xl font-bold text-text-primary">Commitments</h1>
          </div>
          <button
            onClick={() => setShowTracking((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-secondary"
          >
            <Settings2 size={13} />
            Tracking settings
          </button>
        </div>
        <p className="mb-5 text-sm text-text-tertiary">
          Client requests coming in and promises going out, tracked per mailbox. Items are
          checked off automatically when a reply tells the client it's done — and nothing
          is ever deleted, just logged with timestamps.
        </p>

        {showTracking && (
          <div className="mb-6 rounded-xl border border-border bg-white p-4">
            <div className="mb-2 text-sm font-semibold text-text-primary">
              Which mailboxes are tracked
            </div>
            <p className="mb-3 text-xs text-text-tertiary">
              Tracking is off by default. Turning it on runs a small AI check on new mail
              in that mailbox (capped at a couple of dollars a day across the whole team).
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
                          {entry.member.isSelf ? 'you' : entry.member.name ?? entry.member.email}
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

        <div className="mb-4 flex items-center justify-between">
          <div className="flex gap-1 rounded-lg bg-surface-secondary p-1">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                  tab === t.id
                    ? 'bg-white text-text-primary shadow-sm'
                    : 'text-text-tertiary hover:text-text-secondary'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
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
        </div>

        {dashboard === undefined ? (
          <div className="py-12 text-center text-sm text-text-tertiary">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-text-tertiary">
            {tab === 'OPEN'
              ? 'Nothing open. New client requests and outgoing promises will appear here once tracking is on.'
              : `No ${tab.toLowerCase()} items yet.`}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((row) => (
              <div
                key={row.id}
                className="group rounded-xl border border-border bg-white px-4 py-3"
              >
                <div className="flex items-start gap-3">
                  <div
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                      row.direction === 'INBOUND'
                        ? 'bg-sky-100 text-sky-600'
                        : 'bg-violet-100 text-violet-600'
                    }`}
                    title={row.direction === 'INBOUND' ? 'Client request' : 'Our promise'}
                  >
                    {row.direction === 'INBOUND' ? (
                      <ArrowDownLeft size={13} />
                    ) : (
                      <ArrowUpRight size={13} />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-text-primary">{row.description}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-text-tertiary">
                      <span>
                        {row.direction === 'INBOUND' ? 'From' : 'To'}{' '}
                        {row.counterpartyName ?? row.counterpartyEmail}
                      </span>
                      <span>• {row.memberName ?? row.memberEmail}</span>
                      <span>• Logged {fmtDate(row.requestedAt)}</span>
                      {row.dueAtHint && tab === 'OPEN' && (
                        <span
                          className={
                            isOverdue(row.dueAtHint) ? 'font-semibold text-red-500' : ''
                          }
                        >
                          • Due {fmtDate(row.dueAtHint)}
                        </span>
                      )}
                      {row.completedAt && (
                        <span className="text-emerald-600">
                          • Completed {fmtDate(row.completedAt)}
                          {row.completionNote ? ` — ${row.completionNote}` : ''}
                        </span>
                      )}
                      {row.dismissedAt && <span>• Dismissed {fmtDate(row.dismissedAt)}</span>}
                    </div>
                    <button
                      onClick={() => openThread(row)}
                      className="mt-1 flex items-center gap-1 text-[11px] font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100"
                    >
                      <ExternalLink size={11} />
                      {row.threadSubject}
                    </button>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    {tab === 'OPEN' ? (
                      <>
                        <button
                          title="Mark done"
                          onClick={() =>
                            complete({ commitmentId: row.id as Id<'commitments'> }).catch(
                              (err) => reportMutationError(err),
                            )
                          }
                          className="rounded-lg p-1.5 text-emerald-600 hover:bg-emerald-50"
                        >
                          <Check size={15} />
                        </button>
                        <button
                          title="Dismiss (not a real request)"
                          onClick={() =>
                            dismiss({ commitmentId: row.id as Id<'commitments'> }).catch(
                              (err) => reportMutationError(err),
                            )
                          }
                          className="rounded-lg p-1.5 text-text-tertiary hover:bg-surface-secondary"
                        >
                          <X size={15} />
                        </button>
                      </>
                    ) : (
                      <button
                        title="Reopen"
                        onClick={() =>
                          reopen({ commitmentId: row.id as Id<'commitments'> }).catch((err) =>
                            reportMutationError(err),
                          )
                        }
                        className="rounded-lg p-1.5 text-text-tertiary hover:bg-surface-secondary"
                      >
                        <RotateCcw size={15} />
                      </button>
                    )}
                  </div>
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
