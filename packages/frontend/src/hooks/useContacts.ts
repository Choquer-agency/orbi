import { useCallback, useState } from 'react';
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

function shapeContact(c: any) {
  if (!c) return c;
  return {
    ...c,
    id: c._id ?? c.id,
    createdAt: c._creationTime ?? c.createdAt,
  };
}

function looksLikeEmailLocalPart(value: string, email: string): boolean {
  const local = email.split('@')[0]?.toLowerCase().replace(/[._+\-0-9]/g, '') ?? '';
  const normalized = value.toLowerCase().replace(/[._+\-0-9\s]/g, '');
  return normalized.length > 0 && (normalized === local || local.includes(normalized) || normalized.includes(local));
}

function isMeaningfulHeaderName(fromName: string | undefined | null, fromAddress: string): fromName is string {
  const name = fromName?.trim();
  if (!name) return false;
  if (name.includes('@')) return false;
  if (looksLikeEmailLocalPart(name, fromAddress)) return false;
  return true;
}

/**
 * Returns a function that resolves an email address to a display name.
 * Prefer the current message's From display name when it is meaningful; cached
 * contact/person names can be stale or mis-merged for brand/newsletter senders
 * that reuse shared ESP infrastructure.
 */
export function useContactNameResolver() {
  const { isAuthenticated } = useConvexAuth();
  const nameMap = useQuery(api.contacts.nameMap, isAuthenticated ? {} : 'skip');

  const resolveName = useCallback(
    (fromAddress: string | undefined | null, fromName: string | undefined | null): string => {
      if (!fromAddress) return fromName || 'Unknown';
      if (isMeaningfulHeaderName(fromName, fromAddress)) return fromName.trim();
      const map = nameMap ?? {};
      const resolved = map[fromAddress.toLowerCase()];
      if (resolved) return resolved;
      return fromName || fromAddress;
    },
    [nameMap],
  );

  return resolveName;
}

export function useContacts(params: { q?: string; page?: number; limit?: number } = {}) {
  const { isAuthenticated } = useConvexAuth();
  const result = useQuery(
    api.contacts.list,
    isAuthenticated
      ? { q: params.q, page: params.page, limit: params.limit }
      : 'skip',
  );
  if (result === undefined) {
    return { data: undefined, isLoading: true };
  }
  // Preserve `{ data: { data: [...], meta } }` shape so consumers can do
  // `res.data.data` / `res.data.meta`.
  return {
    data: {
      data: result.data.map(shapeContact),
      meta: result.meta,
    },
    isLoading: false,
  };
}

export function useContact(id: string | null) {
  const { isAuthenticated } = useConvexAuth();
  const enabled = isAuthenticated && !!id;
  const result = useQuery(
    api.contacts.get,
    enabled ? { id: id as Id<'contacts'> } : 'skip',
  );
  if (!enabled) {
    return { data: undefined, isLoading: false };
  }
  if (result === undefined) {
    return { data: undefined, isLoading: true };
  }
  // Preserve `{ data: { data: contact } }` so consumers can do `res.data?.data`.
  return { data: { data: shapeContact(result) }, isLoading: false };
}

export function useContactThreads(id: string | null) {
  const { isAuthenticated } = useConvexAuth();
  const enabled = isAuthenticated && !!id;
  const result = useQuery(
    api.contacts.threadsForContact,
    enabled ? { id: id as Id<'contacts'> } : 'skip',
  );
  if (!enabled) {
    return { data: undefined, isLoading: false };
  }
  if (result === undefined) {
    return { data: undefined, isLoading: true };
  }
  const threads = result.map((t: any) => ({
    ...t,
    id: t._id ?? t.id,
  }));
  return { data: { data: threads }, isLoading: false };
}

export function useUpdateContact() {
  const fn = useMutation(api.contacts.update);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    args: { id: string; [key: string]: any },
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const { id, ...rest } = args;
      const result = await fn({ id: id as Id<'contacts'>, ...rest });
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

export function useContactAutocomplete(query: string) {
  const { isAuthenticated } = useConvexAuth();
  const enabled = isAuthenticated && query.trim().length >= 1;
  const result = useQuery(
    api.contacts.autocomplete,
    enabled ? { q: query } : 'skip',
  );
  if (!enabled) {
    return { data: undefined, isLoading: false };
  }
  if (result === undefined) {
    return { data: undefined, isLoading: true };
  }
  return { data: { data: result }, isLoading: false };
}

export function useResetAutoContacts() {
  const fn = useMutation(api.contacts.resetAuto);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    _?: void,
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const result = await fn({});
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
