import { useState } from 'react';
import { useQuery, useMutation, useConvexAuth } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

function shapePerson(p: any) {
  if (!p) return p;
  return {
    ...p,
    id: p._id ?? p.id,
    contacts: Array.isArray(p.contacts)
      ? p.contacts.map((c: any) => ({
          ...c,
          id: c._id ?? c.id,
        }))
      : p.contacts,
    createdAt: p._creationTime ?? p.createdAt,
  };
}

export function usePersons(params: { q?: string; page?: number; limit?: number } = {}) {
  const { isAuthenticated } = useConvexAuth();
  const result = useQuery(
    api.persons.list,
    isAuthenticated
      ? { q: params.q, page: params.page, limit: params.limit }
      : 'skip',
  );
  if (result === undefined) {
    return { data: undefined, isLoading: true };
  }
  return {
    data: {
      data: result.data.map(shapePerson),
      meta: result.meta,
    },
    isLoading: false,
  };
}

export function usePerson(id: string | null) {
  const { isAuthenticated } = useConvexAuth();
  const enabled = isAuthenticated && !!id;
  const result = useQuery(
    api.persons.get,
    enabled ? { id: id as Id<'persons'> } : 'skip',
  );
  if (!enabled) {
    return { data: undefined, isLoading: false };
  }
  if (result === undefined) {
    return { data: undefined, isLoading: true };
  }
  return { data: { data: shapePerson(result) }, isLoading: false };
}

export function usePersonThreads(id: string | null) {
  const { isAuthenticated } = useConvexAuth();
  const enabled = isAuthenticated && !!id;
  const result = useQuery(
    api.persons.threadsForPerson,
    enabled ? { id: id as Id<'persons'> } : 'skip',
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

export function useUpdatePerson() {
  const fn = useMutation(api.persons.update);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    args: { id: string; [key: string]: any },
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const { id, ...rest } = args;
      const result = await fn({ id: id as Id<'persons'>, ...rest });
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

export function useMergePersons() {
  const fn = useMutation(api.persons.merge);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    personIds: string[],
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const result = await fn({
        personIds: personIds as Id<'persons'>[],
      });
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

export function useUnlinkContact() {
  const fn = useMutation(api.persons.unlink);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (
    args: { personId: string; contactId: string },
    opts?: { onSuccess?: (data: any) => void; onError?: (err: unknown) => void },
  ) => {
    setIsPending(true);
    try {
      const result = await fn({
        id: args.personId as Id<'persons'>,
        contactId: args.contactId as Id<'contacts'>,
      });
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

export function usePersonAutocomplete(query: string) {
  const { isAuthenticated } = useConvexAuth();
  const enabled = isAuthenticated && query.trim().length >= 1;
  const result = useQuery(
    api.persons.autocomplete,
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

export function useBackfillPersons() {
  const fn = useMutation(api.persons.backfill);
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
