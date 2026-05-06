import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface DraftData {
  to?: string;
  subject?: string;
  body: string;
  threadId?: string;
  correctionsApplied?: number;
}

export interface SearchResultData {
  emailId: string;
  threadId: string;
  threadSubject: string;
  from: string;
  fromName: string;
  subject: string;
  date: string;
  snippet: string;
  category?: string;
  urgency?: string;
}

export interface PriorityItem {
  emailId: string;
  threadId: string;
  subject: string;
  from: string;
  fromName: string;
  date: string;
  snippet: string;
  category?: string;
  urgency?: string;
  classificationSummary?: string;
  hasOpenTasks: boolean;
  isFollowedUp: boolean;
  daysSinceReceived: number;
}

export interface TaskItem {
  description: string;
  taskType: string;
  status: string;
  deadline?: string;
  contactEmail?: string;
  contactName?: string;
  threadId: string;
  threadSubject: string;
  createdAt: string;
}

export interface ContactResult {
  email: string;
  name?: string;
  company?: string;
  title?: string;
  emailCount: number;
  lastEmailed?: string;
}

export interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  threadReferences?: { id: string; subject: string }[];
  searchResults?: SearchResultData[];
  priorityInbox?: PriorityItem[];
  tasks?: TaskItem[];
  contactResults?: ContactResult[];
  draft?: DraftData;
  isStreaming?: boolean;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface AiChatState {
  messages: AiChatMessage[];
  isLoading: boolean;
  conversationId: string | null;
  conversations: ConversationSummary[];

  addUserMessage: (content: string) => void;
  addAssistantMessage: (
    content: string,
    opts?: {
      threadReferences?: { id: string; subject: string }[];
      searchResults?: SearchResultData[];
      priorityInbox?: PriorityItem[];
      tasks?: TaskItem[];
      contactResults?: ContactResult[];
      draft?: DraftData;
    },
  ) => void;
  startStreamingMessage: () => string;
  appendToStreamingMessage: (id: string, text: string) => void;
  finalizeStreamingMessage: (
    id: string,
    opts?: {
      draft?: DraftData;
      replaceContent?: string;
      threadReferences?: { id: string; subject: string }[];
      searchResults?: SearchResultData[];
      priorityInbox?: PriorityItem[];
      tasks?: TaskItem[];
      contactResults?: ContactResult[];
    },
  ) => void;
  setLoading: (loading: boolean) => void;
  clearChat: () => void;
  setConversationId: (id: string | null) => void;
  setConversations: (conversations: ConversationSummary[]) => void;
  loadConversation: (messages: AiChatMessage[], conversationId: string) => void;
}

let messageCounter = 0;

// ── Smooth streaming buffer ──
const streamBuffers = new Map<
  string,
  { pending: string; rafId: number | null }
>();

function startDraining(id: string) {
  const buf = streamBuffers.get(id);
  if (!buf || buf.rafId !== null) return;

  const drain = () => {
    const b = streamBuffers.get(id);
    if (!b || b.pending.length === 0) {
      if (b) b.rafId = null;
      return;
    }

    // Drain ~3-12 chars per frame for natural feel; adapt to buffer backlog
    const chunkSize = Math.max(3, Math.min(12, Math.ceil(b.pending.length / 4)));
    const chunk = b.pending.slice(0, chunkSize);
    b.pending = b.pending.slice(chunkSize);

    useAiChatStore.setState((s) => ({
      messages: s.messages.map((m) =>
        m.id === id ? { ...m, content: m.content + chunk } : m,
      ),
    }));

    b.rafId = requestAnimationFrame(drain);
  };

  buf.rafId = requestAnimationFrame(drain);
}

function flushBuffer(id: string) {
  const buf = streamBuffers.get(id);
  if (!buf) return;
  if (buf.rafId !== null) cancelAnimationFrame(buf.rafId);
  if (buf.pending.length > 0) {
    const remaining = buf.pending;
    buf.pending = '';
    useAiChatStore.setState((s) => ({
      messages: s.messages.map((m) =>
        m.id === id ? { ...m, content: m.content + remaining } : m,
      ),
    }));
  }
  streamBuffers.delete(id);
}

export const useAiChatStore = create<AiChatState>()(
  persist(
    (set) => ({
      messages: [],
      isLoading: false,
      conversationId: null,
      conversations: [],

      addUserMessage: (content) =>
        set((s) => ({
          messages: [
            ...s.messages,
            {
              id: `msg-${Date.now()}-${++messageCounter}`,
              role: 'user',
              content,
              createdAt: new Date().toISOString(),
            },
          ],
        })),

      addAssistantMessage: (content, opts) =>
        set((s) => ({
          messages: [
            ...s.messages,
            {
              id: `msg-${Date.now()}-${++messageCounter}`,
              role: 'assistant',
              content,
              threadReferences: opts?.threadReferences,
              searchResults: opts?.searchResults,
              priorityInbox: opts?.priorityInbox,
              tasks: opts?.tasks,
              contactResults: opts?.contactResults,
              draft: opts?.draft,
              createdAt: new Date().toISOString(),
            },
          ],
        })),

      startStreamingMessage: () => {
        const id = `msg-${Date.now()}-${++messageCounter}`;
        streamBuffers.set(id, { pending: '', rafId: null });
        set((s) => ({
          messages: [
            ...s.messages,
            {
              id,
              role: 'assistant',
              content: '',
              isStreaming: true,
              createdAt: new Date().toISOString(),
            },
          ],
        }));
        return id;
      },

      appendToStreamingMessage: (id, text) => {
        const buf = streamBuffers.get(id);
        if (buf) {
          buf.pending += text;
          startDraining(id);
        } else {
          set((s) => ({
            messages: s.messages.map((m) =>
              m.id === id ? { ...m, content: m.content + text } : m,
            ),
          }));
        }
      },

      finalizeStreamingMessage: (id, opts) => {
        flushBuffer(id);
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === id
              ? {
                  ...m,
                  content: opts?.replaceContent ?? m.content,
                  draft: opts?.draft ?? m.draft,
                  threadReferences:
                    opts?.threadReferences ?? m.threadReferences,
                  searchResults: opts?.searchResults ?? m.searchResults,
                  priorityInbox: opts?.priorityInbox ?? m.priorityInbox,
                  tasks: opts?.tasks ?? m.tasks,
                  contactResults: opts?.contactResults ?? m.contactResults,
                  isStreaming: false,
                }
              : m,
          ),
        }));
      },

      setLoading: (loading) => set({ isLoading: loading }),

      clearChat: () => {
        for (const [id, buf] of streamBuffers) {
          if (buf.rafId !== null) cancelAnimationFrame(buf.rafId);
          streamBuffers.delete(id);
        }
        set({ messages: [], isLoading: false, conversationId: null });
      },

      setConversationId: (id) => set({ conversationId: id }),
      setConversations: (conversations) => set({ conversations }),
      loadConversation: (messages, conversationId) =>
        set({ messages, conversationId, isLoading: false }),
    }),
    {
      name: 'orbi-ai-chat',
      partialize: (state) => ({
        messages: state.messages,
        conversationId: state.conversationId,
      }),
    },
  ),
);
