import { useState, useEffect } from 'react';
import { Plane, Loader2, Save, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';

interface OooDelegation {
  id: string;
  startAt: string;
  endAt: string;
  autoReplyEnabled: boolean;
  autoReplyBody: string | null;
  autoReplySubject: string | null;
  autoReplyScope: string;
  isActive: boolean;
  categories: string[];
  delegate?: { name: string; email: string };
}

interface TeamMember {
  id: string;
  name: string;
  email: string;
}

export function VacationResponderSettings() {
  const [delegation, setDelegation] = useState<OooDelegation | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const currentUserId = useAuthStore((s) => s.user?.id);

  // Form state (existing delegation)
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [autoReplySubject, setAutoReplySubject] = useState('');
  const [autoReplyBody, setAutoReplyBody] = useState('');
  const [autoReplyScope, setAutoReplyScope] = useState('all');
  const [startAt, setStartAt] = useState('');
  const [endAt, setEndAt] = useState('');

  // New delegation form state
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [newDelegateId, setNewDelegateId] = useState('');
  const [newStartAt, setNewStartAt] = useState('');
  const [newEndAt, setNewEndAt] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchDelegation = async () => {
    try {
      const res = await api.get<{ data: OooDelegation | null }>('/ooo/delegation');
      if (res.data) {
        setDelegation(res.data);
        setAutoReplyEnabled(res.data.autoReplyEnabled);
        setAutoReplySubject(res.data.autoReplySubject ?? '');
        setAutoReplyBody(res.data.autoReplyBody ?? '');
        setAutoReplyScope(res.data.autoReplyScope ?? 'all');
        setStartAt(res.data.startAt?.split('T')[0] ?? '');
        setEndAt(res.data.endAt?.split('T')[0] ?? '');
      }
    } catch {
      // No active delegation
    }
  };

  useEffect(() => {
    (async () => {
      try {
        await fetchDelegation();
        // Fetch team members for delegate picker
        const usersRes = await api.get<{ data: TeamMember[] }>('/users');
        const members = (usersRes.data ?? []).filter((u: TeamMember) => u.id !== currentUserId);
        setTeamMembers(members);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    })();
  }, [currentUserId]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (delegation) {
        await api.patch(`/ooo/delegation/${delegation.id}`, {
          autoReplyEnabled,
          autoReplySubject: autoReplySubject || null,
          autoReplyBody: autoReplyBody || null,
          autoReplyScope,
          endAt: endAt ? new Date(endAt).toISOString() : undefined,
        });
      }
    } catch (err) {
      console.error('Failed to save vacation settings:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateDelegation = async () => {
    if (!newDelegateId || !newStartAt || !newEndAt) return;
    setCreating(true);
    try {
      await api.post('/ooo/delegation', {
        delegateId: newDelegateId,
        startAt: new Date(newStartAt).toISOString(),
        endAt: new Date(newEndAt).toISOString(),
      });
      await fetchDelegation();
    } catch (err) {
      console.error('Failed to create delegation:', err);
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Plane className="h-4 w-4 text-text-secondary" />
          <h3 className="text-[13px] font-semibold text-text-primary">Vacation Responder</h3>
        </div>
        {delegation && (
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            Save
          </button>
        )}
      </div>

      <p className="text-[11px] text-text-tertiary leading-relaxed">
        Set up an out-of-office delegation and configure your auto-reply below.
      </p>

      {!delegation ? (
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-surface/50 p-4">
            <p className="text-[12px] font-semibold text-text-primary mb-3">Set up out of office</p>
            <div className="space-y-3">
              {/* Delegate picker */}
              <div>
                <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                  Delegate to
                </label>
                {teamMembers.length > 0 ? (
                  <select
                    value={newDelegateId}
                    onChange={(e) => setNewDelegateId(e.target.value)}
                    className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none"
                  >
                    <option value="">Select a team member...</option>
                    {teamMembers.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name} ({member.email})
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-[11px] text-text-tertiary">No other team members available.</p>
                )}
              </div>

              {/* Date range */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-text-secondary">Start date</label>
                  <input
                    type="date"
                    value={newStartAt}
                    onChange={(e) => setNewStartAt(e.target.value)}
                    className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-text-secondary">End date</label>
                  <input
                    type="date"
                    value={newEndAt}
                    onChange={(e) => setNewEndAt(e.target.value)}
                    className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none"
                  />
                </div>
              </div>

              <button
                onClick={handleCreateDelegation}
                disabled={creating || !newDelegateId || !newStartAt || !newEndAt}
                className="flex items-center gap-1 rounded-lg bg-primary px-4 py-2 text-[12px] font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {creating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                Set Up Out of Office
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Status */}
          <div className="flex items-center gap-2 rounded-lg bg-amber-50/80 px-3 py-2">
            <div className={cn('h-2 w-2 rounded-full', delegation.isActive ? 'bg-green-500' : 'bg-gray-400')} />
            <span className="text-[11px] font-medium text-amber-700">
              {delegation.isActive ? 'Active' : 'Inactive'} delegation
              {delegation.delegate && ` to ${delegation.delegate.name}`}
            </span>
          </div>

          {/* Date range */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-text-secondary">Start date</label>
              <input
                type="date"
                value={startAt}
                disabled
                className="w-full rounded-lg border border-border bg-surface/50 px-3 py-1.5 text-[12px] text-text-tertiary"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-text-secondary">End date</label>
              <input
                type="date"
                value={endAt}
                onChange={(e) => setEndAt(e.target.value)}
                className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none"
              />
            </div>
          </div>

          {/* Auto-reply toggle */}
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface/50 p-3">
            <div>
              <p className="text-[12px] font-semibold text-text-primary">Auto-reply enabled</p>
              <p className="mt-0.5 text-[11px] text-text-tertiary">
                Automatically send a reply to incoming emails (one per sender per delegation period)
              </p>
            </div>
            <button
              onClick={() => setAutoReplyEnabled(!autoReplyEnabled)}
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
                autoReplyEnabled ? 'bg-primary' : 'bg-gray-300',
              )}
            >
              <span className={cn(
                'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
                autoReplyEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
              )} />
            </button>
          </div>

          {autoReplyEnabled && (
            <>
              {/* Subject */}
              <div>
                <label className="mb-1 block text-[11px] font-medium text-text-secondary">Reply subject</label>
                <input
                  type="text"
                  value={autoReplySubject}
                  onChange={(e) => setAutoReplySubject(e.target.value)}
                  placeholder="Re: Out of Office"
                  className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
                />
              </div>

              {/* Message */}
              <div>
                <label className="mb-1 block text-[11px] font-medium text-text-secondary">Reply message</label>
                <textarea
                  value={autoReplyBody}
                  onChange={(e) => setAutoReplyBody(e.target.value)}
                  placeholder="Thanks for your email! I'm currently out of the office and will return on..."
                  rows={4}
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none resize-none"
                />
              </div>

              {/* Scope */}
              <div>
                <label className="mb-1.5 block text-[11px] font-medium text-text-secondary">Reply scope</label>
                <div className="space-y-1.5">
                  {[
                    { value: 'all', label: 'Everyone', desc: 'Reply to all incoming emails' },
                    { value: 'contacts_only', label: 'Contacts only', desc: 'Only reply to people in your contacts' },
                    { value: 'domain_only', label: 'Same domain', desc: 'Only reply to people in your organization' },
                  ].map((option) => (
                    <label
                      key={option.value}
                      className={cn(
                        'flex items-start gap-2.5 rounded-lg border p-2.5 cursor-pointer transition-colors',
                        autoReplyScope === option.value ? 'border-primary bg-primary/5' : 'border-border bg-white hover:border-primary/30',
                      )}
                    >
                      <input
                        type="radio"
                        name="scope"
                        value={option.value}
                        checked={autoReplyScope === option.value}
                        onChange={(e) => setAutoReplyScope(e.target.value)}
                        className="mt-0.5 accent-primary"
                      />
                      <div>
                        <p className="text-[12px] font-medium text-text-primary">{option.label}</p>
                        <p className="text-[10px] text-text-tertiary">{option.desc}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
