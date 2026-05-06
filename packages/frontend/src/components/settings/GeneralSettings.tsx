import { LayoutList } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { TriageSettings } from './TriageSettings';
import { TrackingExclusions } from './TrackingExclusions';
import { cn } from '../../lib/utils';

function InboxFilterModeToggle() {
  const inboxFilterMode = useUiStore((s) => s.inboxFilterMode);
  const setInboxFilterMode = useUiStore((s) => s.setInboxFilterMode);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <LayoutList className="h-4 w-4 text-orange-500" />
        <h3 className="text-[13px] font-semibold text-text-primary">Inbox Filter Bar</h3>
      </div>
      <p className="text-xs text-text-tertiary">
        Choose which filter bar to show above your thread list.
      </p>
      <div className="flex gap-3">
        <button
          onClick={() => setInboxFilterMode('smart')}
          className={cn(
            'flex-1 rounded-lg border p-3 text-left transition-colors',
            inboxFilterMode === 'smart'
              ? 'border-primary bg-primary/5 ring-1 ring-primary'
              : 'border-border hover:border-text-tertiary',
          )}
        >
          <p className="text-xs font-semibold text-text-primary">Smart Categories</p>
          <p className="mt-1 text-[11px] text-text-tertiary">
            AI-powered splits like Client Work, Internal, Billing, Updates
          </p>
        </button>
        <button
          onClick={() => setInboxFilterMode('standard')}
          className={cn(
            'flex-1 rounded-lg border p-3 text-left transition-colors',
            inboxFilterMode === 'standard'
              ? 'border-primary bg-primary/5 ring-1 ring-primary'
              : 'border-border hover:border-text-tertiary',
          )}
        >
          <p className="text-xs font-semibold text-text-primary">Standard Filters</p>
          <p className="mt-1 text-[11px] text-text-tertiary">
            Classic All, Unread, and Starred tabs
          </p>
        </button>
      </div>
    </div>
  );
}

export function GeneralSettings() {
  return (
    <div className="space-y-8">
      <InboxFilterModeToggle />
      <div className="h-px bg-border" />
      <TriageSettings />
      <div className="h-px bg-border" />
      <TrackingExclusions />
    </div>
  );
}
