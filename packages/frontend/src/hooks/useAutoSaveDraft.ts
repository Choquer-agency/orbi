import { useRef, useState, useCallback, useEffect } from 'react';
import { useSaveDraft, useDeleteDraft } from './useDrafts';
import type { Id } from '../../../../convex/_generated/dataModel';

// ─────────────────────────────────────────────────────────────────────────────
// Drop-in replacement — same public API as before. Internally now backed by
// Convex mutations via useSaveDraft / useDeleteDraft (those are themselves
// thin wrappers around api.drafts.create / api.drafts.update / api.drafts.discard).
// ─────────────────────────────────────────────────────────────────────────────

interface AutoSaveOptions {
  accountId: Id<'mailAccounts'> | string;
  threadId?: Id<'threads'> | string;
  mode: 'compose' | 'reply' | 'forward';
  parentEmailId?: Id<'emails'> | string;
  existingDraftId?: Id<'emails'> | string;
  enabled: boolean;
}

interface DraftFields {
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  toAddresses?: { email: string; name?: string }[];
}

export function useAutoSaveDraft(options: AutoSaveOptions) {
  const { accountId, threadId, mode, parentEmailId, existingDraftId, enabled } = options;

  const draftIdRef = useRef<string | null>(
    existingDraftId ? String(existingDraftId) : null,
  );
  const [draftId, setDraftId] = useState<string | null>(
    existingDraftId ? String(existingDraftId) : null,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const saveVersionRef = useRef(0);
  const lastFieldsRef = useRef<DraftFields | null>(null);
  // Set once the user has clicked Send. Disarms further autosaves and the
  // unmount cleanup so neither can race with / undo the just-sent email.
  const sentRef = useRef(false);
  const sendingRef = useRef(false);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const saveDraftMutation = useSaveDraft();
  const deleteDraftMutation = useDeleteDraft();

  const saveDraft = useCallback(
    (fields: DraftFields): Promise<void> => {
      if (!enabled || !accountId || sentRef.current || sendingRef.current) return Promise.resolve();
      const hasContent =
        (fields.bodyText?.trim() || '') !== '' ||
        (mode !== 'reply' && ((fields.subject?.trim() || '') !== '' || (fields.toAddresses?.length ?? 0) > 0));
      if (!hasContent) return Promise.resolve();

      lastFieldsRef.current = fields;
      const version = ++saveVersionRef.current;
      setIsSaving(true);
      // Serialize create/update. A second autosave must wait for the first
      // create's ID, otherwise two draft rows are created for one composer.
      const save = saveQueueRef.current.then(async () => {
        if (sentRef.current) return;
        try {
          const result = await saveDraftMutation.mutateAsync({
            id: draftIdRef.current ?? undefined,
            accountId, threadId, mode, parentEmailId, ...fields,
          });
          // Always retain a created ID, even when a newer save is queued.
          // The version guard only controls the saving indicator.
          const created = (result as { data?: { id?: string } } | undefined)?.data;
          if (!draftIdRef.current && created?.id) {
            draftIdRef.current = String(created.id);
            setDraftId(String(created.id));
          }
          if (version === saveVersionRef.current) setLastSavedAt(new Date());
        } catch {
          // Keep the editor and crash-recovery copy available for retry.
        } finally {
          if (version === saveVersionRef.current) setIsSaving(false);
        }
      });
      saveQueueRef.current = save;
      return save;
    },
    [enabled, accountId, threadId, mode, parentEmailId, saveDraftMutation],
  );

  const prepareForSend = useCallback(async () => {
    // Disarm timer/background saves BEFORE uploading or sending. A create
    // already in flight must finish before the caller chooses its send path.
    sendingRef.current = true;
    await saveQueueRef.current;
    return draftIdRef.current;
  }, []);

  const resumeAfterSendFailure = useCallback(() => {
    if (!sentRef.current) sendingRef.current = false;
  }, []);

  const deleteDraft = useCallback(async () => {
    sentRef.current = true;
    await saveQueueRef.current;
    const id = draftIdRef.current;
    if (id) await deleteDraftMutation.mutateAsync(id);
    draftIdRef.current = null;
    setDraftId(null);
  }, [deleteDraftMutation]);

  const markSent = useCallback(async () => {
    // discard is a no-op for a converted/sent row. For a fresh or scheduled
    // send, retire the separate autosaved row so its Draft badge disappears.
    try {
      await deleteDraft();
      return true;
    } catch {
      // A cleanup failure must never turn a successful send into a retry.
      return false;
    }
  }, [deleteDraft]);

  // Cleanup empty drafts on unmount
  useEffect(() => {
    return () => {
      if (sentRef.current || sendingRef.current) return;
      const id = draftIdRef.current;
      const fields = lastFieldsRef.current;
      if (id && fields && !fields.bodyText?.trim()) {
        // Fire-and-forget delete of empty draft
        deleteDraftMutation.mutate(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { draftId, saveDraft, deleteDraft, markSent, prepareForSend, resumeAfterSendFailure, isSaving, lastSavedAt };
}
