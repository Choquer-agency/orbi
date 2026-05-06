import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type ThreadListFilter = 'all' | 'unread' | 'starred';
type InboxFilterMode = 'smart' | 'standard';
type MobileActiveView = 'list' | 'viewer' | 'chat' | 'settings';
type MobileTransitionDirection = 'forward' | 'back';

export interface ComposeContext {
  to: string;
  subject: string;
  body: string;
  mode: string;
  threadId?: string;
}

export interface PendingDraft {
  body: string;
  bodyHtml?: string;
  to?: string;
  subject?: string;
  threadId?: string;
  aiOriginal?: { body: string };
  draftId?: string;
}

interface UiState {
  threadListWidth: number;
  aiChatOpen: boolean;
  aiChatWidth: number;
  navDropdownOpen: boolean;
  selectedThreadId: string | null;
  selectedAccountId: string | null;
  selectedFolder: string;
  threadListFilter: ThreadListFilter;
  aiAssistOpen: boolean;
  pendingDraft: PendingDraft | null;
  highlightText: string | null;
  scrollToScheduled: boolean;
  editingScheduledId: string | null;
  composingNew: boolean;
  selectedThreadIds: Set<string>;
  lastClickedThreadId: string | null;
  settingsOpen: boolean;
  settingsSection: string;
  shortcutsModalOpen: boolean;
  selectedContactId: string | null;
  selectedContactName: string | null;
  contactSearchEmail: string | null;
  selectedPersonId: string | null;
  selectedPersonName: string | null;
  pendingReplyMode: 'reply' | 'forward' | null;
  composeContext: ComposeContext | null;
  inboxFilterMode: InboxFilterMode;
  mobileActiveView: MobileActiveView;
  mobileTransitionDirection: MobileTransitionDirection;
  defaultAccountId: string | null;

  setComposeContext: (ctx: ComposeContext | null) => void;
  setPendingReplyMode: (mode: 'reply' | 'forward' | null) => void;
  setThreadListWidth: (width: number) => void;
  toggleAiChat: () => void;
  setAiChatWidth: (width: number) => void;
  toggleNavDropdown: () => void;
  setNavDropdownOpen: (open: boolean) => void;
  setSelectedThread: (id: string | null) => void;
  setSelectedAccount: (id: string | null) => void;
  setSelectedFolder: (folder: string) => void;
  setThreadListFilter: (filter: ThreadListFilter) => void;
  toggleAiAssist: () => void;
  setPendingDraft: (draft: PendingDraft | null) => void;
  setHighlightText: (text: string | null) => void;
  setScrollToScheduled: (v: boolean) => void;
  setEditingScheduledId: (id: string | null) => void;
  setComposingNew: (v: boolean) => void;
  toggleThreadSelection: (id: string) => void;
  selectThreadRange: (id: string, allThreadIds: string[]) => void;
  clearSelection: () => void;
  setSettingsOpen: (open: boolean) => void;
  setSettingsSection: (section: string) => void;
  setShortcutsModalOpen: (open: boolean) => void;
  setSelectedContact: (id: string | null, name?: string | null) => void;
  setContactSearchEmail: (email: string | null) => void;
  setSelectedPerson: (id: string | null, name?: string | null) => void;
  setInboxFilterMode: (mode: InboxFilterMode) => void;
  setMobileActiveView: (view: MobileActiveView) => void;
  setMobileTransitionDirection: (dir: MobileTransitionDirection) => void;
  setDefaultAccountId: (id: string | null) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      threadListWidth: 20,
      aiChatOpen: true,
      aiChatWidth: 27,
      navDropdownOpen: false,
      selectedThreadId: null,
      selectedAccountId: null,
      selectedFolder: 'inbox',
      threadListFilter: 'all',
      aiAssistOpen: true,
      pendingDraft: null,
      highlightText: null,
      scrollToScheduled: false,
      editingScheduledId: null,
      composingNew: false,
      selectedThreadIds: new Set<string>(),
      lastClickedThreadId: null,
      settingsOpen: false,
      settingsSection: 'accounts',
      shortcutsModalOpen: false,
      selectedContactId: null,
      selectedContactName: null,
      contactSearchEmail: null,
      selectedPersonId: null,
      selectedPersonName: null,
      composeContext: null,
      pendingReplyMode: null,
      inboxFilterMode: 'smart',
      mobileActiveView: 'list',
      mobileTransitionDirection: 'forward',
      defaultAccountId: null,

