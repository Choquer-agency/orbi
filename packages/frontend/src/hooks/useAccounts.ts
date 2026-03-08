import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<any>('/accounts'),
  });
}

export function useDeleteAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/accounts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useStartOAuth() {
  return useMutation({
    mutationFn: async (provider: 'gmail' | 'microsoft') => {
      const isElectron = !!(window as any).electronAPI;
      const desktop = isElectron ? '?desktop=true' : '';
      const res = await api.get<any>(`/accounts/oauth/${provider}${desktop}`);
      window.location.href = res.data.url;
    },
  });
}
