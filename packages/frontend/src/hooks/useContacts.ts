import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../lib/api';

/**
 * Returns a function that resolves an email address to a display name.
 * Uses a cached name map from the contacts/persons system.
 * Falls back to the provided fromName or email address.
 */
export function useContactNameResolver() {
  const { data } = useQuery({
    queryKey: ['contact-name-map'],
    queryFn: () => api.get<{ data: Record<string, string> }>('/contacts/name-map'),
    staleTime: 60_000, // 1 minute
    refetchOnWindowFocus: false,
  });

  const nameMap = data?.data ?? {};

  const resolveName = useCallback(
    (fromAddress: string | undefined | null, fromName: string | undefined | null): string => {
      if (!fromAddress) return fromName || 'Unknown';
      const resolved = nameMap[fromAddress.toLowerCase()];
      if (resolved) return resolved;
      return fromName || fromAddress;
    },
    [nameMap],
  );

  return resolveName;
}

export function useContacts(params: { q?: string; page?: number; limit?: number } = {}) {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));

  return useQuery({
    queryKey: ['contacts', params],
    queryFn: () => api.get<{ data: any[]; meta: any }>(`/contacts?${query}`),
  });
}

export function useContact(id: string | null) {
  return useQuery({
    queryKey: ['contact', id],
    queryFn: () => api.get<{ data: any }>(`/contacts/${id}`),
    enabled: !!id,
  });
}

export function useContactThreads(id: string | null) {
  return useQuery({
    queryKey: ['contact-threads', id],
    queryFn: () => api.get<{ data: any[] }>(`/contacts/${id}/threads`),
    enabled: !!id,
  });
}

export function useUpdateContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [key: string]: any }) =>
      api.patch(`/contacts/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contacts'] });
      qc.invalidateQueries({ queryKey: ['contact'] });
    },
  });
}

export function useContactAutocomplete(query: string) {
  return useQuery({
    queryKey: ['contact-autocomplete', query],
    queryFn: () => api.get<{ data: any[] }>(`/contacts/autocomplete?q=${encodeURIComponent(query)}`),
    enabled: query.trim().length >= 1,
    staleTime: 10_000,
  });
}
