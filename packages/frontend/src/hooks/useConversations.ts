import { useEffect, useCallback } from 'react';
import { useConvex } from 'convex/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { useAiChatStore } from '../stores/aiChatStore';
import type {
  AiChatMessage,
  ConversationSummary,
  SearchResultData,
  PriorityItem,
  TaskItem,
  ContactResult,
  DraftData,
} from '../stores/aiChatStore';

export function useConversations() {
  const convex = useConvex();
  const { conversations, setConversations, loadConversation } =
    useAiChatStore();

  const fetchConversations = useCallback(async () => {
    try {
      const result = (await convex.query(
        api.ai.chatHistory.listConversations,
        {},
      )) as Array<{
        id: Id<'chatConversations'>;
        title: string;
        createdAt: number;
        updatedAt: number;
      }>;
      const summaries: ConversationSummary[] = result.map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: new Date(c.createdAt).toISOString(),
        updatedAt: new Date(c.updatedAt).toISOString(),
      }));
      setConversations(summaries);
    } catch {
      // Silent fail — anonymous / unauth users
    }
  }, [convex, setConversations]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  const loadChat = useCallback(
    async (conversationId: string) => {
      try {
        const result = (await convex.query(api.ai.chatHistory.getConversation, {
          id: conversationId as Id<'chatConversations'>,
        })) as {
          id: Id<'chatConversations'>;
          title: string;
          messages: Array<{
            id: string;
            role: string;
            content: string;
            createdAt: number;
            draft?: DraftData;
            searchResults?: SearchResultData[];
            threadReferences?: { id: string; subject: string }[];
            priorityInbox?: PriorityItem[];
            tasks?: TaskItem[];
            contactResults?: ContactResult[];
          }>;
          createdAt: number;
          updatedAt: number;
        };

        const messages: AiChatMessage[] = result.messages.map((m) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          draft: m.draft,
          searchResults: m.searchResults,
          threadReferences: m.threadReferences,
          priorityInbox: m.priorityInbox,
          tasks: m.tasks,
          contactResults: m.contactResults,
          isStreaming: false,
          createdAt: new Date(m.createdAt).toISOString(),
        }));

        loadConversation(messages, conversationId);
      } catch {
        // Silent fail
      }
    },
    [convex, loadConversation],
  );

  return {
    conversations,
    refresh: fetchConversations,
    loadChat,
  };
}
