import { useState } from 'react';
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

export interface BlockedSender {
  id: string;
  emailAddress: string | null;
  domain: string | null;
  reason: string | null;
  createdAt: number;
}

function shape(b: any): BlockedSender {
  return {
    id: b._id ?? b.id,
    emailAddress: b.emailAddress ?? null,
    domain: b.domain ?? null,
    reason: b.reason ?? null,
    createdAt: b._creationTime ?? b.createdAt,
  };
}

export function useBlockedSenders() {
  const { isAuthenticated } = useConvexAuth();
  const data = useQuery(api.blockedSenders.list, isAuthenticated ? {} : 'skip');
  return {
    data: data ? data.map(shape) : undefined,
    isLoading: data === undefined,
  };
}

export function useBlockSender() {
  const fn = useMutation(api.blockedSenders.add);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    args: { emailAddress?: string; domain?: string; reason?: string },
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

export function useUnblockSender() {
  const fn = useMutation(api.blockedSenders.remove);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    id: string,
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const result = await fn({ id: id as Id<'blockedSenders'> });
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
