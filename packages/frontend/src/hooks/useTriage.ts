import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

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
}

// ─── Settings ────────────────────────────────────────────────

export function useTriageSettings() {
  return useQuery({
    queryKey: ['triage', 'settings'],
    queryFn: () => api.get<{ data: TriageSettings }>('/triage/settings'),
    select: (res) => res.data,
  });
}

export function useUpdateTriageSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: Partial<TriageSettings>) =>
      api.put('/triage/settings', settings),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['triage', 'settings'] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });
}

// ─── Suggestion ──────────────────────────────────────────────

export function useTriageSuggestion(threadId: string | null) {
  return useQuery({
    queryKey: ['triage', 'suggestion', threadId],
    queryFn: () => api.get<{ data: TriageSuggestion }>(`/triage/suggestion/${threadId}`),
    select: (res) => res.data,
    enabled: !!threadId,
    staleTime: 5 * 60 * 1000, // cache for 5 min
  });
}

// ─── Feedback ────────────────────────────────────────────────

export function useTriageFeedback() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: TriageFeedbackPayload) =>
      api.post('/triage/feedback', payload),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['triage', 'suggestion', vars.threadId] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      queryClient.invalidateQueries({ queryKey: ['triage', 'stats'] });
    },
  });
}

// ─── Stats ───────────────────────────────────────────────────

export function useTriageStats() {
  return useQuery({
    queryKey: ['triage', 'stats'],
    queryFn: () => api.get<{ data: { feedbackCount: number } }>('/triage/stats'),
    select: (res) => res.data,
  });
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
  return useQuery({
    queryKey: ['triage', 'feedback', page],
    queryFn: () =>
      api.get<{
        data: TriageFeedbackRecord[];
        meta: { total: number; page: number; limit: number; totalPages: number };
      }>(`/triage/feedback?page=${page}&limit=20`),
  });
}

export function useUpdateTriageFeedback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, finalCategory }: { id: string; finalCategory: string }) =>
      api.patch(`/triage/feedback/${id}`, { finalCategory }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['triage', 'feedback'] });
      queryClient.invalidateQueries({ queryKey: ['triage', 'stats'] });
    },
  });
}

export function useDeleteTriageFeedback() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/triage/feedback/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['triage', 'feedback'] });
      queryClient.invalidateQueries({ queryKey: ['triage', 'stats'] });
    },
  });
}

export function useCreateManualTriageRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { senderAddress: string; finalCategory: string }) =>
      api.post('/triage/feedback', {
        suggestedCategory: '',
        finalCategory: payload.finalCategory,
        wasConfirmed: true,
        senderAddress: payload.senderAddress,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['triage', 'feedback'] });
      queryClient.invalidateQueries({ queryKey: ['triage', 'stats'] });
    },
  });
}
