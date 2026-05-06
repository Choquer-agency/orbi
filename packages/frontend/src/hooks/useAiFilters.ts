import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface AiFilter {
  id: string;
  name: string;
  description: string;
  conditions: {
    mode: 'ai' | 'rule';
    aiPrompt?: string;
    categories?: string[];
    senderPatterns?: string[];
    subjectContains?: string[];
  };
  actions: { type: 'archive' | 'star' | 'label' | 'trash'; value?: string }[];
  isActive: boolean;
  matchCount: number;
  lastMatchedAt: string | null;
  createdAt: string;
}

export function useAiFilters() {
  return useQuery({
    queryKey: ['ai-filters'],
    queryFn: () => api.get<{ data: AiFilter[] }>('/ai-filters'),
    select: (res) => res.data,
  });
}

export function useCreateAiFilter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      name: string;
      description: string;
      conditions: any;
      actions: any;
    }) => api.post('/ai-filters', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-filters'] });
    },
  });
}

export function useUpdateAiFilter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...updates }: { id: string; name?: string; description?: string; conditions?: any; actions?: any; isActive?: boolean }) =>
      api.patch(`/ai-filters/${id}`, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-filters'] });
    },
  });
}

export function useDeleteAiFilter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/ai-filters/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-filters'] });
    },
  });
}
