import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface Signature {
  id: string;
  name: string;
  bodyHtml: string;
  isDefault: boolean;
  accountId: string | null;
  account: { id: string; email: string; displayName: string | null } | null;
  createdAt: string;
  updatedAt: string;
}

export function useSignatures() {
  return useQuery({
    queryKey: ['signatures'],
    queryFn: () => api.get<{ data: Signature[] }>('/signatures'),
    select: (res) => res.data,
  });
}

export function useCreateSignature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { name: string; bodyHtml: string; isDefault?: boolean; accountId?: string | null }) =>
      api.post('/signatures', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['signatures'] });
    },
  });
}

export function useUpdateSignature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...updates }: { id: string; name?: string; bodyHtml?: string; isDefault?: boolean; accountId?: string | null }) =>
      api.patch(`/signatures/${id}`, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['signatures'] });
    },
  });
}

export function useDeleteSignature() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/signatures/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['signatures'] });
    },
  });
}
