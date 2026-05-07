import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

// ─────────────────────────────────────────────────────────────────────────────
// Drop-in TanStack Query → Convex replacement.
//
// Public surface preserved:
//   useSaveDraft()   — { mutate, mutateAsync, isPending }
//   useDeleteDraft() — { mutate, mutateAsync, isPending }
//   useSendDraft()   — { mutate, mutateAsync, isPending }
//   useDraftCount()  — { data, isLoading }
// ─────────────────────────────────────────────────────────────────────────────

interface SaveDraftParams {
  id?: Id<'emails'> | string;
  accountId: Id<'mailAccounts'> | string;
  threadId?: Id<'threads'> | string;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  toAddresses?: { email: string; name?: string }[];
  mode: 'compose' | 'reply' | 'forward';
  parentEmailId?: Id<'emails'> | string;
}

export function useSaveDraft() {
  const createFn = useMutation(api.drafts.create);
  const updateFn = useMutation(api.drafts.update);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (params: SaveDraftParams) => {
    setIsPending(true);
    try {
      if (params.id) {
        return await updateFn({
          draftId: params.id as Id<'emails'>,
          subject: params.subject,
          bodyHtml: params.bodyHtml,
          bodyText: params.bodyText,
          toAddresses: params.toAddresses,
        });
      }
      return await createFn({
        accountId: params.accountId as Id<'mailAccounts'>,
        threadId: params.threadId as Id<'threads'> | undefined,
        subject: params.subject,
        bodyHtml: params.bodyHtml,
        bodyText: params.bodyText,
        toAddresses: params.toAddresses,
        mode: params.mode,
        parentEmailId: params.parentEmailId as Id<'emails'> | undefined,
      });
    } finally {
      setIsPending(false);
    }
  };

  return {
    mutate: (params: SaveDraftParams) => {
      void mutateAsync(params);
    },
    mutateAsync,
    isPending,
    isLoading: isPending,
  };
}

export function useDeleteDraft() {
  const fn = useMutation(api.drafts.discard);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (draftId: Id<'emails'> | string) => {
    setIsPending(true);
    try {
      return await fn({ draftId: draftId as Id<'emails'> });
    } finally {
      setIsPending(false);
    }
  };

  return {
    mutate: (draftId: Id<'emails'> | string) => {
      void mutateAsync(draftId);
    },
    mutateAsync,
    isPending,
    isLoading: isPending,
  };
}

export function useSendDraft() {
  const fn = useMutation(api.drafts.sendDraft);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (args: {
    draftId: Id<'emails'> | string;
    undoWindowSeconds?: number;
  }) => {
    setIsPending(true);
    try {
      // The Convex `sendDraft` mutation owns the undo window (10s) — the
      // `undoWindowSeconds` arg is preserved on the public surface but
      // currently ignored server-side. Plumb it through if/when needed.
      return await fn({ draftId: args.draftId as Id<'emails'> });
    } finally {
      setIsPending(false);
    }
  };

  return {
    mutate: (args: Parameters<typeof mutateAsync>[0]) => {
      void mutateAsync(args);
    },
    mutateAsync,
    isPending,
    isLoading: isPending,
  };
}

export function useDraftCount() {
  const result = useQuery(api.drafts.count, {});
  return {
    data: result,
    isLoading: result === undefined,
    isError: false,
    error: undefined,
  };
}
