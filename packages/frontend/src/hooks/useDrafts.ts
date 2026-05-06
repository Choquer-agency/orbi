import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface SaveDraftParams {
  id?: string;
  accountId: string;
  threadId?: string;
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  toAddresses?: { email: string; name?: string }[];
  mode: 'compose' | 'reply' | 'forward';
  parentEmailId?: string;
}

export function useSaveDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: SaveDraftParams) => {
      if (params.id) {
        // Update existing draft
        return api.patch<{ data: any }>(`/drafts/${params.id}`, {
          subject: params.subject,
          bodyHtml: params.bodyHtml,
          bodyText: params.bodyText,
          toAddresses: params.toAddresses,
        });
      }
      // Create new draft
      return api.post<{ data: { id: string; threadId: string } }>('/drafts', {
        accountId: params.accountId,
        threadId: params.threadId,
        subject: params.subject,
        bodyHtml: params.bodyHtml,
        bodyText: params.bodyText,
        toAddresses: params.toAddresses,
        mode: params.mode,
        parentEmailId: params.parentEmailId,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['draft-count'] });
    },
  });
}

export function useDeleteDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draftId: string) => api.delete(`/drafts/${draftId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['draft-count'] });
    },
  });
}

export function useSendDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ draftId, undoWindowSeconds }: { draftId: string; undoWindowSeconds?: number }) =>
      api.post<{ data: any }>(`/drafts/${draftId}/send`, { undoWindowSeconds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['draft-count'] });
    },
  });
}

export function useDraftCount() {
  return useQuery({
    queryKey: ['draft-count'],
    queryFn: () => api.get<{ data: { count: number } }>('/drafts/count'),
  });
}
