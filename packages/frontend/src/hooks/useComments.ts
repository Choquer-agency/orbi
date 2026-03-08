import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useComments(threadId: string | null) {
  return useQuery({
    queryKey: ['comments', threadId],
    queryFn: () => api.get<any>(`/threads/${threadId}/comments`),
    enabled: !!threadId,
  });
}

export function useAddComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ threadId, ...data }: { threadId: string; bodyHtml: string; bodyText: string }) =>
      api.post(`/threads/${threadId}/comments`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['comments', variables.threadId] });
      queryClient.invalidateQueries({ queryKey: ['thread', variables.threadId] });
    },
  });
}

export function useResolveComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => api.post(`/comments/${commentId}/resolve`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments'] });
    },
  });
}

export function useAddReaction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, emoji }: { commentId: string; emoji: string }) =>
      api.post(`/comments/${commentId}/reactions`, { emoji }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['comments'] });
    },
  });
}
