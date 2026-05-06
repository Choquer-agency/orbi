import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { ComposeInline } from './ComposeInline';
import { haptic } from '../../lib/haptics';

export function MobileComposeSheet() {
  const setComposingNew = useUiStore((s) => s.setComposingNew);
  const pendingDraft = useUiStore((s) => s.pendingDraft);
  const setPendingDraft = useUiStore((s) => s.setPendingDraft);
  const [isClosing, setIsClosing] = useState(false);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      setComposingNew(false);
      setPendingDraft(null);
      setIsClosing(false);
    }, 250);
  };

  return (
    <AnimatePresence>
      {!isClosing && (
        <>
          {/* Backdrop */}
          <motion.div
            className="fixed inset-0 z-50 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            onClick={handleClose}
          />

          {/* Sheet */}
          <motion.div
            className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-2xl bg-surface shadow-2xl"
            style={{ top: '12px', paddingBottom: 'max(env(safe-area-inset-bottom, 0px), var(--keyboard-height, 0px))' }}
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', damping: 30, stiffness: 300 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={(_, info) => {
              if (info.offset.y > 100) {
                haptic.light();
                handleClose();
              }
            }}
          >
            {/* Drag handle */}
            <div className="flex justify-center py-2">
              <div className="h-1 w-8 rounded-full bg-border" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-4 pb-3">
              <button
                onClick={handleClose}
                className="flex h-8 w-8 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface"
                aria-label="Close compose"
              >
                <X className="h-5 w-5" />
              </button>
              <span className="text-sm font-semibold text-text-primary">New Message</span>
              <div className="w-8" /> {/* Spacer for centering */}
            </div>

            {/* Compose body */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <ComposeInline
                mode="compose"
                onClose={handleClose}
                initialDraft={pendingDraft ? { body: pendingDraft.body, bodyHtml: pendingDraft.bodyHtml, to: pendingDraft.to, subject: pendingDraft.subject } : undefined}
                aiOriginal={pendingDraft?.aiOriginal}
                existingDraftId={pendingDraft?.draftId}
              />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
