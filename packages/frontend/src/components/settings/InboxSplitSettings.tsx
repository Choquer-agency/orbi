import { useState, useEffect } from 'react';
import { Columns3, Save, GripVertical, Loader2 } from 'lucide-react';
import { useInboxSplits, useUpdateInboxSplits, type InboxSplit } from '../../hooks/useInboxSplits';
import { cn } from '../../lib/utils';

const CATEGORIES = [
  { value: 'all', label: 'All (no filter)' },
  { value: 'revision_request', label: 'Revision Requests' },
  { value: 'new_inquiry', label: 'New Inquiries' },
  { value: 'feedback', label: 'Feedback' },
  { value: 'billing', label: 'Billing' },
  { value: 'project_update', label: 'Project Updates' },
  { value: 'meeting_scheduling', label: 'Meetings' },
  { value: 'support_request', label: 'Support' },
  { value: 'internal', label: 'Internal' },
  { value: 'notification', label: 'Notifications' },
  { value: 'other', label: 'Other' },
];

export function InboxSplitSettings() {
  const { data: splits } = useInboxSplits();
  const updateSplits = useUpdateInboxSplits();
  const [localSplits, setLocalSplits] = useState<InboxSplit[]>([]);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (splits) {
      setLocalSplits(splits);
      setDirty(false);
    }
  }, [splits]);

  const toggleEnabled = (index: number) => {
    setLocalSplits((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], isEnabled: !next[index].isEnabled };
      return next;
    });
    setDirty(true);
  };

  const updateLabel = (index: number, label: string) => {
    setLocalSplits((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], label };
      return next;
    });
    setDirty(true);
  };

  const handleSave = () => {
    updateSplits.mutate(
      localSplits.map((s, i) => ({
        category: s.category,
        label: s.label,
        position: i,
        isEnabled: s.isEnabled,
      })),
      { onSuccess: () => setDirty(false) },
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Columns3 className="h-4 w-4 text-text-secondary" />
          <h3 className="text-[13px] font-semibold text-text-primary">Inbox Splits</h3>
        </div>
        {dirty && (
          <button
            onClick={handleSave}
            disabled={updateSplits.isPending}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {updateSplits.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
            Save
          </button>
        )}
      </div>

      <p className="text-[11px] text-text-tertiary leading-relaxed">
        Split your inbox into tabs based on email classification categories.
        Each tab shows threads matching that category. Reorder and rename tabs to fit your workflow.
      </p>

      {/* Split list */}
      {localSplits.length > 0 && (
        <div className="space-y-1.5">
          {localSplits.map((split, index) => (
            <div
              key={split.id || split.category}
              className={cn(
                'flex items-center gap-3 rounded-lg border border-border p-2.5 transition-colors',
                split.isEnabled ? 'bg-white' : 'bg-surface/50 opacity-60',
              )}
            >
              <GripVertical className="h-3.5 w-3.5 shrink-0 text-text-tertiary cursor-grab" />
              <input
                type="text"
                value={split.label}
                onChange={(e) => updateLabel(index, e.target.value)}
                className="w-28 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-[12px] font-medium text-text-primary hover:border-border focus:border-primary focus:outline-none"
              />
              <span className="flex-1 truncate text-[11px] text-text-tertiary">
                {split.category === 'all' ? 'Shows all emails' : `Categories: ${split.category}`}
              </span>
              <button
                onClick={() => toggleEnabled(index)}
                className={cn(
                  'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
                  split.isEnabled ? 'bg-primary' : 'bg-gray-300',
                )}
              >
                <span
                  className={cn(
                    'inline-block h-3 w-3 rounded-full bg-white shadow-sm transition-transform',
                    split.isEnabled ? 'translate-x-[14px]' : 'translate-x-[2px]',
                  )}
                />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Info */}
      <div className="rounded-lg bg-blue-50/80 px-3 py-2">
        <p className="text-[11px] text-blue-700 leading-relaxed">
          Splits use Orbi's AI classification to automatically sort incoming emails.
          The "All" tab always shows everything. Other tabs filter by category.
          You can combine categories with commas (e.g., "revision_request,new_inquiry").
        </p>
      </div>
    </div>
  );
}
