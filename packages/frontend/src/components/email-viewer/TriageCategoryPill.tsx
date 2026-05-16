import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTriageSuggestion, useTriageFeedback } from '../../hooks/useTriage';
import { ALL_TRIAGE_OPTIONS, TRIAGE_FOLDER_LABELS } from './TriageBanner';

const PILL_STYLES: Record<string, { bg: string; text: string; border: string }> = {
  primary: { bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
  notification: { bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200' },
  marketing: { bg: 'bg-pink-50', text: 'text-pink-700', border: 'border-pink-200' },
  spam: { bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200' },
};

interface TriageCategoryPillProps {
  threadId: string;
  latestEmailId: string | undefined;
}

export function TriageCategoryPill({ threadId, latestEmailId }: TriageCategoryPillProps) {
  const [showMenu, setShowMenu] = useState(false);
  const { data: suggestion, isLoading } = useTriageSuggestion(threadId);
  const feedback = useTriageFeedback();

  if (isLoading || !suggestion) return null;

  const currentCategory = suggestion.alreadyFiled
    ? suggestion.category
    : suggestion.isTriageCategory
      ? suggestion.category
      : 'primary';

  const label = TRIAGE_FOLDER_LABELS[currentCategory] ?? currentCategory;
  const style = PILL_STYLES[currentCategory] ?? PILL_STYLES.primary;

  const handleSelect = (category: string) => {
    if (!latestEmailId) return;
    const finalCategory = category === 'primary' ? 'other' : category;
    feedback.mutate({
      emailId: latestEmailId,
      threadId,
      suggestedCategory: currentCategory,
      finalCategory,
      wasConfirmed: category === currentCategory,
    });
    setShowMenu(false);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setShowMenu(!showMenu)}
        className={cn(
          'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-semibold transition-colors hover:opacity-80',
          style.bg, style.text, style.border,
        )}
      >
        {label}
        <ChevronDown className="h-2.5 w-2.5" />
      </button>

      {showMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-36 rounded-lg border border-border bg-white py-1 shadow-lg">
            {ALL_TRIAGE_OPTIONS.map((cat) => {
              const catStyle = PILL_STYLES[cat] ?? PILL_STYLES.primary;
              return (
                <button
                  key={cat}
                  onClick={() => handleSelect(cat)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-surface',
                    cat === currentCategory ? 'font-semibold' : 'text-text-primary',
                  )}
                >
                  <span className={cn('h-2 w-2 rounded-full', catStyle.bg, 'ring-1', catStyle.border)} />
                  {TRIAGE_FOLDER_LABELS[cat]}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
