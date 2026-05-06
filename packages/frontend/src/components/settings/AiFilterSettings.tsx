import { useState } from 'react';
import { Filter, Plus, Trash2, Pencil, Zap, FileText, Check, X } from 'lucide-react';
import {
  useAiFilters,
  useCreateAiFilter,
  useUpdateAiFilter,
  useDeleteAiFilter,
  type AiFilter,
} from '../../hooks/useAiFilters';
import { cn } from '../../lib/utils';

const ACTION_TYPES = [
  { value: 'star', label: 'Star thread' },
  { value: 'archive', label: 'Archive' },
  { value: 'trash', label: 'Move to trash' },
  { value: 'label', label: 'Add label' },
] as const;

const CATEGORIES = [
  'revision_request', 'billing', 'new_inquiry', 'project_update',
  'meeting_scheduling', 'feedback', 'support_request', 'internal',
  'notification', 'marketing', 'spam', 'other',
];

function FilterEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: AiFilter;
  onSave: (data: { name: string; description: string; conditions: any; actions: any }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [mode, setMode] = useState<'ai' | 'rule'>(initial?.conditions?.mode ?? 'rule');
  const [aiPrompt, setAiPrompt] = useState(initial?.conditions?.aiPrompt ?? '');
  const [selectedCategories, setSelectedCategories] = useState<string[]>(initial?.conditions?.categories ?? []);
  const [senderPattern, setSenderPattern] = useState(initial?.conditions?.senderPatterns?.join(', ') ?? '');
  const [selectedActions, setSelectedActions] = useState<{ type: string; value?: string }[]>(
    initial?.actions ?? [{ type: 'star' }],
  );
  const [labelValue, setLabelValue] = useState(
    initial?.actions?.find((a: any) => a.type === 'label')?.value ?? '',
  );

  const toggleCategory = (cat: string) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
  };

  const toggleAction = (type: string) => {
    setSelectedActions((prev) =>
      prev.some((a) => a.type === type)
        ? prev.filter((a) => a.type !== type)
        : [...prev, { type }],
    );
  };

  const handleSave = () => {
    if (!name.trim() || !description.trim()) return;
    const conditions: any = { mode };
    if (mode === 'ai') {
      conditions.aiPrompt = aiPrompt;
    } else {
      if (selectedCategories.length > 0) conditions.categories = selectedCategories;
      if (senderPattern.trim()) conditions.senderPatterns = senderPattern.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const actions = selectedActions.map((a) =>
      a.type === 'label' ? { type: 'label', value: labelValue || 'filtered' } : a,
    );
    onSave({ name: name.trim(), description: description.trim(), conditions, actions });
  };

  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Filter name"
        className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Describe what this filter matches (used as AI prompt in AI mode)"
        rows={2}
        className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none resize-none"
      />

      {/* Mode toggle */}
      <div className="flex gap-1 rounded-lg bg-surface p-0.5">
        <button
          onClick={() => setMode('rule')}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
            mode === 'rule' ? 'bg-white text-text-primary shadow-sm' : 'text-text-tertiary',
          )}
        >
          <FileText className="h-3 w-3" />
          Rule-based
        </button>
        <button
          onClick={() => setMode('ai')}
          className={cn(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-medium transition-colors',
            mode === 'ai' ? 'bg-white text-text-primary shadow-sm' : 'text-text-tertiary',
          )}
        >
          <Zap className="h-3 w-3" />
          AI-powered
        </button>
      </div>

      {mode === 'ai' ? (
        <textarea
          value={aiPrompt}
          onChange={(e) => setAiPrompt(e.target.value)}
          placeholder='e.g., "Label as Cold Outreach when the email is an unsolicited sales pitch..."'
          rows={3}
          className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none resize-none"
        />
      ) : (
        <div className="space-y-2">
          <div>
            <p className="mb-1.5 text-[11px] font-medium text-text-secondary">Match categories:</p>
            <div className="flex flex-wrap gap-1.5">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  onClick={() => toggleCategory(cat)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px] transition-colors',
                    selectedCategories.includes(cat)
                      ? 'border-primary bg-primary/10 text-primary font-medium'
                      : 'border-border text-text-tertiary hover:border-primary/40',
                  )}
                >
                  {cat.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-medium text-text-secondary">Sender patterns (comma-separated):</p>
            <input
              type="text"
              value={senderPattern}
              onChange={(e) => setSenderPattern(e.target.value)}
              placeholder="*@example.com, newsletter@*"
              className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
            />
          </div>
        </div>
      )}

      {/* Actions */}
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-text-secondary">Actions when matched:</p>
        <div className="flex flex-wrap gap-1.5">
          {ACTION_TYPES.map((action) => (
            <button
              key={action.value}
              onClick={() => toggleAction(action.value)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[10px] transition-colors',
                selectedActions.some((a) => a.type === action.value)
                  ? 'border-primary bg-primary/10 text-primary font-medium'
                  : 'border-border text-text-tertiary hover:border-primary/40',
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
        {selectedActions.some((a) => a.type === 'label') && (
          <input
            type="text"
            value={labelValue}
            onChange={(e) => setLabelValue(e.target.value)}
            placeholder="Label name"
            className="mt-2 w-40 rounded-lg border border-border bg-white px-3 py-1 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
          />
        )}
      </div>

      <div className="flex items-center justify-end gap-1.5">
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!name.trim() || !description.trim()}
          className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:bg-primary/90 disabled:opacity-50"
        >
          <Check className="h-3 w-3" />
          Save
        </button>
      </div>
    </div>
  );
}

export function AiFilterSettings() {
  const { data: filters } = useAiFilters();
  const createFilter = useCreateAiFilter();
  const updateFilter = useUpdateAiFilter();
  const deleteFilter = useDeleteAiFilter();
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingFilter = editingId ? filters?.find((f) => f.id === editingId) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-text-secondary" />
          <h3 className="text-[13px] font-semibold text-text-primary">AI Filters</h3>
        </div>
        {!showEditor && !editingId && (
          <button
            onClick={() => setShowEditor(true)}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:bg-primary/90"
          >
            <Plus className="h-3 w-3" />
            New Filter
          </button>
        )}
      </div>

      <p className="text-[11px] text-text-tertiary leading-relaxed">
        Automatically organize your inbox with rule-based or AI-powered filters.
        Rule filters automatically sort emails based on their category (e.g., billing, marketing) or who sent them.
        AI filters let you describe what to match in plain English — Claude evaluates each email against your description.
      </p>

      {showEditor && (
        <FilterEditor
          onSave={(data) => {
            createFilter.mutate(data, { onSuccess: () => setShowEditor(false) });
          }}
          onCancel={() => setShowEditor(false)}
        />
      )}

      {editingFilter && (
        <FilterEditor
          initial={editingFilter}
          onSave={(data) => {
            updateFilter.mutate({ id: editingFilter.id, ...data }, { onSuccess: () => setEditingId(null) });
          }}
          onCancel={() => setEditingId(null)}
        />
      )}

      {filters && filters.length > 0 && (
        <div className="space-y-1.5">
          {filters.filter((f) => f.id !== editingId).map((filter) => (
            <div
              key={filter.id}
              className={cn(
                'rounded-lg border border-border p-3 transition-colors',
                filter.isActive ? 'bg-white' : 'bg-surface/50 opacity-60',
              )}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold text-text-primary">{filter.name}</span>
                  <span className={cn(
                    'rounded-full px-1.5 py-0.5 text-[9px] font-medium',
                    filter.conditions.mode === 'ai' ? 'bg-purple-50 text-purple-600' : 'bg-blue-50 text-blue-600',
                  )}>
                    {filter.conditions.mode === 'ai' ? 'AI' : 'Rule'}
                  </span>
                  {filter.matchCount > 0 && (
                    <span className="text-[10px] text-text-tertiary">{filter.matchCount} matches</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => updateFilter.mutate({ id: filter.id, isActive: !filter.isActive })}
                    className={cn(
                      'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
                      filter.isActive ? 'bg-primary' : 'bg-gray-300',
                    )}
                  >
                    <span className={cn(
                      'inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform',
                      filter.isActive ? 'translate-x-[14px]' : 'translate-x-[2px]',
                    )} />
                  </button>
                  <button
                    onClick={() => setEditingId(filter.id)}
                    className="rounded p-1 text-text-tertiary hover:text-primary"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  <button
                    onClick={() => deleteFilter.mutate(filter.id)}
                    className="rounded p-1 text-text-tertiary hover:text-red-500"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-text-tertiary line-clamp-2">{filter.description}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {(filter.actions as any[]).map((action, i) => (
                  <span key={i} className="rounded bg-surface px-1.5 py-0.5 text-[10px] text-text-secondary">
                    {action.type}{action.value ? `: ${action.value}` : ''}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {filters && filters.length === 0 && !showEditor && (
        <p className="text-center text-[11px] text-text-tertiary py-2">
          No filters yet. Create one to automatically organize incoming emails.
        </p>
      )}
    </div>
  );
}
