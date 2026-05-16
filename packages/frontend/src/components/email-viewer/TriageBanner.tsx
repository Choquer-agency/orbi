import { useState } from 'react';
import { FolderInput, Check, ChevronDown, FolderCheck } from 'lucide-react';
import { cn } from '../../lib/utils';
import { clearTriageSuggestionCache, useTriageSuggestion, useTriageFeedback } from '../../hooks/useTriage';
import { useUiStore } from '../../stores/uiStore';

export const TRIAGE_FOLDER_LABELS: Record<string, string> = {
  primary: 'Primary',
  notification: 'Notification',
  marketing: 'Marketing',
  spam: 'Spam',
};

export const ALL_TRIAGE_OPTIONS = ['primary', 'notification', 'marketing', 'spam'];

interface TriageBannerProps {
  threadId: string;
  latestEmailId: string | undefined;
}

/** Full banner for marketing/spam suggestions — shows "Orbi would place this in X" */
export function TriageBanner({ threadId, latestEmailId }: TriageBannerProps) {
  const selectedFolder = useUiStore((s) => s.selectedFolder);
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [dismissedThreadId, setDismissedThreadId] = useState<string | null>(null);

  const { data: suggestion, isLoading } = useTriageSuggestion(
    selectedFolder === 'inbox' ? threadId : null,
  );
  const feedback = useTriageFeedback();

  if (selectedFolder !== 'inbox') return null;
  if (dismissedThreadId === threadId) return null;
  if (isLoading) return null;
  if (!suggestion) return null;

  // Map classification to a triage option
  const suggestedCategory = suggestion.isTriageCategory ? suggestion.category : 'primary';

  // Don't show banner for primary — the header pill handles that
  if (suggestedCategory === 'primary' && !suggestion.alreadyFiled) return null;

  const folderLabel = TRIAGE_FOLDER_LABELS[suggestedCategory] ?? suggestedCategory;

  // Already filed — persistent indicator
  if (suggestion.alreadyFiled) {
    const filedLabel = TRIAGE_FOLDER_LABELS[suggestion.category] ?? suggestion.category;
    return (
      <div className="mx-5 my-3 flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/80 px-3.5 py-2.5">
        <FolderCheck className="h-3.5 w-3.5 text-emerald-500" />
        <span className="text-[12px] font-medium text-emerald-700">
          Filed in <span className="font-bold">{filedLabel}</span>
        </span>
      </div>
    );
  }

  const submitFeedbackAndHide = async (finalCategory: string, wasConfirmed: boolean) => {
    if (!latestEmailId) return;
    setDismissedThreadId(threadId);
    setShowMoveMenu(false);
    clearTriageSuggestionCache(threadId);
    try {
      await feedback.mutateAsync({
        emailId: latestEmailId,
        threadId,
        suggestedCategory,
        finalCategory,
        wasConfirmed,
      });
    } catch {
      // Restore the banner if the write failed so the user can retry.
      setDismissedThreadId(null);
    }
  };

  const handleConfirm = () => {
    void submitFeedbackAndHide(suggestedCategory, true);
  };

  const handleMoveTo = (category: string) => {
    void submitFeedbackAndHide(category, category === suggestedCategory);
  };

  return (
    <div className="mx-5 my-3 flex items-center gap-2.5 rounded-lg border border-indigo-200 bg-indigo-50/80 px-3.5 py-2.5">
      <FolderInput className="h-4 w-4 shrink-0 text-indigo-500" />

      <span className="min-w-0 flex-1 text-[12px] font-medium text-indigo-800">
        Orbi would place this in{' '}
        <span className="font-bold">{folderLabel}</span>
      </span>

      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={handleConfirm}
          disabled={feedback.isPending}
          className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-indigo-700 disabled:opacity-50"
        >
          <Check className="h-3 w-3" />
          Yes
        </button>

        <div className="relative">
          <button
            onClick={() => setShowMoveMenu(!showMoveMenu)}
            className="inline-flex items-center gap-0.5 rounded-md px-2 py-1 text-[11px] font-semibold text-indigo-600 transition-colors hover:bg-indigo-100"
          >
            Move to
            <ChevronDown className="h-3 w-3" />
          </button>

          {showMoveMenu && (
            <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-lg border border-border bg-white py-1 shadow-lg">
              {ALL_TRIAGE_OPTIONS.map((cat) => (
                <button
                  key={cat}
                  onClick={() => handleMoveTo(cat)}
                  className={cn(
                    'flex w-full items-center px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-surface',
                    cat === suggestedCategory
                      ? 'font-semibold text-indigo-600'
                      : 'text-text-primary',
                  )}
                >
                  {TRIAGE_FOLDER_LABELS[cat]}
                  {cat === suggestedCategory && (
                    <span className="ml-auto text-[10px] text-text-tertiary">suggested</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
