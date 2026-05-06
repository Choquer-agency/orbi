import { useState, useEffect, useCallback } from 'react';
import { Save, X, Plus, Trash2, Loader2, Brain } from 'lucide-react';
import { api } from '../../lib/api';

interface Preferences {
  greetingStyle: string | null;
  signOffStyle: string | null;
  tone: number;
  verbosity: number;
  descriptors: string[];
  customRules: string[];
}

interface ContactStyle {
  id: string;
  contactEmail: string;
  contactName: string | null;
  tone: number | null;
  verbosity: number | null;
  greetingStyle: string | null;
  signOffStyle: string | null;
  notes: string | null;
  isAutoLearned: boolean;
}

interface StyleCorrection {
  id: string;
  category: string;
  summary: string | null;
  contactEmail: string | null;
  originalText: string;
  editedText: string;
  createdAt: string;
}

const GREETING_OPTIONS = ['Hey', 'Hi', 'Hello', 'Dear'];
const SIGNOFF_OPTIONS = ['None', 'Best', 'Thanks', 'Cheers', 'Regards', 'Warm regards'];
const TONE_LABELS = ['Very casual', 'Casual', 'Balanced', 'Formal', 'Very formal'];
const VERBOSITY_LABELS = ['Very terse', 'Concise', 'Balanced', 'Detailed', 'Very detailed'];
const DESCRIPTOR_SUGGESTIONS = [
  'professional',
  'friendly',
  'concise',
  'warm',
  'direct',
  'empathetic',
  'enthusiastic',
  'measured',
];

