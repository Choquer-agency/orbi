import { useState } from 'react';
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

export interface Snippet {
  id: string;
  name: string;
  bodyHtml: string;
  bodyText: string;
  category: string | null;
  variables: string[];
  createdAt: number;
}

function shape(s: any): Snippet {
  return {
    id: s._id ?? s.id,
    name: s.name,
    bodyHtml: s.bodyHtml,
    bodyText: s.bodyText,
    category: s.category ?? null,
    variables: s.variables ?? [],
    createdAt: s._creationTime ?? s.createdAt,
  };
}

export function useSnippets() {
  const { isAuthenticated } = useConvexAuth();
  const data = useQuery(api.snippets.list, isAuthenticated ? {} : 'skip');
  return {
    data: data ? data.map(shape) : undefined,
    isLoading: data === undefined,
  };
}

export function useCreateSnippet() {
  const fn = useMutation(api.snippets.create);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    args: {
      name: string;
      bodyHtml: string;
      bodyText: string;
      category?: string;
      variables?: string[];
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

export function useUpdateSnippet() {
  const fn = useMutation(api.snippets.update);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    args: {
      id: string;
      name?: string;
      bodyHtml?: string;
      bodyText?: string;
      category?: string;
      variables?: string[];
    },
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const { id, ...rest } = args;
      const result = await fn({ id: id as Id<'snippets'>, ...rest });
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

export function useDeleteSnippet() {
  const fn = useMutation(api.snippets.remove);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    id: string,
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const result = await fn({ id: id as Id<'snippets'> });
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
