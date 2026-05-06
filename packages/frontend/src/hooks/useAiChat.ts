import { useCallback } from 'react';
import { useAiChatStore } from '../stores/aiChatStore';
import { useUiStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import type {
  SearchResultData,
  PriorityItem,
  TaskItem,
  ContactResult,
  AiChatMessage,
} from '../stores/aiChatStore';

// ── Server sync helpers (fire-and-forget, non-blocking) ──

function getAuthHeaders(): Record<string, string> {
  const token = useAuthStore.getState().token;
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function ensureConversation(): Promise<string> {
  const store = useAiChatStore.getState();
  if (store.conversationId) return store.conversationId;

  try {
    const res = await fetch('/api/ai/conversations', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({}),
    });
    if (!res.ok) return '';
    const json = await res.json();
    const id = json.data.id as string;
    useAiChatStore.getState().setConversationId(id);
    return id;
  } catch {
    return '';
  }
}

function saveMessageToServer(
  conversationId: string,
  msg: { role: string; content: string; metadata?: Record<string, unknown> },
) {
  if (!conversationId) return;
  fetch(`/api/ai/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify(msg),
  }).catch(() => {
    // Silent fail — local state is the source of truth
  });
}

// ── Main hook ──

export function useAiChat() {
  const { messages, isLoading, addUserMessage, setLoading, clearChat } =
    useAiChatStore();

  const sendMessage = useCallback(
    async (content: string, scope: 'thread' | 'all' = 'thread') => {
      if (!content.trim() || isLoading) return;

      const { selectedThreadId, selectedAccountId, composeContext } = useUiStore.getState();
      const token = useAuthStore.getState().token;

      addUserMessage(content.trim());
      setLoading(true);

      // Ensure we have a conversation for persistence
      const conversationId = await ensureConversation();

      // Persist user message to server
      saveMessageToServer(conversationId, {
        role: 'user',
        content: content.trim(),
      });

      // Build conversation history (last 20, role + content only)
      const store = useAiChatStore.getState();
      const history = store.messages
        .slice(-20)
        .map((m) => ({ role: m.role, content: m.content }));

      const requestBody = JSON.stringify({
        message: content.trim(),
        messages: history.slice(0, -1),
        threadId: selectedThreadId || null,
        accountId: selectedAccountId || null,
        scope,
        ...(composeContext ? { composeContext } : {}),
      });

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      };

      let streamingMsgId: string | null = null;

      try {
        const response = await fetch('/api/ai/chat/stream', {
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
                appendToStreamingMessage(
                  streamingMsgId!,
                  event.data.text,
                );
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

        // Persist assistant message to server
        const finalMsg = useAiChatStore
          .getState()
          .messages.find((m) => m.id === streamingMsgId);
        if (finalMsg) {
          persistAssistantMessage(conversationId, finalMsg);
        }

        streamingMsgId = null;
      } catch {
        if (streamingMsgId) {
          try {
            const response = await fetch('/api/ai/chat', {
              method: 'POST',
              headers,
              body: requestBody,
            });

            if (!response.ok) throw new Error('Chat failed');
            const result = await response.json();

            const { finalizeStreamingMessage } =
              useAiChatStore.getState();
            finalizeStreamingMessage(streamingMsgId, {
              replaceContent: result.data.reply,
              draft: result.data.draft,
              searchResults: result.data.searchResults,
              priorityInbox: result.data.priorityInbox,
              tasks: result.data.tasks,
              contactResults: result.data.contactResults,
              threadReferences: result.data.threadReferences,
            });

            // Persist fallback response
            const fallbackMsg = useAiChatStore
              .getState()
              .messages.find((m) => m.id === streamingMsgId);
            if (fallbackMsg) {
              persistAssistantMessage(conversationId, fallbackMsg);
            }
          } catch {
            const { finalizeStreamingMessage } =
              useAiChatStore.getState();
            finalizeStreamingMessage(streamingMsgId, {
              replaceContent:
                "I'm not able to process that request right now. Please check that the backend is running and try again.",
            });
          }
        } else {
          try {
            const response = await fetch('/api/ai/chat', {
              method: 'POST',
              headers,
              body: requestBody,
            });

            if (!response.ok) throw new Error('Chat failed');
            const result = await response.json();

            const { addAssistantMessage } = useAiChatStore.getState();
            addAssistantMessage(result.data.reply, {
              threadReferences: result.data.threadReferences,
              searchResults: result.data.searchResults,
              priorityInbox: result.data.priorityInbox,
              tasks: result.data.tasks,
              contactResults: result.data.contactResults,
              draft: result.data.draft,
            });
          } catch {
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
    [isLoading, addUserMessage, setLoading],
  );

  return { messages, isLoading, sendMessage, clearChat };
}

// ── Persistence helper ──

function persistAssistantMessage(
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

  saveMessageToServer(conversationId, {
    role: 'assistant',
    content: msg.content,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  });
}
