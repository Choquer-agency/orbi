import { useState } from 'react';
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

export interface Signature {
  id: string;
  name: string;
  bodyHtml: string;
  isDefault: boolean;
  accountId: string | null;
  account: { id: string; email: string; displayName: string | null } | null;
  createdAt: number;
  updatedAt?: number;
}

function shape(s: any): Signature {
  return {
    id: s.id ?? s._id,
    name: s.name,
    bodyHtml: s.bodyHtml,
    isDefault: s.isDefault,
    accountId: s.accountId ?? null,
    account: s.account
      ? {
          id: s.account.id,
          email: s.account.email,
          displayName: s.account.displayName ?? null,
        }
      : null,
    createdAt: s.createdAt ?? s._creationTime,
  };
}

export function useSignatures() {
  const { isAuthenticated } = useConvexAuth();
  const data = useQuery(api.signatures.list, isAuthenticated ? {} : 'skip');
  return {
    data: data ? data.map(shape) : undefined,
    isLoading: data === undefined,
  };
}

export function useCreateSignature() {
  const fn = useMutation(api.signatures.create);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    args: { name: string; bodyHtml: string; isDefault?: boolean; accountId?: string | null },
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const result = await fn(args);
      opts?.onSuccess?.(result);
      return result;
    } catch (err) {
      opts?.onError?.(err);
      throw err;
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useUpdateSignature() {
  const fn = useMutation(api.signatures.update);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    args: { id: string; name?: string; bodyHtml?: string; isDefault?: boolean; accountId?: string | null },
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const { id, ...rest } = args;
      const result = await fn({ id: id as Id<'signatures'>, ...rest });
      opts?.onSuccess?.(result);
      return result;
    } catch (err) {
      opts?.onError?.(err);
      throw err;
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useDeleteSignature() {
  const fn = useMutation(api.signatures.remove);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    id: string,
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const result = await fn({ id: id as Id<'signatures'> });
      opts?.onSuccess?.(result);
      return result;
    } catch (err) {
      opts?.onError?.(err);
      throw err;
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}
