import { useState } from 'react';
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

interface TrackingExclusion {
  id: string;
  emailAddress: string;
  reason: string | null;
  createdAt: number;
}

function shape(e: any): TrackingExclusion {
  return {
    id: e._id ?? e.id,
    emailAddress: e.emailAddress,
    reason: e.reason ?? null,
    createdAt: e._creationTime ?? e.createdAt,
  };
}

export function useTrackingExclusions() {
  const { isAuthenticated } = useConvexAuth();
  const data = useQuery(api.trackingExclusions.list, isAuthenticated ? {} : 'skip');
  return {
    data: data ? data.map(shape) : undefined,
    isLoading: data === undefined,
  };
}

export function useAddTrackingExclusion() {
  const fn = useMutation(api.trackingExclusions.add);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    args: { emailAddress: string; reason?: string },
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

export function useDeleteTrackingExclusion() {
  const fn = useMutation(api.trackingExclusions.remove);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    id: string,
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const result = await fn({ id: id as Id<'trackingExclusions'> });
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
