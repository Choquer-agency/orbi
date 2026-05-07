import { useCallback } from 'react';
import { useConvex } from 'convex/react';
import { useAuthToken } from '@convex-dev/auth/react';
import { api } from '../../../../convex/_generated/api';
import type { Id } from '../../../../convex/_generated/dataModel';
import { useAiChatStore } from '../stores/aiChatStore';
import { useUiStore } from '../stores/uiStore';
import type {
  SearchResultData,
  PriorityItem,
  TaskItem,
  ContactResult,
  AiChatMessage,
} from '../stores/aiChatStore';

// Convex HTTP actions live on `.site`, not `.cloud`. The streaming AI chat
// endpoint is registered in convex/ai/http.ts at POST /ai/chat/stream.
const STREAM_URL = `${import.meta.env.VITE_CONVEX_SITE_URL}/ai/chat/stream`;

// ── Main hook ──

export function useAiChat() {
  const convex = useConvex();
  const token = useAuthToken();
  const { messages, isLoading, addUserMessage, setLoading, clearChat } =
    useAiChatStore();

  const sendMessage = useCallback(
    async (content: string, scope: 'thread' | 'all' = 'thread') => {
      if (!content.trim() || isLoading) return;

      const { selectedThreadId, selectedAccountId, composeContext } =
        useUiStore.getState();

      addUserMessage(content.trim());
      setLoading(true);

      // Ensure we have a conversation for persistence (server-side dedup
      // creates one if missing).
      let conversationId = useAiChatStore.getState().conversationId;
      if (!conversationId) {
        try {
          const result = (await convex.mutation(
            api.ai.chatHistory.createConversation,
            {},
          )) as { id: Id<'chatConversations'> };
          conversationId = result.id;
          useAiChatStore.getState().setConversationId(conversationId);
        } catch {
          // Streaming will still work without a conversationId; persistence
          // simply won't happen.
        }
      }

      // Persist user message to server (fire-and-forget).
      if (conversationId) {
        convex
          .mutation(api.ai.chatHistory.saveMessage, {
            conversationId: conversationId as Id<'chatConversations'>,
            role: 'user',
            content: content.trim(),
          })
          .catch(() => {
            /* silent fail — local state is the source of truth */
          });
      }

      // Build conversation history (last 20, role + content only, drop the
      // freshly-added user message — it goes into the `message` field).
      const store = useAiChatStore.getState();
      const history = store.messages
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));

      const requestBody = JSON.stringify({
        message: content.trim(),
        messages: history.slice(0, -1),
        threadId: selectedThreadId || undefined,
        accountId: selectedAccountId || undefined,
        scope,
        conversationId: conversationId || undefined,
        ...(composeContext ? { composeContext } : {}),
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      let streamingMsgId: string | null = null;

      try {
        const response = await fetch(STREAM_URL, {
          method: 'POST',
          headers,
          body: requestBody,
        });

        if (!response.ok || !response.body) {
          throw new Error('Stream unavailable');
        }

        const {
          startStreamingMessage,
          appendToStreamingMessage,
          finalizeStreamingMessage,
        } = useAiChatStore.getState();

        streamingMsgId = startStreamingMessage();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let draft:
          | {
              to?: string;
              subject?: string;
              body: string;
              threadId?: string;
            }
          | undefined;
        let toolText = '';
        let threadReferences:
          | { id: string; subject: string }[]
          | undefined;
        let searchResults: SearchResultData[] | undefined;
        let priorityInbox: PriorityItem[] | undefined;
        let tasks: TaskItem[] | undefined;
        let contactResults: ContactResult[] | undefined;
        let hasError = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === 'text_delta') {
                appendToStreamingMessage(streamingMsgId!, event.data.text);
              } else if (event.type === 'tool_result') {
                if (event.data.tool === 'generate_draft') {
                  draft = event.data.draft;
                } else if (event.data.text) {
                  toolText = event.data.text;
                }
              } else if (event.type === 'thread_references') {
                threadReferences = event.data.references;
              } else if (event.type === 'search_results') {
                searchResults = event.data.results;
              } else if (event.type === 'priority_inbox') {
                priorityInbox = event.data.emails;
              } else if (event.type === 'tasks') {
                tasks = event.data.tasks;
              } else if (event.type === 'contact_results') {
                contactResults = event.data.contacts;
              } else if (event.type === 'tool_progress') {
                // Progress handled by AI's own text — no duplicate needed
              } else if (event.type === 'error') {
                hasError = true;
              }
            } catch {
              // skip malformed events
            }
          }
        }

        if (hasError) {
          throw new Error('Stream reported error');
        }

        const currentMsg = useAiChatStore
          .getState()
          .messages.find((m) => m.id === streamingMsgId);
        const streamedContent = currentMsg?.content || '';
        const hasStreamedText = streamedContent.trim().length > 0;

        if (toolText && !hasStreamedText) {
          finalizeStreamingMessage(streamingMsgId!, {
            draft,
            replaceContent: toolText,
            threadReferences,
            searchResults,
            priorityInbox,
            tasks,
            contactResults,
          });
        } else if (!hasStreamedText && draft) {
          finalizeStreamingMessage(streamingMsgId!, {
            draft,
            replaceContent: "Here's a draft for you:",
            threadReferences,
            searchResults,
            priorityInbox,
            tasks,
            contactResults,
          });
        } else {
          finalizeStreamingMessage(streamingMsgId!, {
            draft,
            threadReferences,
            searchResults,
            priorityInbox,
            tasks,
            contactResults,
          });
        }

        // Persist assistant message to server (the server stream also persists
        // the plain text content, but we send a follow-up with metadata).
        const finalMsg = useAiChatStore
          .getState()
          .messages.find((m) => m.id === streamingMsgId);
        if (finalMsg && conversationId) {
          persistAssistantMessage(convex, conversationId, finalMsg);
        }

        streamingMsgId = null;
      } catch {
        // Fall back to non-streaming chat action.
        try {
          const result = (await convex.action(api.ai.chat.chat, {
            message: content.trim(),
            messages: history.slice(0, -1) as Array<{
              role: 'user' | 'assistant';
              content: string;
            }>,
            threadId: selectedThreadId
              ? (selectedThreadId as Id<'threads'>)
              : undefined,
            accountId: selectedAccountId
              ? (selectedAccountId as Id<'mailAccounts'>)
              : undefined,
            scope,
            composeContext: composeContext ?? undefined,
          })) as {
            reply: string;
            draft?: AiChatMessage['draft'];
            searchResults?: SearchResultData[];
            priorityInbox?: PriorityItem[];
            tasks?: TaskItem[];
            contactResults?: ContactResult[];
            threadReferences?: { id: string; subject: string }[];
          };

          if (streamingMsgId) {
            const { finalizeStreamingMessage } = useAiChatStore.getState();
            finalizeStreamingMessage(streamingMsgId, {
              replaceContent: result.reply,
              draft: result.draft,
              searchResults: result.searchResults,
              priorityInbox: result.priorityInbox,
              tasks: result.tasks,
              contactResults: result.contactResults,
              threadReferences: result.threadReferences,
            });
            const fallbackMsg = useAiChatStore
              .getState()
              .messages.find((m) => m.id === streamingMsgId);
            if (fallbackMsg && conversationId) {
              persistAssistantMessage(convex, conversationId, fallbackMsg);
            }
          } else {
            const { addAssistantMessage } = useAiChatStore.getState();
            addAssistantMessage(result.reply, {
              threadReferences: result.threadReferences,
              searchResults: result.searchResults,
              priorityInbox: result.priorityInbox,
              tasks: result.tasks,
              contactResults: result.contactResults,
              draft: result.draft,
            });
          }
        } catch {
          if (streamingMsgId) {
            const { finalizeStreamingMessage } = useAiChatStore.getState();
            finalizeStreamingMessage(streamingMsgId, {
              replaceContent:
                "I'm not able to process that request right now. Please check that the backend is running and try again.",
            });
          } else {
            const { addAssistantMessage } = useAiChatStore.getState();
            addAssistantMessage(
              "I'm not able to process that request right now. Please check that the backend is running and try again.",
            );
          }
        }
      } finally {
        setLoading(false);
      }
    },
    [convex, token, isLoading, addUserMessage, setLoading],
  );

  return { messages, isLoading, sendMessage, clearChat };
}

// ── Persistence helper ──

type ConvexClient = ReturnType<typeof useConvex>;

function persistAssistantMessage(
  convex: ConvexClient,
  conversationId: string,
  msg: AiChatMessage,
) {
  const metadata: Record<string, unknown> = {};
  if (msg.draft) metadata.draft = msg.draft;
  if (msg.searchResults) metadata.searchResults = msg.searchResults;
  if (msg.threadReferences) metadata.threadReferences = msg.threadReferences;
  if (msg.priorityInbox) metadata.priorityInbox = msg.priorityInbox;
  if (msg.tasks) metadata.tasks = msg.tasks;
  if (msg.contactResults) metadata.contactResults = msg.contactResults;

  convex
    .mutation(api.ai.chatHistory.saveMessage, {
      conversationId: conversationId as Id<'chatConversations'>,
      role: 'assistant',
      content: msg.content,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    })
    .catch(() => {
      /* silent fail */
    });
}
