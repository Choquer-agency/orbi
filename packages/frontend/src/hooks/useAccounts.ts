import { useState } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { isNative } from '../lib/platform';

// ─────────────────────────────────────────────────────────────────────────────
// Drop-in TanStack Query → Convex replacement (mailAccounts CRUD).
//
// Public surface preserved:
//   useAccounts()         — { data, isLoading }; data is the list array
//   useDeleteAccount()    — { mutate, mutateAsync, isPending }
//   useStartOAuth()       — { mutate, mutateAsync, isPending }
//   useUpdateAccount()    — { mutate, mutateAsync, isPending }
//   useSyncAccount()      — { mutate, mutateAsync, isPending }
// ─────────────────────────────────────────────────────────────────────────────

export function useAccounts() {
  const result = useQuery(api.mailAccounts.list, {});
  return {
    data: result,
    isLoading: result === undefined,
    isError: false,
    error: undefined,
  };
}

export function useDeleteAccount() {
  const fn = useMutation(api.mailAccounts.disconnect);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (id: Id<'mailAccounts'> | string) => {
    setIsPending(true);
    try {
      return await fn({ accountId: id as Id<'mailAccounts'> });
    } finally {
      setIsPending(false);
    }
  };

  return {
    mutate: (id: Id<'mailAccounts'> | string) => {
      void mutateAsync(id);
    },
    mutateAsync,
    isPending,
    isLoading: isPending,
  };
}

export function useStartOAuth() {
  const getOAuthUrl = useAction(api.mailAccounts.getOAuthUrl);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (provider: 'gmail' | 'microsoft') => {
    setIsPending(true);
    try {
      const isElectron = !!(window as any).electronAPI;
      const native = isNative();
      const platform = isElectron ? 'desktop' : native ? 'capacitor' : 'web';

      const res = await getOAuthUrl({
        provider: provider === 'gmail' ? 'GMAIL' : 'MICROSOFT',
        platform,
      });
      const url = res?.url;
      if (!url) throw new Error('No OAuth URL returned');

      if (native) {
        const { Browser } = await import('@capacitor/browser');
        await Browser.open({ url, presentationStyle: 'popover' });
      } else if (isElectron) {
        // Hand the OAuth URL to the system browser via the Electron bridge.
        // Otherwise window.location.href would replace the app's main window
        // with the provider's login page and the user has no way back.
        const w = window as unknown as { electronAPI?: { openExternal?: (u: string) => Promise<void> } };
        await w.electronAPI?.openExternal?.(url);
      } else {
        window.location.href = url;
      }
    } catch (err) {
      console.error('[oauth] error:', err);
      throw err;
    } finally {
      setIsPending(false);
    }
  };

  return {
    mutate: (provider: 'gmail' | 'microsoft') => {
      void mutateAsync(provider);
    },
    mutateAsync,
    isPending,
    isLoading: isPending,
  };
}

export function useUpdateAccount() {
  const fn = useMutation(api.mailAccounts.updateDisplayName);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (args: {
    id: Id<'mailAccounts'> | string;
    displayName?: string | null;
  }) => {
    setIsPending(true);
    try {
      return await fn({
        accountId: args.id as Id<'mailAccounts'>,
        displayName: args.displayName ?? undefined,
      });
    } finally {
      setIsPending(false);
    }
  };

  return {
    mutate: (args: Parameters<typeof mutateAsync>[0]) => {
      void mutateAsync(args);
    },
    mutateAsync,
    isPending,
    isLoading: isPending,
  };
}

export function useSetAccountColor() {
  const fn = useMutation(api.mailAccounts.setColor);
  const [isPending, setIsPending] = useState(false);
  const mutateAsync = async (args: {
    id: Id<'mailAccounts'> | string;
    color: string | null;
  }) => {
    setIsPending(true);
    try {
      return await fn({
        accountId: args.id as Id<'mailAccounts'>,
        color: args.color,
      });
    } finally {
      setIsPending(false);
    }
  };
  return {
    mutate: (args: Parameters<typeof mutateAsync>[0]) => {
      void mutateAsync(args);
    },
    mutateAsync,
    isPending,
  };
}

export function useSyncAccount() {
  const fn = useMutation(api.mailAccounts.triggerSync);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (id: Id<'mailAccounts'> | string) => {
    setIsPending(true);
    try {
      return await fn({ accountId: id as Id<'mailAccounts'> });
    } finally {
      setIsPending(false);
    }
  };

  return {
    mutate: (id: Id<'mailAccounts'> | string) => {
      void mutateAsync(id);
    },
    mutateAsync,
    isPending,
    isLoading: isPending,
  };
}
