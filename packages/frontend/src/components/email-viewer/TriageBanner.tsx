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
  // Sender of the latest email — passed through so the triage-folder banner
  // can offer an "always allow this sender / domain" prompt when moving an
  // email out of Spam.
  senderAddress?: string | undefined;
}

/**
 * Routes to the right subcomponent based on the folder context. Split because
 * the two flows need different hooks — the triage folder banner skips the AI
 * suggestion query entirely (we already know the category), so packing both
 * paths into one component would violate React's rules-of-hooks.
 */
export function TriageBanner(props: TriageBannerProps) {
  const selectedFolder = useUiStore((s) => s.selectedFolder);
  if (selectedFolder === 'spam' || selectedFolder === 'marketing') {
    return <TriageFolderBanner {...props} folder={selectedFolder} />;
  }
  if (selectedFolder === 'inbox') {
    return <InboxSuggestionBanner {...props} />;
  }
  return null;
}

// ─── Triage folder banner (Spam / Marketing) ──────────────────────────────

interface TriageFolderBannerProps extends TriageBannerProps {
  folder: 'spam' | 'marketing';
}

function TriageFolderBanner({
  threadId,
  latestEmailId,
  senderAddress,
  folder,
}: TriageFolderBannerProps) {
  const setSelectedThread = useUiStore((s) => s.setSelectedThread);
  const feedback = useTriageFeedback();
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  // When the user moves an email OUT of spam we want to ask if the sender
  // should be permanently allow-listed. The choice is exact-email vs the
  // whole @domain. This dialog state drives a small modal under the banner.
  const [allowPrompt, setAllowPrompt] = useState<{
    targetCategory: string;
  } | null>(null);

  const folderLabel = TRIAGE_FOLDER_LABELS[folder] ?? folder;
  const isSpam = folder === 'spam';

  const submitMove = (
    category: string,
    options?: { allowPattern?: string; allowKind?: 'email' | 'domain' },
  ) => {
    if (!latestEmailId) return;
    const finalCategory = category === 'primary' ? 'other' : category;
    feedback.mutate({
      emailId: latestEmailId,
      threadId,
      suggestedCategory: folder,
      finalCategory,
      wasConfirmed: category === folder,
      allowPattern: options?.allowPattern,
      allowKind: options?.allowKind,
    });
    setShowMoveMenu(false);
    if (category !== folder) {
      setSelectedThread(null);
    }
  };

  const handleConfirmHere = () => {
    if (!latestEmailId) return;
    feedback.mutate({
      emailId: latestEmailId,
      threadId,
      suggestedCategory: folder,
      finalCategory: folder,
      wasConfirmed: true,
    });
  };

  const handleMoveToFromTriage = (category: string) => {
    setShowMoveMenu(false);
    // Moving OUT of spam → offer to allowlist the sender so this never
    // happens again. We only prompt for spam — moving Marketing→Primary
    // is too noisy to ask about every time.
    if (isSpam && category !== folder && senderAddress) {
      setAllowPrompt({ targetCategory: category });
      return;
    }
    submitMove(category);
  };

  const accent = isSpam
    ? { border: 'border-red-200', bg: 'bg-red-50/80', icon: 'text-red-500', text: 'text-red-800', btn: 'bg-red-600 hover:bg-red-700', link: 'text-red-600 hover:bg-red-100' }
    : { border: 'border-amber-200', bg: 'bg-amber-50/80', icon: 'text-amber-500', text: 'text-amber-800', btn: 'bg-amber-600 hover:bg-amber-700', link: 'text-amber-600 hover:bg-amber-100' };

  return (
    <>
      <div className={cn('mx-5 my-3 flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5', accent.border, accent.bg)}>
        <FolderInput className={cn('h-4 w-4 shrink-0', accent.icon)} />
        <span className={cn('min-w-0 flex-1 text-[12px] font-medium', accent.text)}>
          Orbi filed this as <span className="font-bold">{folderLabel}</span>
          {isSpam ? ' — is this junk?' : ' — keep it here?'}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={handleConfirmHere}
            disabled={feedback.isPending}
            className={cn('inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-white transition-colors disabled:opacity-50', accent.btn)}
          >
            <Check className="h-3 w-3" />
            {isSpam ? "Yes, it's junk" : 'Keep here'}
          </button>
          <div className="relative">
            <button
              onClick={() => setShowMoveMenu(!showMoveMenu)}
              className={cn('inline-flex items-center gap-0.5 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors', accent.link)}
            >
              Move to
              <ChevronDown className="h-3 w-3" />
            </button>
            {showMoveMenu && (
              <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-lg border border-border bg-white py-1 shadow-lg">
                {ALL_TRIAGE_OPTIONS.filter((c) => c !== folder).map((cat) => (
                  <button
                    key={cat}
                    onClick={() => handleMoveToFromTriage(cat)}
                    className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-text-primary transition-colors hover:bg-surface"
                  >
                    {TRIAGE_FOLDER_LABELS[cat]}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {allowPrompt && senderAddress && (
        <AllowSenderDialog
          targetCategoryLabel={TRIAGE_FOLDER_LABELS[allowPrompt.targetCategory] ?? allowPrompt.targetCategory}
          senderAddress={senderAddress}
          onChoose={(kind) => {
            const domain = senderAddress.split('@')[1] ?? '';
            const pattern = kind === 'email' ? senderAddress : `@${domain}`;
            submitMove(allowPrompt.targetCategory, { allowPattern: pattern, allowKind: kind });
            setAllowPrompt(null);
          }}
          onSkip={() => {
            submitMove(allowPrompt.targetCategory);
            setAllowPrompt(null);
          }}
          onCancel={() => setAllowPrompt(null)}
        />
      )}
    </>
  );
}

// ─── Inbox suggestion banner (existing behavior) ──────────────────────────

function InboxSuggestionBanner({ threadId, latestEmailId }: TriageBannerProps) {
  const setSelectedThread = useUiStore((s) => s.setSelectedThread);
  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const [dismissedThreadId, setDismissedThreadId] = useState<string | null>(null);
  const { data: suggestion, isLoading } = useTriageSuggestion(threadId);
  const feedback = useTriageFeedback();

  if (isLoading) return null;
  if (!suggestion) return null;
  if (dismissedThreadId === threadId) return null;

  const suggestedCategory = suggestion.isTriageCategory ? suggestion.category : 'primary';
  if (suggestedCategory === 'primary' && !suggestion.alreadyFiled) return null;

  const folderLabel = TRIAGE_FOLDER_LABELS[suggestedCategory] ?? suggestedCategory;

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
    // Map "primary" back to "other" when the user explicitly selects it from
    // the move menu (suggestedCategory is "primary" only when no triage applies).
    const finalCategory = category === 'primary' ? 'other' : category;
    void submitFeedbackAndHide(finalCategory, category === suggestedCategory);
    if (category === 'marketing' || category === 'spam') {
      setSelectedThread(null);
    }
  };

  return (
    <div className="mx-5 my-3 flex items-center gap-2.5 rounded-lg border border-indigo-200 bg-indigo-50/80 px-3.5 py-2.5">
      <FolderInput className="h-4 w-4 shrink-0 text-indigo-500" />
      <span className="min-w-0 flex-1 text-[12px] font-medium text-indigo-800">
        Orbi would place this in <span className="font-bold">{folderLabel}</span>
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

// ─── Sender-rule dialog (always-allow OR always-spam) ────────────────────

/** Reusable dialog for both directions:
 *   - mode='allow' — moving OUT of spam → "always let this sender into inbox"
 *   - mode='spam'  — moving anything INTO spam → "always send this sender to spam"
 */
export function SenderRuleDialog({
  mode,
  targetCategoryLabel,
  senderAddress,
  onChoose,
  onSkip,
  onCancel,
}: {
  mode: 'allow' | 'spam';
  targetCategoryLabel: string;
  senderAddress: string;
  onChoose: (kind: 'email' | 'domain') => void;
  onSkip: () => void;
  onCancel: () => void;
}) {
  const domain = senderAddress.split('@')[1] ?? '';
  const isAllow = mode === 'allow';
  const title = isAllow ? 'Always allow this sender?' : 'Always send to spam?';
  const intro = isAllow
    ? <>We'll move this to <span className="font-medium text-text-primary">{targetCategoryLabel}</span>. Want future emails from this sender to skip Spam too?</>
    : <>We'll send this to <span className="font-medium text-text-primary">Spam</span>. Want future emails from this sender to go straight to Spam too?</>;
  const emailHint = isAllow
    ? 'Only this exact email address skips Spam in the future.'
    : 'Only this exact email address goes to Spam in the future.';
  const domainHint = isAllow
    ? 'Every sender from this domain skips Spam in the future.'
    : 'Every sender from this domain goes to Spam in the future.';
  const skipLabel = isAllow ? 'Just move this one' : 'Just spam this one';
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-1 text-[14px] font-semibold text-text-primary">{title}</h3>
        <p className="mb-4 text-[12px] leading-relaxed text-text-secondary">{intro}</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={() => onChoose('email')}
            className="flex w-full flex-col items-start rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
          >
            <span className="text-[12px] font-semibold text-text-primary">
              Just {senderAddress}
            </span>
            <span className="text-[11px] text-text-tertiary">{emailHint}</span>
          </button>
          {domain && (
            <button
              onClick={() => onChoose('domain')}
              className="flex w-full flex-col items-start rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"
            >
              <span className="text-[12px] font-semibold text-text-primary">
                Anyone at @{domain}
              </span>
              <span className="text-[11px] text-text-tertiary">{domainHint}</span>
            </button>
          )}
          <button
            onClick={onSkip}
            className="mt-1 w-full rounded-lg px-3 py-2 text-[12px] text-text-tertiary transition-colors hover:bg-surface"
          >
            {skipLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Back-compat alias for the existing allow-sender flow inside TriageBanner.
function AllowSenderDialog(props: Omit<Parameters<typeof SenderRuleDialog>[0], 'mode'>) {
  return <SenderRuleDialog mode="allow" {...props} />;
}
