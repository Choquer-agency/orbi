import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

// ─────────────────────────────────────────────────────────────────────────────
// Drop-in TanStack Query → Convex replacement.
//
// Public surface preserved:
//   useHandoffs(status?)       — { data, isLoading } where `data` is the
//                                 Handoff[] array (unwrapped, matching the
//                                 prior `select: (res) => res.data` behavior).
//   useCreateHandoff()         — { mutate, mutateAsync, isPending }
//   useRespondToHandoff()      — accepts { id, action: 'accept' | 'decline' }
//   useReturnHandoff()         — accepts a handoff id (= "complete")
// ─────────────────────────────────────────────────────────────────────────────

interface Handoff {
  id: string;
  threadId: string;
  fromUserId: string;
  toUserId: string;
  note: string | null;
  transferSla: boolean;
  transferFollowUps: boolean;
  status: string;
  acceptedAt: string | null;
  createdAt: string;
  thread?: { id: string; subject: string; snippet: string; lastMessageAt: number };
  fromUser?: { id: string; name: string; avatarUrl: string | null };
}

type HandoffStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'COMPLETED';

export function useHandoffs(status?: string) {
  const result = useQuery(
    api.handoffs.listPending,
    status ? { status: status as HandoffStatus } : {},
  );
  return {
    data: (result?.data ?? undefined) as Handoff[] | undefined,
    isLoading: result === undefined,
    isError: false,
    error: undefined,
  };
}

export function useCreateHandoff() {
  const fn = useMutation(api.handoffs.create);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (args: {
    threadId: Id<'threads'> | string;
    toUserId: Id<'users'> | string;
    note?: string;
    transferSla?: boolean;
    transferFollowUps?: boolean;
  }) => {
    setIsPending(true);
    try {
      return await fn({
        threadId: args.threadId as Id<'threads'>,
        toUserId: args.toUserId as Id<'users'>,
        note: args.note,
        transferSla: args.transferSla,
        transferFollowUps: args.transferFollowUps,
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

export function useRespondToHandoff() {
  const acceptFn = useMutation(api.handoffs.accept);
  const declineFn = useMutation(api.handoffs.decline);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (args: {
    id: Id<'threadHandoffs'> | string;
    action: 'accept' | 'decline';
  }) => {
    setIsPending(true);
    try {
      const handoffId = args.id as Id<'threadHandoffs'>;
      if (args.action === 'accept') {
        return await acceptFn({ handoffId });
      }
      return await declineFn({ handoffId });
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

export function useReturnHandoff() {
  // Maps to Convex `complete` — recipient finishes / returns to original owner.
  const fn = useMutation(api.handoffs.complete);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (id: Id<'threadHandoffs'> | string) => {
    setIsPending(true);
    try {
      return await fn({ handoffId: id as Id<'threadHandoffs'> });
    } finally {
      setIsPending(false);
    }
  };

  return {
    mutate: (id: Id<'threadHandoffs'> | string) => {
      void mutateAsync(id);
    },
    mutateAsync,
    isPending,
    isLoading: isPending,
  };
}
