import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

interface FollowUpEvent {
  id: string;
  type: string;
  draftBody: string | null;
  draftTone: string | null;
  createdAt: string;
}

interface FollowUpWatch {
  id: string;
  threadId: string;
  emailId: string;
  contactEmail: string;
  intervals: number[];
  currentStep: number;
  nextCheckAt: string;
  status: string;
  thread?: { subject: string; snippet: string };
  events?: FollowUpEvent[];
}

function shapeEvent(e: {
  _id: string;
  type: string;
  draftBody?: string | null;
  draftTone?: string | null;
  _creationTime: number;
}): FollowUpEvent {
  return {
    id: e._id,
    type: e.type,
    draftBody: e.draftBody ?? null,
    draftTone: e.draftTone ?? null,
    createdAt: new Date(e._creationTime).toISOString(),
  };
}

function shapeWatch(w: {
  _id: string;
  threadId: string;
  emailId: string;
  contactEmail: string;
  intervals: number[];
  currentStep: number;
  nextCheckAt: number;
  status: string;
  thread?: { subject: string; snippet: string } | null;
  events?: Array<Parameters<typeof shapeEvent>[0]>;
}): FollowUpWatch {
  return {
    id: w._id,
    threadId: w.threadId,
    emailId: w.emailId,
    contactEmail: w.contactEmail,
    intervals: w.intervals,
    currentStep: w.currentStep,
    nextCheckAt: new Date(w.nextCheckAt).toISOString(),
    status: w.status,
    thread: w.thread ?? undefined,
    events: w.events ? w.events.map(shapeEvent) : undefined,
  };
}

// ─── Queries ──────────────────────────────────────────────────

export function useFollowUps(status?: string) {
  const data = useQuery(
    api.followUps.list,
    status ? { status } : {},
  );
  return {
    data: data ? data.map((w) => shapeWatch(w as never)) : undefined,
    isLoading: data === undefined,
  };
}

export function useFollowUp(id: string | undefined) {
  const data = useQuery(
    api.followUps.get,
    id ? { id: id as Id<'followUpWatches'> } : 'skip',
  );
  return {
    data: data ? shapeWatch(data as never) : undefined,
    isLoading: id ? data === undefined : false,
  };
}

// ─── Mutations ────────────────────────────────────────────────

export function useCreateFollowUp() {
  const fn = useMutation(api.followUps.create);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (data: {
    threadId: string;
    emailId: string;
    contactEmail: string;
    intervals?: number[];
  }) => {
    setIsPending(true);
    try {
      const result = await fn({
        threadId: data.threadId as Id<'threads'>,
        emailId: data.emailId,
        contactEmail: data.contactEmail,
        intervals: data.intervals,
      });
      return { data: result ? shapeWatch(result as never) : null };
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useCancelFollowUp() {
  const fn = useMutation(api.followUps.cancel);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (id: string) => {
    setIsPending(true);
    try {
      return await fn({ id: id as Id<'followUpWatches'> });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useSendFollowUp() {
  const fn = useMutation(api.followUps.sendDrafted);
  const [isPending, setIsPending] = useState(false);
  const mutate = async ({
    watchId,
    eventId,
  }: {
    watchId: string;
    eventId: string;
  }) => {
    setIsPending(true);
    try {
      return await fn({
        id: watchId as Id<'followUpWatches'>,
        eventId: eventId as Id<'followUpEvents'>,
      });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}
