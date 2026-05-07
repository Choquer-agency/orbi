import { useState } from 'react';
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

export interface AiFilter {
  id: string;
  name: string;
  description: string;
  conditions: {
    mode: 'ai' | 'rule';
    aiPrompt?: string;
    categories?: string[];
    senderPatterns?: string[];
    subjectContains?: string[];
  };
  actions: { type: 'archive' | 'star' | 'label' | 'trash'; value?: string }[];
  isActive: boolean;
  matchCount: number;
  lastMatchedAt: number | null;
  createdAt: number;
}

function shape(f: any): AiFilter {
  return {
    id: f._id ?? f.id,
    name: f.name,
    description: f.description,
    conditions: f.conditions,
    actions: f.actions,
    isActive: f.isActive,
    matchCount: f.matchCount ?? 0,
    lastMatchedAt: f.lastMatchedAt ?? null,
    createdAt: f._creationTime ?? f.createdAt,
  };
}

export function useAiFilters() {
  const { isAuthenticated } = useConvexAuth();
  const data = useQuery(api.aiFilters.list, isAuthenticated ? {} : 'skip');
  return {
    data: data ? data.map(shape) : undefined,
    isLoading: data === undefined,
  };
}

export function useCreateAiFilter() {
  const fn = useMutation(api.aiFilters.create);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    args: {
      name: string;
      description: string;
      conditions: any;
      actions: any;
    },
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

export function useUpdateAiFilter() {
  const fn = useMutation(api.aiFilters.update);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    args: {
      id: string;
      name?: string;
      description?: string;
      conditions?: any;
      actions?: any;
      isActive?: boolean;
    },
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const { id, ...rest } = args;
      const result = await fn({ id: id as Id<'aiFilters'>, ...rest });
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

export function useDeleteAiFilter() {
  const fn = useMutation(api.aiFilters.remove);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    id: string,
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const result = await fn({ id: id as Id<'aiFilters'> });
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
