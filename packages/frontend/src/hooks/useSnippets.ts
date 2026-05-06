import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface Snippet {
  id: string;
  name: string;
  bodyHtml: string;
  bodyText: string;
  category: string | null;
  variables: string[];
  createdAt: string;
}

export function useSnippets() {
  return useQuery({
    queryKey: ['snippets'],
    queryFn: () => api.get<{ data: Snippet[] }>('/snippets'),
    select: (res) => res.data,
  });
}

export function useCreateSnippet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      name: string;
      bodyHtml: string;
      bodyText: string;
      category?: string;
      variables?: string[];
    }) => api.post('/snippets', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['snippets'] });
    },
  });
}

export function useUpdateSnippet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...updates }: {
      id: string;
      name?: string;
      bodyHtml?: string;
      bodyText?: string;
      category?: string;
      variables?: string[];
    }) => api.patch(`/snippets/${id}`, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['snippets'] });
    },
  });
}

export function useDeleteSnippet() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/snippets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['snippets'] });
    },
  });
}
