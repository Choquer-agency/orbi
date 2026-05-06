import { useEffect, useCallback } from 'react';
import { useAiChatStore } from '../stores/aiChatStore';
import { useAuthStore } from '../stores/authStore';
import type { AiChatMessage, ConversationSummary } from '../stores/aiChatStore';

export function useConversations() {
  const { conversations, setConversations, loadConversation } =
    useAiChatStore();

  const fetchConversations = useCallback(async () => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    try {
      const res = await fetch('/api/ai/conversations', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const json = await res.json();
      setConversations(json.data as ConversationSummary[]);
    } catch {
      // Silent fail
    }
  }, [setConversations]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const loadChat = useCallback(
    async (conversationId: string) => {
      const token = useAuthStore.getState().token;
      if (!token) return;

      try {
        const res = await fetch(`/api/ai/conversations/${conversationId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const json = await res.json();

        const messages: AiChatMessage[] = json.data.messages.map(
          (m: {
            id: string;
            role: string;
            content: string;
            createdAt: string;
            draft?: unknown;
            searchResults?: unknown;
            threadReferences?: unknown;
            priorityInbox?: unknown;
            tasks?: unknown;
            contactResults?: unknown;
          }) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            draft: m.draft || undefined,
            searchResults: m.searchResults || undefined,
            threadReferences: m.threadReferences || undefined,
            priorityInbox: m.priorityInbox || undefined,
            tasks: m.tasks || undefined,
            contactResults: m.contactResults || undefined,
            isStreaming: false,
            createdAt: m.createdAt,
          }),
        );

        loadConversation(messages, conversationId);
      } catch {
        // Silent fail
      }
    },
    [loadConversation],
  );

  return {
    conversations,
    refresh: fetchConversations,
    loadChat,
  };
}
