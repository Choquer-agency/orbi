import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface TrackingExclusion {
  id: string;
  emailAddress: string;
  reason: string | null;
  createdAt: string;
}

export function useTrackingExclusions() {
  return useQuery({
    queryKey: ['tracking-exclusions'],
    queryFn: () => api.get<{ data: TrackingExclusion[] }>('/settings/tracking-exclusions'),
    select: (res) => res.data,
  });
}

export function useAddTrackingExclusion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: { emailAddress: string; reason?: string }) =>
      api.post('/settings/tracking-exclusions', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tracking-exclusions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useDeleteTrackingExclusion() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.delete(`/settings/tracking-exclusions/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tracking-exclusions'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
