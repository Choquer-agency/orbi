import { useState, useEffect, useMemo } from 'react';
import { Plane, Loader2, Save, Plus, Sparkles } from 'lucide-react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';

type Tone = 'warm' | 'formal' | 'casual';

export function VacationResponderSettings() {
  const currentUserId = useAuthStore((s) => s.user?.id);

  // ── Data ────────────────────────────────────────────────────────────────
  const delegation = useQuery(api.ooo.get, {});
  const users = useQuery(api.users.list, {});
  const createDelegation = useMutation(api.ooo.create);
  const updateDelegation = useMutation(api.ooo.update);
  const generateAi = useAction(api.ai.vacationReply.generate);

  const isLoading = delegation === undefined || users === undefined;

  // ── Form state (existing delegation) ────────────────────────────────────
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [autoReplySubject, setAutoReplySubject] = useState('');
  const [autoReplyBody, setAutoReplyBody] = useState('');
  const [autoReplyScope, setAutoReplyScope] = useState<string>('all');
  const [endAtDate, setEndAtDate] = useState('');
  const [saving, setSaving] = useState(false);

  // ── Form state (new delegation) ─────────────────────────────────────────
  const [newDelegateId, setNewDelegateId] = useState<string>('');
  const [newStartAt, setNewStartAt] = useState('');
  const [newEndAt, setNewEndAt] = useState('');
  const [creating, setCreating] = useState(false);

  // ── AI generator state ──────────────────────────────────────────────────
  const [aiOpen, setAiOpen] = useState(false);
  const [aiReturnDate, setAiReturnDate] = useState('');
  const [aiContact, setAiContact] = useState('');
  const [aiTone, setAiTone] = useState<Tone>('warm');
  const [aiNotes, setAiNotes] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // Hydrate form when delegation loads / changes
  useEffect(() => {
    if (!delegation) return;
    setAutoReplyEnabled(delegation.autoReplyEnabled);
    setAutoReplySubject(delegation.autoReplySubject ?? '');
    setAutoReplyBody(delegation.autoReplyBody ?? '');
    setAutoReplyScope(delegation.autoReplyScope ?? 'all');
    setEndAtDate(toDateInput(delegation.endAt));
  }, [delegation]);

  const teamMembers = useMemo(
    () => (users ?? []).filter((u) => u.id !== currentUserId),
    [users, currentUserId],
  );

  const handleSave = async () => {
    if (!delegation) return;
    setSaving(true);
    try {
      await updateDelegation({
        id: delegation._id,
        autoReplyEnabled,
        autoReplySubject: autoReplySubject || null,
        autoReplyBody: autoReplyBody || null,
        autoReplyScope,
        endAt: endAtDate ? fromDateInput(endAtDate) : undefined,
      });
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
      await createDelegation({
        delegateId: newDelegateId as Id<'users'>,
        startAt: fromDateInput(newStartAt),
        endAt: fromDateInput(newEndAt),
      });
    } catch (err) {
      console.error('Failed to create delegation:', err);
    } finally {
      setCreating(false);
    }
  };

  const handleGenerateAi = async () => {
    if (!aiReturnDate) {
      setAiError('Please pick a return date.');
      return;
    }
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await generateAi({
        returnDate: aiReturnDate,
        contactWhileAway: aiContact.trim() || undefined,
        tone: aiTone,
        notes: aiNotes.trim() || undefined,
      });
      setAutoReplySubject(result.subject);
      setAutoReplyBody(result.body);
      setAutoReplyEnabled(true);
      setAiOpen(false);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'Generation failed.');
    } finally {
      setAiBusy(false);
    }
  };

  if (isLoading) {
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
                        {member.name ?? member.email} {member.email ? `(${member.email})` : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-[11px] text-text-tertiary">No other team members available.</p>
                )}
              </div>

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
          <div className="flex items-center gap-2 rounded-lg bg-amber-50/80 px-3 py-2">
            <div className={cn('h-2 w-2 rounded-full', delegation.isActive ? 'bg-green-500' : 'bg-gray-400')} />
            <span className="text-[11px] font-medium text-amber-700">
              {delegation.isActive ? 'Active' : 'Inactive'} delegation
              {delegation.delegate?.name && ` to ${delegation.delegate.name}`}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-text-secondary">Start date</label>
              <input
                type="date"
                value={toDateInput(delegation.startAt)}
                disabled
                className="w-full rounded-lg border border-border bg-surface/50 px-3 py-1.5 text-[12px] text-text-tertiary"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-text-secondary">End date</label>
              <input
                type="date"
                value={endAtDate}
                onChange={(e) => setEndAtDate(e.target.value)}
                className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none"
              />
            </div>
          </div>

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
              <span
                className={cn(
                  'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
                  autoReplyEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
                )}
              />
            </button>
          </div>

          {autoReplyEnabled && (
            <>
              {/* AI generator ──────────────────────────────────────────── */}
              <div className="rounded-lg border border-primary/30 bg-primary/[0.03] p-3">
                <button
                  onClick={() => setAiOpen((v) => !v)}
                  className="flex w-full items-center justify-between text-left"
                >
                  <span className="flex items-center gap-1.5 text-[12px] font-semibold text-text-primary">
                    <Sparkles className="h-3.5 w-3.5 text-primary" />
                    Generate with AI
                  </span>
                  <span className="text-[11px] text-text-tertiary">
                    {aiOpen ? 'Hide' : 'Open'}
                  </span>
                </button>

                {aiOpen && (
                  <div className="mt-3 space-y-3">
                    <p className="text-[11px] text-text-tertiary leading-relaxed">
                      Give a few details and we&apos;ll draft a polished auto-reply. You can edit it before saving.
                    </p>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="mb-1 block text-[11px] font-medium text-text-secondary">Return date</label>
                        <input
                          type="date"
                          value={aiReturnDate}
                          onChange={(e) => setAiReturnDate(e.target.value)}
                          className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] font-medium text-text-secondary">Tone</label>
                        <div className="flex gap-1">
                          {(['warm', 'formal', 'casual'] as Tone[]).map((t) => (
                            <button
                              key={t}
                              onClick={() => setAiTone(t)}
                              className={cn(
                                'flex-1 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors capitalize',
                                aiTone === t
                                  ? 'border-primary bg-primary/10 text-primary'
                                  : 'border-border bg-white text-text-secondary hover:border-primary/30',
                              )}
                            >
                              {t}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                        Who should they contact while you&apos;re away?{' '}
                        <span className="font-normal text-text-tertiary">(optional)</span>
                      </label>
                      <input
                        type="text"
                        value={aiContact}
                        onChange={(e) => setAiContact(e.target.value)}
                        placeholder="e.g. Sarah at sarah@orbi.com"
                        className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
                      />
                    </div>

                    <div>
                      <label className="mb-1 block text-[11px] font-medium text-text-secondary">
                        Anything else to mention? <span className="font-normal text-text-tertiary">(optional)</span>
                      </label>
                      <textarea
                        value={aiNotes}
                        onChange={(e) => setAiNotes(e.target.value)}
                        placeholder="e.g. Limited email access, urgent matters only, conference in Lisbon…"
                        rows={3}
                        className="w-full resize-none rounded-lg border border-border bg-white px-3 py-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
                      />
                    </div>

                    {aiError && (
                      <p className="text-[11px] text-red-600">{aiError}</p>
                    )}

                    <button
                      onClick={handleGenerateAi}
                      disabled={aiBusy || !aiReturnDate}
                      className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
                    >
                      {aiBusy ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
                      Generate auto-reply
                    </button>
                  </div>
                )}
              </div>

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

              <div>
                <label className="mb-1 block text-[11px] font-medium text-text-secondary">Reply message</label>
                <textarea
                  value={autoReplyBody}
                  onChange={(e) => setAutoReplyBody(e.target.value)}
                  placeholder="Thanks for your email! I'm currently out of the office and will return on..."
                  rows={6}
                  className="w-full rounded-lg border border-border bg-white px-3 py-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none resize-none"
                />
              </div>

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
                        autoReplyScope === option.value
                          ? 'border-primary bg-primary/5'
                          : 'border-border bg-white hover:border-primary/30',
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

// ── Date helpers ──────────────────────────────────────────────────────────
// Convex stores timestamps as millis; the <input type="date"> works in
// YYYY-MM-DD. Parse as local-noon to dodge DST/timezone-rollover surprises.

function toDateInput(ms: number | undefined | null): string {
  if (!ms) return '';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fromDateInput(value: string): number {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return Date.now();
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), 12, 0, 0).getTime();
}