export function WritingPreferences({ onClose }: { onClose?: () => void }) {
  const [prefs, setPrefs] = useState<Preferences>({
    greetingStyle: 'Hey',
    signOffStyle: 'Best',
    tone: 3,
    verbosity: 3,
    descriptors: [],
    customRules: [],
  });
  const [contactStyles, setContactStyles] = useState<ContactStyle[]>([]);
  const [corrections, setCorrections] = useState<StyleCorrection[]>([]);
  const [correctionCount, setCorrectionCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newRule, setNewRule] = useState('');
  const [newDescriptor, setNewDescriptor] = useState('');
  const [customGreeting, setCustomGreeting] = useState('');
  const [customSignoff, setCustomSignoff] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [prefsRes, stylesRes, correctionsRes] = await Promise.all([
        api.get<{ data: Preferences | null }>('/settings/writing-preferences'),
        api.get<{ data: ContactStyle[] }>('/settings/contact-styles'),
        api.get<{ data: { corrections: StyleCorrection[]; totalCount: number } }>('/settings/style-corrections'),
      ]);
      if (prefsRes.data) setPrefs(prefsRes.data);
      setContactStyles(stylesRes.data);
      setCorrections(correctionsRes.data.corrections);
      setCorrectionCount(correctionsRes.data.totalCount);
    } catch (err) {
      console.error('Failed to fetch preferences:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.put('/settings/writing-preferences', prefs);
    } catch (err) {
      console.error('Failed to save preferences:', err);
    } finally {
      setSaving(false);
    }
  };

  const addRule = () => {
    if (!newRule.trim()) return;
    setPrefs((p) => ({ ...p, customRules: [...p.customRules, newRule.trim()] }));
    setNewRule('');
  };

  const removeRule = (index: number) => {
    setPrefs((p) => ({ ...p, customRules: p.customRules.filter((_, i) => i !== index) }));
  };

  const toggleDescriptor = (desc: string) => {
    setPrefs((p) => ({
      ...p,
      descriptors: p.descriptors.includes(desc)
        ? p.descriptors.filter((d) => d !== desc)
        : [...p.descriptors, desc],
    }));
  };

  const addCustomDescriptor = () => {
    if (!newDescriptor.trim() || prefs.descriptors.includes(newDescriptor.trim())) return;
    setPrefs((p) => ({ ...p, descriptors: [...p.descriptors, newDescriptor.trim().toLowerCase()] }));
    setNewDescriptor('');
  };

  const deleteContactStyle = async (contactEmail: string) => {
    try {
      await api.delete(`/settings/contact-styles/${encodeURIComponent(contactEmail)}`);
      setContactStyles((s) => s.filter((c) => c.contactEmail !== contactEmail));
    } catch (err) {
      console.error('Failed to delete contact style:', err);
    }
  };

  const deleteCorrection = async (id: string) => {
    try {
      await api.delete(`/settings/style-corrections/${id}`);
      setCorrections((c) => c.filter((item) => item.id !== id));
      setCorrectionCount((n) => Math.max(0, n - 1));
    } catch (err) {
      console.error('Failed to delete correction:', err);
    }
  };

  const formatTimeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(dateStr).toLocaleDateString();
  };

  const setGreeting = (value: string) => {
    if (value === 'custom') return;
    setPrefs((p) => ({ ...p, greetingStyle: value }));
  };

  const setSignoff = (value: string) => {
    if (value === 'custom') return;
    setPrefs((p) => ({ ...p, signOffStyle: value }));
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-[13px] font-semibold text-text-primary">Writing Preferences</h3>
          <p className="mt-0.5 text-[11px] text-text-tertiary">Configure how the AI drafts emails for you</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </button>
      </div>

      <div className="space-y-8">
        {/* Greeting & Sign-off */}
        <div className="grid grid-cols-2 gap-6">
          <div>
            <label className="mb-2 block text-sm font-medium text-text-primary">
              Greeting Style
            </label>
            <div className="flex flex-wrap gap-2">
              {GREETING_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => setGreeting(opt)}
                  className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                    prefs.greetingStyle === opt
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-text-secondary hover:border-primary/40'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={customGreeting}
                onChange={(e) => setCustomGreeting(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customGreeting.trim()) {
                    setGreeting(customGreeting.trim());
                    setCustomGreeting('');
                  }
                }}
                placeholder="Custom..."
                className="w-24 rounded-lg border border-border px-2 py-1 text-sm outline-none focus:border-primary"
              />
            </div>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-text-primary">
              Sign-off Style
            </label>
            <div className="flex flex-wrap gap-2">
              {SIGNOFF_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  onClick={() => setSignoff(opt)}
                  className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                    prefs.signOffStyle === opt
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-text-secondary hover:border-primary/40'
                  }`}
                >
                  {opt}
                </button>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="text"
                value={customSignoff}
                onChange={(e) => setCustomSignoff(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customSignoff.trim()) {
                    setSignoff(customSignoff.trim());
                    setCustomSignoff('');
                  }
                }}
                placeholder="Custom..."
                className="w-24 rounded-lg border border-border px-2 py-1 text-sm outline-none focus:border-primary"
              />
            </div>
          </div>
        </div>

        {/* Tone Slider */}
        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">Tone</label>
          <input
            type="range"
            min={1}
            max={5}
            value={prefs.tone}
            onChange={(e) => setPrefs((p) => ({ ...p, tone: Number(e.target.value) }))}
            className="w-full accent-primary"
          />
          <div className="mt-1 flex justify-between text-xs text-text-tertiary">
            {TONE_LABELS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>

        {/* Verbosity Slider */}
        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">Verbosity</label>
          <input
            type="range"
            min={1}
            max={5}
            value={prefs.verbosity}
            onChange={(e) => setPrefs((p) => ({ ...p, verbosity: Number(e.target.value) }))}
            className="w-full accent-primary"
          />
          <div className="mt-1 flex justify-between text-xs text-text-tertiary">
            {VERBOSITY_LABELS.map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>

        {/* Style Descriptors */}
        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">
            Style Descriptors
          </label>
          <p className="mb-3 text-xs text-text-tertiary">
            Choose adjectives that describe your writing style
          </p>
          <div className="flex flex-wrap gap-2">
            {DESCRIPTOR_SUGGESTIONS.map((desc) => (
              <button
                key={desc}
                onClick={() => toggleDescriptor(desc)}
                className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                  prefs.descriptors.includes(desc)
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-text-secondary hover:border-primary/40'
                }`}
              >
                {desc}
              </button>
            ))}
            {prefs.descriptors
              .filter((d) => !DESCRIPTOR_SUGGESTIONS.includes(d))
              .map((desc) => (
                <button
                  key={desc}
                  onClick={() => toggleDescriptor(desc)}
                  className="rounded-full border border-primary bg-primary/10 px-3 py-1 text-sm text-primary"
                >
                  {desc}
                </button>
              ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              value={newDescriptor}
              onChange={(e) => setNewDescriptor(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCustomDescriptor()}
              placeholder="Add custom..."
              className="w-32 rounded-lg border border-border px-2 py-1 text-sm outline-none focus:border-primary"
            />
            <button
              onClick={addCustomDescriptor}
              disabled={!newDescriptor.trim()}
              className="rounded-lg p-1 text-text-tertiary hover:text-primary disabled:opacity-30"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Custom Rules */}
        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">Custom Rules</label>
          <p className="mb-3 text-xs text-text-tertiary">
            Specific instructions the AI should always follow
          </p>
          {prefs.customRules.length > 0 && (
            <div className="mb-3 space-y-1.5">
              {prefs.customRules.map((rule, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-lg bg-surface px-3 py-2"
                >
                  <span className="text-sm text-text-primary">{rule}</span>
                  <button
                    onClick={() => removeRule(i)}
                    className="rounded p-0.5 text-text-tertiary hover:text-danger"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newRule}
              onChange={(e) => setNewRule(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addRule()}
              placeholder='e.g., "Always mention timeline"'
              className="flex-1 rounded-lg border border-border px-3 py-1.5 text-sm outline-none focus:border-primary"
            />
            <button
              onClick={addRule}
              disabled={!newRule.trim()}
              className="flex items-center gap-1 rounded-lg bg-surface px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface/80 disabled:opacity-30"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
        </div>

        {/* What Orbi Has Learned */}
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Brain className="h-4 w-4 text-secondary" />
            <label className="text-sm font-medium text-text-primary">
              What Orbi Has Learned
            </label>
            {correctionCount > 0 && (
              <span className="rounded-full bg-secondary/10 px-2 py-0.5 text-[10px] font-medium text-secondary">
                {correctionCount}
              </span>
            )}
          </div>
          <p className="mb-3 text-xs text-text-tertiary">
            Patterns learned from your edits to AI drafts. Remove any that don't reflect your preferences.
          </p>
          {corrections.length === 0 ? (
            <p className="text-sm text-text-tertiary italic">
              No corrections learned yet. When you edit an AI draft before sending, Orbi remembers your changes.
            </p>
          ) : (
            <div className="space-y-2">
              {corrections.map((c) => (
                <div
                  key={c.id}
                  className="flex items-start justify-between rounded-lg border border-border px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                        {c.category}
                      </span>
                      <span className="text-[10px] text-text-tertiary">
                        {c.contactEmail || 'General'}
                      </span>
                      <span className="text-[10px] text-text-tertiary">
                        {formatTimeAgo(c.createdAt)}
                      </span>
                    </div>
                    {c.summary && (
                      <p className="mt-1 text-[12px] text-text-secondary">{c.summary}</p>
                    )}
                  </div>
                  <button
                    onClick={() => deleteCorrection(c.id)}
                    className="ml-2 shrink-0 rounded-lg p-1.5 text-text-tertiary hover:bg-surface hover:text-danger"
                    title="Remove this correction"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Per-Contact Styles */}
        <div>
          <label className="mb-2 block text-sm font-medium text-text-primary">
            Per-Contact Styles
          </label>
          <p className="mb-3 text-xs text-text-tertiary">
            Overrides learned from your edits. These are applied when drafting for specific contacts.
          </p>
          {contactStyles.length === 0 ? (
            <p className="text-sm text-text-tertiary italic">
              No contact-specific styles yet. Orbi will learn these as you edit AI drafts.
            </p>
          ) : (
            <div className="space-y-2">
              {contactStyles.map((cs) => (
                <div
                  key={cs.id}
                  className="flex items-center justify-between rounded-lg border border-border px-4 py-3"
                >
                  <div>
                    <div className="text-sm font-medium text-text-primary">
                      {cs.contactName || cs.contactEmail}
                    </div>
                    <div className="text-xs text-text-tertiary">{cs.contactEmail}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-text-secondary">
                      {cs.greetingStyle && <span>Greeting: "{cs.greetingStyle}"</span>}
                      {cs.signOffStyle && <span>Sign-off: "{cs.signOffStyle}"</span>}
                      {cs.tone != null && <span>Tone: {cs.tone}/5</span>}
                      {cs.notes && <span>{cs.notes}</span>}
                    </div>
                    {cs.isAutoLearned && (
                      <span className="mt-1 inline-block rounded-full bg-secondary/10 px-2 py-0.5 text-[10px] font-medium text-secondary">
                        Auto-learned
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => deleteContactStyle(cs.contactEmail)}
                    className="rounded-lg p-1.5 text-text-tertiary hover:bg-surface hover:text-danger"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
