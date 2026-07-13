import { useMemo, type ReactElement } from 'react';
import { Users, Mail, Crown, ChevronRight } from 'lucide-react';
import { NavigationDropdown } from '../navigation/NavigationDropdown';
import { useUiStore } from '../../stores/uiStore';
import { useMyWorkspace, useSetManager } from '../../hooks/useWorkspace';
import { getAvatarColor } from '../../lib/constants';
import { reportMutationError } from '../../lib/mutationErrors';
import type { Id } from '@convex/_generated/dataModel';

interface Member {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  role: string;
  managerUserId: string | null;
  canView: boolean;
  isSelf: boolean;
}

function MemberAvatar({ member, size = 'md' }: { member: Member; size?: 'md' | 'sm' }) {
  const label = member.name ?? member.email ?? '?';
  const color = getAvatarColor(label);
  const cls = size === 'md' ? 'h-10 w-10 text-sm' : 'h-7 w-7 text-xs';
  return member.avatarUrl ? (
    <img src={member.avatarUrl} alt={label} className={`${cls} rounded-full object-cover`} />
  ) : (
    <div className={`${cls} flex items-center justify-center rounded-full font-semibold ${color.bg} ${color.text}`}>
      {label.slice(0, 1).toUpperCase()}
    </div>
  );
}

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  AGENT: 'Standard',
};

export function TeamHubPage() {
  const workspace = useMyWorkspace();
  const setManager = useSetManager();
  const enterTeamView = useUiStore((s) => s.enterTeamView);

  const members = (workspace?.members ?? []) as Member[];
  const ownerId = workspace?.ownerUserId as string | undefined;
  const viewerIsOwner = workspace?.viewerIsOwner === true;

  // Group into a simple two-level tree: owner → top-level members →
  // their reports. (Deeper chains still work — they render under their
  // direct manager.)
  const byManager = useMemo(() => {
    const map = new Map<string, Member[]>();
    for (const m of members) {
      if (!m.managerUserId) continue;
      const list = map.get(m.managerUserId) ?? [];
      list.push(m);
      map.set(m.managerUserId, list);
    }
    return map;
  }, [members]);

  const topLevel = useMemo(
    () =>
      members.filter(
        (m) => m.id !== ownerId && (!m.managerUserId || m.managerUserId === ownerId),
      ),
    [members, ownerId],
  );
  const owner = members.find((m) => m.id === ownerId);

  if (workspace === undefined || workspace === null) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-4 pb-3 pt-[30px]">
          <NavigationDropdown />
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-text-tertiary">
          {workspace === undefined
            ? 'Loading team…'
            : "Team features aren't enabled for this account."}
        </div>
      </div>
    );
  }

  const handleManagerChange = (memberId: string, managerId: string) => {
    setManager({
      memberUserId: memberId as Id<'users'>,
      ...(managerId ? { managerUserId: managerId as Id<'users'> } : {}),
    }).catch((err) => reportMutationError(err));
  };

  const managerOptions = members.filter((m) => m.role !== 'AGENT' || m.id === ownerId);

  const renderCard = (m: Member, depth: number): ReactElement => (
    <div key={m.id} className="flex flex-col gap-2">
      <div
        className="flex items-center gap-3 rounded-xl border border-border bg-white px-4 py-3"
        style={depth > 0 ? { marginLeft: depth * 40 } : undefined}
      >
        <MemberAvatar member={m} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-text-primary">
              {m.name ?? m.email}
            </span>
            {m.id === ownerId && <Crown size={13} className="shrink-0 text-amber-500" />}
            {m.isSelf && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                You
              </span>
            )}
            <span className="rounded-full bg-surface-secondary px-2 py-0.5 text-[10px] text-text-tertiary">
              {ROLE_LABELS[m.role] ?? m.role}
            </span>
          </div>
          <div className="truncate text-xs text-text-tertiary">{m.email}</div>
        </div>

        {viewerIsOwner && !m.isSelf && m.id !== ownerId && (
          <label className="flex items-center gap-1.5 text-xs text-text-tertiary">
            Reports to
            <select
              className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-text-primary"
              value={m.managerUserId ?? ownerId ?? ''}
              onChange={(e) => handleManagerChange(m.id, e.target.value)}
            >
              {managerOptions
                .filter((opt) => opt.id !== m.id)
                .map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.name ?? opt.email}
                  </option>
                ))}
            </select>
          </label>
        )}

        {m.canView && !m.isSelf ? (
          <button
            onClick={() => enterTeamView(m.id, m.name ?? m.email)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            <Mail size={13} />
            Open inbox
            <ChevronRight size={13} />
          </button>
        ) : null}
      </div>
      {/* Direct reports render nested under their manager (owner's direct
          reports are the top level, so they're rendered by the caller). */}
      {m.id !== ownerId &&
        (byManager.get(m.id) ?? []).map((child) => renderCard(child, depth + 1))}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header with nav dropdown — the main menu must stay reachable from
          every full-page view. */}
      <div className="border-b border-border px-4 pb-3 pt-[30px]">
        <NavigationDropdown />
      </div>
      <div className="flex-1 overflow-y-auto px-8 pb-10 pt-8">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-1 flex items-center gap-2">
          <Users size={20} className="text-primary" />
          <h1 className="text-xl font-bold text-text-primary">{workspace.name} — Team</h1>
        </div>
        <p className="mb-6 text-sm text-text-tertiary">
          Open a teammate's inbox to read and reply on their threads. Replies always send
          from <span className="font-medium">your</span> email address, and browsing never
          marks their mail as read.
        </p>

        <div className="flex flex-col gap-2">
          {owner && renderCard(owner, 0)}
          {topLevel.map((m) => renderCard(m, 0))}
        </div>

        {members.length <= 1 && (
          <div className="mt-8 rounded-xl border border-dashed border-border p-6 text-center text-sm text-text-tertiary">
            No teammates yet — invite people from Settings → Team.
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
