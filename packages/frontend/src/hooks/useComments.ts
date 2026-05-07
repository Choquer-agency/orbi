import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

// ─────────────────────────────────────────────────────────────────────────────
// Drop-in TanStack Query → Convex replacement.
//
// Public surface preserved:
//   useComments(threadId)  — { data, isLoading }
//   useAddComment()        — { mutate, mutateAsync, isPending }
//   useResolveComment()    — { mutate, mutateAsync, isPending }
//   useAddReaction()       — { mutate, mutateAsync, isPending }
// ─────────────────────────────────────────────────────────────────────────────

export function useComments(threadId: Id<'threads'> | string | null) {
  const result = useQuery(
    api.threadComments.list,
    threadId ? { threadId: threadId as Id<'threads'> } : 'skip',
  );
  return {
    data: result,
    isLoading: threadId !== null && result === undefined,
    isError: false,
    error: undefined,
  };
}

export function useAddComment() {
  const fn = useMutation(api.threadComments.add);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (args: {
    threadId: Id<'threads'> | string;
    bodyHtml: string;
    bodyText: string;
  }) => {
    setIsPending(true);
    try {
      return await fn({
        threadId: args.threadId as Id<'threads'>,
        bodyHtml: args.bodyHtml,
        bodyText: args.bodyText,
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

export function useResolveComment() {
  const fn = useMutation(api.threadComments.resolve);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (commentId: Id<'threadComments'> | string) => {
    setIsPending(true);
    try {
      return await fn({ commentId: commentId as Id<'threadComments'> });
    } finally {
      setIsPending(false);
    }
  };

  return {
    mutate: (commentId: Id<'threadComments'> | string) => {
      void mutateAsync(commentId);
    },
    mutateAsync,
    isPending,
    isLoading: isPending,
  };
}

export function useAddReaction() {
  const fn = useMutation(api.threadComments.addReaction);
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = async (args: {
    commentId: Id<'threadComments'> | string;
    emoji: string;
  }) => {
    setIsPending(true);
    try {
      return await fn({
        commentId: args.commentId as Id<'threadComments'>,
        emoji: args.emoji,
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
