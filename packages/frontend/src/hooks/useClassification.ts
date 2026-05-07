import { useState } from 'react';
import { useQuery, useMutation } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';

interface Classification {
  category: string;
  confidence: number;
  urgency: string;
  summary: string | null;
  manualOverride: boolean;
}

export function useClassification(emailId: string | undefined) {
  const data = useQuery(
    api.classifications.getClassification,
    emailId ? { emailId: emailId as Id<'emails'> } : 'skip',
  );
  const shaped: Classification | undefined = data
    ? {
        category: (data as { category: string }).category,
        confidence: (data as { confidence: number }).confidence,
        urgency: (data as { urgency?: string }).urgency ?? 'normal',
        summary: (data as { summary?: string | null }).summary ?? null,
        manualOverride:
          (data as { manualOverride?: boolean }).manualOverride ?? false,
      }
    : undefined;
  return {
    data: shaped,
    isLoading: emailId ? data === undefined : false,
  };
}

export function useOverrideClassification() {
  const fn = useMutation(api.classifications.overrideClassification);
  const [isPending, setIsPending] = useState(false);
  const mutate = async ({
    emailId,
    category,
  }: {
    emailId: string;
    category: string;
  }) => {
    setIsPending(true);
    try {
      return await fn({
        emailId: emailId as Id<'emails'>,
        category,
      });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useClassifyEmail() {
  const fn = useMutation(api.classifications.classifyEmail);
  const [isPending, setIsPending] = useState(false);
  const mutate = async (emailId: string) => {
    setIsPending(true);
    try {
      return await fn({ emailId: emailId as Id<'emails'> });
    } finally {
      setIsPending(false);
    }
  };
  return { mutate, mutateAsync: mutate, isPending };
}

export function useCategories() {
  const data = useQuery(api.classifications.listCategories, {});
  return {
    data: data as { id: string; label: string; color: string }[] | undefined,
    isLoading: data === undefined,
  };
}
