import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { isNative } from '../lib/platform';

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
      const native = isNative();
      const platform = isElectron ? 'desktop' : native ? 'capacitor' : 'web';
      const res = await api.get<any>(`/accounts/oauth/${provider}?platform=${platform}`);
      console.log('[oauth] response:', JSON.stringify(res));
      const url = res?.data?.url ?? res?.url;
      if (!url) {
        throw new Error('No OAuth URL returned');
      }

      if (native) {
        // Open OAuth in SFSafariViewController (required by Google and Apple policies)
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url, presentationStyle: 'popover' });
      } else {
        window.location.href = url;
      }
    },
    onError: (err) => {
      console.error('[oauth] error:', err);
    },
  });
}

export function useUpdateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; displayName?: string }) =>
      api.patch(`/accounts/${id}`, data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['accounts'] }),
  });
}

export function useSyncAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/accounts/${id}/sync`),
    onSuccess: () => {
      // Refetch threads after sync is queued (with a small delay for processing)
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['threads'] });
        queryClient.invalidateQueries({ queryKey: ['accounts'] });
      }, 3000);
    },
  });
}
