import { useEffect, useState } from 'react';
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '../../../../convex/_generated/api';

export interface InboxSplit {
  id: string;
  category: string;
  label: string;
  position: number;
  isEnabled: boolean;
}

function shape(s: any): InboxSplit {
  return {
    id: s._id ?? s.id,
    category: s.category,
    label: s.label,
    position: s.position,
    isEnabled: s.isEnabled,
  };
}

export function useInboxSplits() {
  const { isAuthenticated } = useConvexAuth();
  const data = useQuery(api.inboxSplits.list, isAuthenticated ? {} : 'skip');
  const ensure = useMutation(api.inboxSplits.ensureDefaults);

  // Seed defaults once on first load if the user has no splits yet.
  // Convex queries can't write, so we trigger ensureDefaults from the client
  // when `list` returns an empty array.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!isAuthenticated) return;
    if (data && data.length === 0 && !seeded) {
      setSeeded(true);
      ensure({}).catch(() => {
        // Allow retry on next mount if seeding fails
        setSeeded(false);
      });
    }
  }, [data, ensure, seeded, isAuthenticated]);

  return {
    data: data ? data.map(shape) : undefined,
    isLoading: data === undefined,
  };
}

export function useUpdateInboxSplits() {
  const fn = useMutation(api.inboxSplits.update);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    splits: { category: string; label: string; position: number; isEnabled: boolean }[],
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const result = await fn({ splits });
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
