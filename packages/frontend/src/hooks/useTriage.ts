import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

// ─── Types ───────────────────────────────────────────────────

interface TriageSettings {
  autoSortEnabled: boolean;
  confidenceThreshold: number;
}

interface TriageSuggestion {
  category: string;
  confidence: number;
  summary?: string | null;
  isTriageCategory: boolean;
  meetsThreshold: boolean;
  alreadyFiled: boolean;
}

interface TriageFeedbackPayload {
  emailId: string;
  threadId: string;
  suggestedCategory: string;
  finalCategory: string;
  wasConfirmed: boolean;
  // When the user opts in via the allow-sender dialog, the backend persists
  // a `senderTriageOverrides` row so future emails matching this pattern
  // skip the classifier and go straight to `finalCategory`. `allowKind`
  // distinguishes exact-email from whole-domain patterns.
  allowPattern?: string;
  allowKind?: 'email' | 'domain';
}

// ─── Settings ────────────────────────────────────────────────

export function useTriageSettings() {
  const data = useQuery(api.triage.getSettings, {});
  const shaped: TriageSettings | undefined = data
    ? {
        autoSortEnabled:
          (data as { autoSortEnabled?: boolean }).autoSortEnabled ?? false,
        confidenceThreshold:
          (data as { confidenceThreshold?: number }).confidenceThreshold ??
          0.85,
      }
    : undefined;
  return { data: shaped, isLoading: data === undefined };
}

export function useUpdateTriageSettings() {
  const fn = useMutation(api.triage.updateSettings);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (settings: Partial<TriageSettings>) => {
    setIsPending(true);
    try {
      return await fn(settings);
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

// ─── Suggestion (action — wrapped to act like a cached query) ──

const suggestionCache = new Map<
  string,
  { value: TriageSuggestion; timestamp: number }
>();
const SUGGESTION_TTL = 5 * 60 * 1000;

export function clearTriageSuggestionCache(threadId?: string) {
  if (threadId) suggestionCache.delete(threadId);
  else suggestionCache.clear();
}

export function useTriageSuggestion(threadId: string | null) {
  const fn = useAction(api.triage.getSuggestion);
  const [data, setData] = useState<TriageSuggestion | undefined>(undefined);
  const [isLoading, setIsLoading] = useState(false);
  const lastThreadId = useRef<string | null>(null);

  useEffect(() => {
    if (!threadId) {
      setData(undefined);
      setIsLoading(false);
      lastThreadId.current = null;
      return;
    }

    if (lastThreadId.current === threadId) return;
    lastThreadId.current = threadId;

    const cached = suggestionCache.get(threadId);
    if (cached && Date.now() - cached.timestamp < SUGGESTION_TTL) {
      setData(cached.value);
      setIsLoading(false);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    fn({ threadId: threadId as Id<'threads'> })
      .then((result) => {
        if (cancelled) return;
        const shaped = result as TriageSuggestion;
        suggestionCache.set(threadId, {
          value: shaped,
          timestamp: Date.now(),
        });
        setData(shaped);
      })
      .catch(() => {
        if (cancelled) return;
        setData(undefined);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [threadId, fn]);

  return { data, isLoading };
}

// ─── Feedback ────────────────────────────────────────────────

export function useTriageFeedback() {
  const fn = useMutation(api.triage.submitFeedback);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (payload: TriageFeedbackPayload) => {
    setIsPending(true);
    try {
      return await fn({
        emailId: payload.emailId
          ? (payload.emailId as Id<'emails'>)
          : undefined,
        threadId: payload.threadId
          ? (payload.threadId as Id<'threads'>)
          : undefined,
        suggestedCategory: payload.suggestedCategory,
        finalCategory: payload.finalCategory,
        wasConfirmed: payload.wasConfirmed,
        allowPattern: payload.allowPattern,
        allowKind: payload.allowKind,
      });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

// ─── Stats ───────────────────────────────────────────────────

export function useTriageStats() {
  const data = useQuery(api.triage.getStats, {});
  return {
    data: data as { feedbackCount: number } | undefined,
    isLoading: data === undefined,
  };
}

// ─── Feedback List ──────────────────────────────────────────

export interface TriageFeedbackRecord {
  id: string;
  senderAddress: string;
  subjectSnippet: string;
  suggestedCategory: string;
  finalCategory: string;
  wasConfirmed: boolean;
  createdAt: string;
}

export function useTriageFeedbackList(page: number = 1) {
  const result = useQuery(api.triage.listFeedback, { page, limit: 20 });
  const shaped = result
    ? {
        data: (result.data as Array<{
          _id: string;
          senderAddress: string;
          subjectSnippet: string;
          suggestedCategory: string;
          finalCategory: string;
          wasConfirmed: boolean;
          _creationTime: number;
        }>).map((r) => ({
          id: r._id,
          senderAddress: r.senderAddress,
          subjectSnippet: r.subjectSnippet,
          suggestedCategory: r.suggestedCategory,
          finalCategory: r.finalCategory,
          wasConfirmed: r.wasConfirmed,
          createdAt: new Date(r._creationTime).toISOString(),
        })),
        meta: result.meta,
      }
    : undefined;
  return {
    data: shaped,
    isLoading: result === undefined,
  };
}

export function useUpdateTriageFeedback() {
  const fn = useMutation(api.triage.updateFeedback);
  const [isPending, setIsPending] = useState(false);
  const mutate = async ({
    id,
    finalCategory,
  }: {
    id: string;
    finalCategory: string;
  }) => {
    setIsPending(true);
    try {
      return await fn({
        id: id as Id<'triageFeedback'>,
        finalCategory,
      });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useDeleteTriageFeedback() {
  const fn = useMutation(api.triage.deleteFeedback);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (id: string) => {
    setIsPending(true);
    try {
      return await fn({ id: id as Id<'triageFeedback'> });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useCreateManualTriageRule() {
  const fn = useMutation(api.triage.submitFeedback);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (payload: {
    senderAddress: string;
    finalCategory: string;
  }) => {
    setIsPending(true);
    try {
      return await fn({
        suggestedCategory: '',
        finalCategory: payload.finalCategory,
        wasConfirmed: true,
        senderAddress: payload.senderAddress,
      });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}
