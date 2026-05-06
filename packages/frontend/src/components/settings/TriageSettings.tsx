import { useState } from 'react';
import { FolderInput, Sparkles, ChevronDown, ChevronRight, Trash2, Plus } from 'lucide-react';
import {
  useTriageSettings,
  useUpdateTriageSettings,
  useTriageStats,
  useTriageFeedbackList,
  useUpdateTriageFeedback,
  useDeleteTriageFeedback,
  useCreateManualTriageRule,
} from '../../hooks/useTriage';
import { cn } from '../../lib/utils';

const CATEGORIES = [
  'revision_request', 'billing', 'new_inquiry', 'project_update',
  'meeting_scheduling', 'feedback', 'support_request', 'internal',
  'notification', 'marketing', 'spam', 'other',
];

function formatCategory(cat: string) {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function TriageSettings() {
  const { data: settings } = useTriageSettings();
  const { data: stats } = useTriageStats();
  const updateSettings = useUpdateTriageSettings();
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(1);
  const { data: feedbackRes } = useTriageFeedbackList(expanded ? page : 0);
  const updateFeedback = useUpdateTriageFeedback();
  const deleteFeedback = useDeleteTriageFeedback();
  const createRule = useCreateManualTriageRule();

  // Manual rule form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newSender, setNewSender] = useState('');
  const [newCategory, setNewCategory] = useState(CATEGORIES[0]);

  const autoSortEnabled = settings?.autoSortEnabled ?? false;
  const threshold = settings?.confidenceThreshold ?? 0.85;

  const getThresholdLabel = (val: number) => {
    if (val <= 0.55) return 'Aggressive';
    if (val <= 0.65) return 'Moderate';
    if (val <= 0.75) return 'Balanced';
    if (val <= 0.85) return 'Conservative';
    return 'Very Conservative';
  };

  const feedback = feedbackRes?.data ?? [];
  const meta = feedbackRes?.meta;

  const handleAddRule = () => {
    const sender = newSender.trim();
    if (!sender || !sender.includes('@')) return;
    createRule.mutate(
      { senderAddress: sender, finalCategory: newCategory },
      {
        onSuccess: () => {
          setNewSender('');
          setNewCategory(CATEGORIES[0]);
          setShowAddForm(false);
        },
      },
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <FolderInput className="h-4 w-4 text-indigo-500" />
        <h3 className="text-[13px] font-semibold text-text-primary">Smart Triage</h3>
      </div>

      {/* Auto-sort toggle */}
      <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface/50 p-3">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-text-primary">Auto-sort emails</p>
          <p className="mt-0.5 text-[11px] text-text-tertiary leading-relaxed">
            When enabled, incoming emails that Orbi confidently recognizes as subscriptions,
            marketing, notifications, or spam will be automatically filed to their folders.
            Low-confidence emails stay in your inbox with a suggestion banner.
          </p>
        </div>
        <button
          onClick={() => updateSettings.mutate({ autoSortEnabled: !autoSortEnabled })}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
            autoSortEnabled ? 'bg-primary' : 'bg-gray-300',
          )}
        >
          <span
            className={cn(
              'inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform',
              autoSortEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]',
            )}
          />
        </button>
      </div>

      {/* Confidence threshold */}
      {autoSortEnabled && (
        <div className="rounded-lg border border-border bg-surface/50 p-3">
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-semibold text-text-primary">Confidence threshold</p>
            <span className="text-[11px] font-medium text-text-secondary">
              {getThresholdLabel(threshold)} ({Math.round(threshold * 100)}%)
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-text-tertiary">
            Higher = fewer auto-sorts but more accurate. Lower = more auto-sorts but occasional mistakes.
          </p>
          <input
            type="range"
            min={0.5}
            max={0.95}
            step={0.05}
            value={threshold}
            onChange={(e) => updateSettings.mutate({ confidenceThreshold: parseFloat(e.target.value) })}
            className="mt-2 w-full accent-primary"
          />
          <div className="mt-1 flex justify-between text-[10px] text-text-tertiary">
            <span>Aggressive</span>
            <span>Conservative</span>
          </div>
        </div>
      )}

      {/* Training stats — expandable */}
      {stats && stats.feedbackCount > 0 && (
        <div className="space-y-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex w-full items-center gap-2 rounded-lg bg-indigo-50/80 px-3 py-2 transition-colors hover:bg-indigo-100/80"
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 text-indigo-500" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-indigo-500" />
            )}
            <Sparkles className="h-3.5 w-3.5 text-indigo-500" />
            <span className="text-[11px] font-medium text-indigo-700">
              You've trained Orbi with {stats.feedbackCount} triage decision{stats.feedbackCount !== 1 ? 's' : ''}
            </span>
          </button>

          {expanded && (
            <div className="space-y-2">
              {/* Feedback list */}
              {feedback.length > 0 && (
                <div className="space-y-1">
                  {feedback.map((fb) => (
                    <div
                      key={fb.id}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border bg-white px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-medium text-text-primary">
                          {fb.senderAddress || '(unknown sender)'}
                        </p>
                        <p className="truncate text-[10px] text-text-tertiary">
                          {fb.subjectSnippet}
                          {fb.suggestedCategory && fb.suggestedCategory !== fb.finalCategory && (
                            <span className="ml-1">
                              — was <span className="line-through">{formatCategory(fb.suggestedCategory)}</span>
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <select
                          value={fb.finalCategory}
                          onChange={(e) =>
                            updateFeedback.mutate({ id: fb.id, finalCategory: e.target.value })
                          }
                          className="rounded border border-border bg-surface/50 px-2 py-1 text-[11px] text-text-primary focus:border-primary focus:outline-none"
                        >
                          {CATEGORIES.map((cat) => (
                            <option key={cat} value={cat}>
                              {formatCategory(cat)}
                            </option>
                          ))}
                        </select>
                        <button
                          onClick={() => deleteFeedback.mutate(fb.id)}
                          className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-red-500"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Pagination */}
              {meta && meta.totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 pt-1">
                  <button
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="rounded px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface disabled:opacity-30"
                  >
                    Previous
                  </button>
                  <span className="text-[11px] text-text-tertiary">
                    {meta.page} / {meta.totalPages}
                  </span>
                  <button
                    onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
                    disabled={page >= meta.totalPages}
                    className="rounded px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-surface disabled:opacity-30"
                  >
                    Next
                  </button>
                </div>
              )}

              {/* Add manual rule */}
              {!showAddForm ? (
                <button
                  onClick={() => setShowAddForm(true)}
                  className="flex items-center gap-1 text-[11px] font-medium text-primary transition-colors hover:text-primary/80"
                >
                  <Plus className="h-3 w-3" />
                  Add manual rule
                </button>
              ) : (
                <div className="flex items-end gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
                  <div className="min-w-0 flex-1 space-y-2">
                    <input
                      type="text"
                      value={newSender}
                      onChange={(e) => setNewSender(e.target.value)}
                      placeholder="sender@example.com"
                      className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
                      onKeyDown={(e) => e.key === 'Enter' && handleAddRule()}
                    />
                    <select
                      value={newCategory}
                      onChange={(e) => setNewCategory(e.target.value)}
                      className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none"
                    >
                      {CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {formatCategory(cat)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <button
                      onClick={() => setShowAddForm(false)}
                      className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAddRule}
                      disabled={!newSender.includes('@') || createRule.isPending}
                      className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
                    >
                      <Plus className="h-3 w-3" />
                      Add
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Show add rule even when no feedback yet */}
      {stats && stats.feedbackCount === 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 rounded-lg bg-surface/50 px-3 py-2">
            <Sparkles className="h-3.5 w-3.5 text-text-tertiary" />
            <span className="text-[11px] text-text-tertiary">
              No triage decisions yet. Triage emails or add manual rules to train Orbi.
            </span>
          </div>
          {!showAddForm ? (
            <button
              onClick={() => setShowAddForm(true)}
              className="flex items-center gap-1 text-[11px] font-medium text-primary transition-colors hover:text-primary/80"
            >
              <Plus className="h-3 w-3" />
              Add manual rule
            </button>
          ) : (
            <div className="flex items-end gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3">
              <div className="min-w-0 flex-1 space-y-2">
                <input
                  type="text"
                  value={newSender}
                  onChange={(e) => setNewSender(e.target.value)}
                  placeholder="sender@example.com"
                  className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
                  onKeyDown={(e) => e.key === 'Enter' && handleAddRule()}
                />
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary focus:border-primary focus:outline-none"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {formatCategory(cat)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-1.5 shrink-0">
                <button
                  onClick={() => setShowAddForm(false)}
                  className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddRule}
                  disabled={!newSender.includes('@') || createRule.isPending}
                  className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
