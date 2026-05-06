import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface Classification {
  category: string;
  confidence: number;
  urgency: string;
  summary: string | null;
  manualOverride: boolean;
}

export function useClassification(emailId: string | undefined) {
  return useQuery({
    queryKey: ['classification', emailId],
    queryFn: () => api.get<{ data: Classification }>(`/emails/${emailId}/classification`),
    select: (res) => res.data,
    enabled: !!emailId,
  });
}

export function useOverrideClassification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ emailId, category }: { emailId: string; category: string }) =>
      api.patch(`/emails/${emailId}/classification`, { category }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['classification', vars.emailId] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });
}

export function useClassifyEmail() {
  return useMutation({
    mutationFn: (emailId: string) => api.post(`/emails/${emailId}/classify`),
  });
}

export function useCategories() {
  return useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ data: { id: string; label: string; color: string }[] }>('/classifications/categories'),
    select: (res) => res.data,
    staleTime: Infinity,
  });
}
