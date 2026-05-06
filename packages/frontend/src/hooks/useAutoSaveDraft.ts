import { useRef, useState, useCallback, useEffect } from 'react';
import { useSaveDraft, useDeleteDraft } from './useDrafts';

interface AutoSaveOptions {
  accountId: string;
  threadId?: string;
  mode: 'compose' | 'reply' | 'forward';
  parentEmailId?: string;
  existingDraftId?: string;
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

  const draftIdRef = useRef<string | null>(existingDraftId ?? null);
  const [draftId, setDraftId] = useState<string | null>(existingDraftId ?? null);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const saveVersionRef = useRef(0);
  const lastFieldsRef = useRef<DraftFields | null>(null);

  const saveDraftMutation = useSaveDraft();
  const deleteDraftMutation = useDeleteDraft();

  const saveDraft = useCallback(
    async (fields: DraftFields) => {
      if (!enabled || !accountId) return;

      // Skip if nothing meaningful to save
      const hasContent = (fields.bodyText?.trim() || '') !== '' ||
        (fields.subject?.trim() || '') !== '' ||
        (fields.toAddresses?.length ?? 0) > 0;
      if (!hasContent) return;

      lastFieldsRef.current = fields;
      const version = ++saveVersionRef.current;
      setIsSaving(true);

      try {
        const result = await saveDraftMutation.mutateAsync({
          id: draftIdRef.current ?? undefined,
          accountId,
          threadId,
          mode,
          parentEmailId,
          ...fields,
        });

        // Only update state if this is still the latest save
        if (version === saveVersionRef.current) {
          if (!draftIdRef.current && result?.data?.id) {
            draftIdRef.current = result.data.id;
            setDraftId(result.data.id);
          }
          setLastSavedAt(new Date());
        }
      } catch {
        // Auto-save failures are non-critical
      } finally {
        if (version === saveVersionRef.current) {
          setIsSaving(false);
        }
      }
    },
    [enabled, accountId, threadId, mode, parentEmailId, saveDraftMutation],
  );

  const deleteDraft = useCallback(async () => {
    if (draftIdRef.current) {
      try {
        await deleteDraftMutation.mutateAsync(draftIdRef.current);
      } catch {
        // Ignore delete failures
      }
      draftIdRef.current = null;
      setDraftId(null);
    }
  }, [deleteDraftMutation]);

  // Cleanup empty drafts on unmount
  useEffect(() => {
    return () => {
      const id = draftIdRef.current;
      const fields = lastFieldsRef.current;
      if (id && (!fields?.bodyText?.trim())) {
        // Fire-and-forget delete of empty draft
        deleteDraftMutation.mutate(id);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { draftId, saveDraft, deleteDraft, isSaving, lastSavedAt };
}
