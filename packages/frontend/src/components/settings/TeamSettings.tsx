import { useState } from 'react';
import { Users, Mail, Loader2, Trash2, ShieldCheck } from 'lucide-react';
import { useQuery, useMutation } from 'convex/react';
import { api as convexApi } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import toast from 'react-hot-toast';

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Admin',
  MANAGER: 'Manager',
  AGENT: 'Standard',
};

// Team management: members + roles + invite-only sign-up.
// Invites send a real email from the admin's own mailbox; signing up with
// the invited address consumes the invite and applies the role (enforced in
// convex/auth.ts — uninvited sign-ups are rejected outright).
export function TeamSettings() {
  const team = useQuery(convexApi.team.listMembers, {});
  const isAdmin = team?.viewerIsAdmin ?? false;
  const invites = useQuery(
    convexApi.team.listInvites,
    isAdmin ? {} : 'skip',
  );
  const inviteMutation = useMutation(convexApi.team.invite);
  const revokeMutation = useMutation(convexApi.team.revokeInvite);
  const setRoleMutation = useMutation(convexApi.team.setRole);
  const removeMutation = useMutation(convexApi.team.removeMember);
  // Two-click confirm: first click arms, second click removes.
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'MANAGER' | 'AGENT'>('AGENT');
  const [inviting, setInviting] = useState(false);

  const handleInvite = async () => {
    const email = inviteEmail.trim();
    if (!email.includes('@')) {
      toast.error('Enter a valid email address');
      return;
    }
    setInviting(true);
    try {
      await inviteMutation({ email, role: inviteRole });
      toast.success(`Invite sent to ${email}`);
      setInviteEmail('');
    } catch (err: any) {
      toast.error(err?.message?.includes('already a team member')
        ? `${email} is already on the team`
        : err?.message || 'Invite failed');
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (userId: string, role: string) => {
    try {
      await setRoleMutation({
        userId: userId as Id<'users'>,
        role: role as 'ADMIN' | 'MANAGER' | 'AGENT',
      });
      toast.success('Role updated');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update role');
    }
  };

  const handleRemove = async (userId: string, label: string) => {
    if (confirmRemoveId !== userId) {
      setConfirmRemoveId(userId);
      setTimeout(() => setConfirmRemoveId((c) => (c === userId ? null : c)), 4000);
      return;
    }
    setConfirmRemoveId(null);
    try {
      await removeMutation({ userId: userId as Id<'users'> });
      toast.success(`${label} removed from the team`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to remove member');
    }
  };

  const handleRevoke = async (id: string) => {
    try {
      await revokeMutation({ id: id as Id<'teamInvites'> });
      toast.success('Invite revoked');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to revoke');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Users className="h-4 w-4 text-text-secondary" />
        <h3 className="text-[13px] font-semibold text-text-primary">Team</h3>
      </div>

      {/* Invite form (admins only) */}
      {isAdmin && (
        <div className="space-y-2">
          <p className="text-[11px] leading-relaxed text-text-tertiary">
            Sign-up is invite-only. Invitees get an email (sent from your
            mailbox) with instructions to join — they must register with the
            invited address.
          </p>
          <div className="flex gap-2">
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
              placeholder="teammate@yourcompany.com"
              className="min-w-0 flex-1 rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
            />
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}
              className="rounded-lg border border-border bg-white px-2 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none"
            >
              <option value="AGENT">Standard</option>
              <option value="MANAGER">Manager</option>
              <option value="ADMIN">Admin</option>
            </select>
            <button
              onClick={handleInvite}
              disabled={inviting || !inviteEmail.includes('@')}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {inviting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
              Invite
            </button>
          </div>
        </div>
      )}

      {/* Pending invites */}
      {isAdmin && (invites?.length ?? 0) > 0 && (
        <div className="space-y-1.5">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
            Pending invites
          </h4>
          {invites!.map((inv) => (
            <div
              key={inv.id}
              className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2"
            >
              <Mail className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">
                {inv.email}
              </span>
              <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                {ROLE_LABELS[inv.role] ?? inv.role}
              </span>
              <button
                onClick={() => handleRevoke(inv.id)}
                className="rounded p-1 text-text-tertiary hover:bg-red-50 hover:text-red-600"
                title="Revoke invite"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Members */}
      <div className="space-y-1.5">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
          Members
        </h4>
        {(team?.members ?? []).map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-2.5 rounded-lg border border-border px-3 py-2"
          >
            {m.avatarUrl ? (
              <img src={m.avatarUrl} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
            ) : (
              <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                {(m.name ?? m.email ?? '?').slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] font-medium text-text-primary">
                {m.name ?? m.email}
                {m.id === team?.viewerId && (
                  <span className="ml-1.5 text-[10px] text-text-tertiary">(you)</span>
                )}
              </div>
              {m.name && m.email && (
                <div className="truncate text-[11px] text-text-tertiary">{m.email}</div>
              )}
            </div>
            {isAdmin && m.id !== team?.viewerId ? (
              <>
                <select
                  value={m.role}
                  onChange={(e) => handleRoleChange(m.id, e.target.value)}
                  className="rounded-lg border border-border bg-white px-2 py-1 text-[11px] text-text-primary focus:border-primary focus:outline-none"
                >
                  <option value="AGENT">Standard</option>
                  <option value="MANAGER">Manager</option>
                  <option value="ADMIN">Admin</option>
                </select>
                <button
                  onClick={() => handleRemove(m.id, m.name ?? m.email ?? 'Member')}
                  className={
                    confirmRemoveId === m.id
                      ? 'rounded-lg bg-red-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-red-700'
                      : 'rounded p-1 text-text-tertiary hover:bg-red-50 hover:text-red-600'
                  }
                  title={
                    confirmRemoveId === m.id
                      ? 'Click again to confirm removal'
                      : 'Remove from team (revokes login; keeps their data)'
                  }
                >
                  {confirmRemoveId === m.id ? 'Confirm?' : <Trash2 className="h-3.5 w-3.5" />}
                </button>
              </>
            ) : (
              <span className="flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[10px] font-medium text-text-secondary">
                {m.role === 'ADMIN' && <ShieldCheck className="h-3 w-3" />}
                {ROLE_LABELS[m.role] ?? m.role}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