      setComposeContext: (ctx) => set({ composeContext: ctx }),
      setThreadListWidth: (pct) =>
        set({ threadListWidth: Math.max(15, Math.min(30, pct)) }),
      toggleAiChat: () => set((s) => ({ aiChatOpen: !s.aiChatOpen })),
      setAiChatWidth: (pct) =>
        set({ aiChatWidth: Math.max(20, Math.min(35, pct)) }),
      toggleNavDropdown: () => set((s) => ({ navDropdownOpen: !s.navDropdownOpen })),
      setNavDropdownOpen: (open) => set({ navDropdownOpen: open }),
      setSelectedThread: (id) => set({ selectedThreadId: id, composingNew: false, lastClickedThreadId: id, mobileActiveView: id ? 'viewer' : 'list', mobileTransitionDirection: id ? 'forward' : 'back' }),
      setSelectedAccount: (id) => set({ selectedAccountId: id }),
      setSelectedFolder: (folder) => set({ selectedFolder: folder, selectedContactId: null, selectedContactName: null, contactSearchEmail: null, selectedPersonId: null, selectedPersonName: null, selectedThreadId: null }),
      setThreadListFilter: (filter) => set({ threadListFilter: filter }),
      toggleAiAssist: () => set((s) => ({ aiAssistOpen: !s.aiAssistOpen })),
      setPendingDraft: (draft) => set({ pendingDraft: draft }),
      setHighlightText: (text) => set({ highlightText: text }),
      setScrollToScheduled: (v) => set({ scrollToScheduled: v }),
      setEditingScheduledId: (id) => set({ editingScheduledId: id }),
      setComposingNew: (v) => set({ composingNew: v, selectedThreadId: null, ...(v ? {} : { composeContext: null }) }),
      toggleThreadSelection: (id) =>
        set((s) => {
          const next = new Set(s.selectedThreadIds);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return { selectedThreadIds: next, lastClickedThreadId: id };
        }),
      selectThreadRange: (id, allThreadIds) =>
        set((s) => {
          if (!s.lastClickedThreadId) {
            return { selectedThreadIds: new Set([id]), lastClickedThreadId: id };
          }
          const startIdx = allThreadIds.indexOf(s.lastClickedThreadId);
          const endIdx = allThreadIds.indexOf(id);
          if (startIdx === -1 || endIdx === -1) {
            return { selectedThreadIds: new Set([id]), lastClickedThreadId: id };
          }
          const low = Math.min(startIdx, endIdx);
          const high = Math.max(startIdx, endIdx);
          const next = new Set(s.selectedThreadIds);
          for (let i = low; i <= high; i++) {
            next.add(allThreadIds[i]);
          }
          return { selectedThreadIds: next, lastClickedThreadId: id };
        }),
      clearSelection: () => set({ selectedThreadIds: new Set(), lastClickedThreadId: null }),
      setSettingsOpen: (open) => set({ settingsOpen: open, ...(open ? {} : { settingsSection: 'profile' }) }),
      setSettingsSection: (section) => set({ settingsSection: section }),
      setShortcutsModalOpen: (open) => set({ shortcutsModalOpen: open }),
      setSelectedContact: (id, name) => set({ selectedContactId: id, selectedContactName: name ?? null, selectedThreadId: null }),
      setContactSearchEmail: (email) => set({ contactSearchEmail: email }),
      setSelectedPerson: (id, name) => set({ selectedPersonId: id, selectedPersonName: name ?? null, selectedThreadId: null, selectedContactId: null, selectedContactName: null }),
      setPendingReplyMode: (mode) => set({ pendingReplyMode: mode }),
      setInboxFilterMode: (mode) => set({ inboxFilterMode: mode }),
      setMobileActiveView: (view) => set((s) => ({ mobileActiveView: view, mobileTransitionDirection: view === 'list' ? 'back' : (s.mobileActiveView === 'list' ? 'forward' : s.mobileTransitionDirection) })),
      setMobileTransitionDirection: (dir) => set({ mobileTransitionDirection: dir }),
      setDefaultAccountId: (id) => set({ defaultAccountId: id }),
    }),
    {
      name: 'orbi-ui-v3',
      partialize: (state) => ({
        threadListWidth: state.threadListWidth,
        aiChatOpen: state.aiChatOpen,
        aiChatWidth: state.aiChatWidth,
        aiAssistOpen: state.aiAssistOpen,
        inboxFilterMode: state.inboxFilterMode,
        defaultAccountId: state.defaultAccountId,
      }),
    },
  ),
);
