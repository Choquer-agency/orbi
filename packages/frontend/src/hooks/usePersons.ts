import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export function usePersons(params: { q?: string; page?: number; limit?: number } = {}) {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));

  return useQuery({
    queryKey: ['persons', params],
    queryFn: () => api.get<{ data: any[]; meta: any }>(`/persons?${query}`),
  });
}

export function usePerson(id: string | null) {
  return useQuery({
    queryKey: ['person', id],
    queryFn: () => api.get<{ data: any }>(`/persons/${id}`),
    enabled: !!id,
  });
}

export function usePersonThreads(id: string | null) {
  return useQuery({
    queryKey: ['person-threads', id],
    queryFn: () => api.get<{ data: any[] }>(`/persons/${id}/threads`),
    enabled: !!id,
  });
}

export function useUpdatePerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [key: string]: any }) =>
      api.patch(`/persons/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['persons'] });
      qc.invalidateQueries({ queryKey: ['person'] });
    },
  });
}

export function useMergePersons() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (personIds: string[]) =>
      api.post('/persons/merge', { personIds }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['persons'] });
      qc.invalidateQueries({ queryKey: ['person'] });
    },
  });
}

export function useUnlinkContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ personId, contactId }: { personId: string; contactId: string }) =>
      api.post(`/persons/${personId}/unlink`, { contactId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['persons'] });
      qc.invalidateQueries({ queryKey: ['person'] });
    },
  });
}

export function usePersonAutocomplete(query: string) {
  return useQuery({
    queryKey: ['person-autocomplete', query],
    queryFn: () => api.get<{ data: any[] }>(`/persons/autocomplete?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length >= 1,
    staleTime: 10_000,
  });
}

export function useBackfillPersons() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/persons/backfill', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['persons'] });
    },
  });
}
