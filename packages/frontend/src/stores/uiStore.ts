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
  clientsView: boolean;
  ticketChatPrompt: { threadId: string; text: string } | null;
  setClientsView: (value: boolean) => void;
  setTicketChatPrompt: (value: { threadId: string; text: string } | null) => void;
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
  // Team Hub: when set, the mail columns show THIS member's mailbox (the
  // backend re-verifies visibility on every query — this is display state,
  // not authorization). teamViewUserName is display-only for the banner.
  teamViewUserId: string | null;
  teamViewUserName: string | null;

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
  // Rendered thread order, synced by ThreadList — lets removal actions
  // (delete/archive/snooze) advance selection to the next visible thread.
  visibleThreadIds: string[];
  setVisibleThreadIds: (ids: string[]) => void;
  advanceSelectionAfterRemoval: (removedId: string) => void;
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
  // Enter/exit a member's mailbox (Team Hub). Entering resets folder to
  // inbox and clears any selection so no stale own-mailbox state leaks in.
  enterTeamView: (userId: string, userName: string | null) => void;
  exitTeamView: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      threadListWidth: 20,
      clientsView: false,
      ticketChatPrompt: null,
      setClientsView: (value) => set({ clientsView: value, selectedThreadIds: new Set<string>() }),
      setTicketChatPrompt: (value) => set({ ticketChatPrompt: value, ...(value ? { aiChatOpen: true, selectedThreadId: value.threadId, mobileActiveView: 'chat' as const } : {}) }),
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
      teamViewUserId: null,
      teamViewUserName: null,

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
      visibleThreadIds: [],
      setVisibleThreadIds: (ids) => {
        // Bail BEFORE set(): the caller's array identity churns every
        // render, and any set() call (even a content no-op) notifies
        // subscribers → re-render → recompute → set()… = infinite loop.
        const prev = get().visibleThreadIds;
        if (prev.length === ids.length && prev.every((v, i) => v === ids[i])) {
          return;
        }
        set({ visibleThreadIds: ids });
      },
      advanceSelectionAfterRemoval: (removedId) =>
        set((s) => {
          if (s.selectedThreadId !== removedId) return {};
          const ids = s.visibleThreadIds;
          const idx = ids.indexOf(removedId);
          // Prefer the next thread down, then the previous, then nothing.
          const next =
            (idx >= 0 ? ids[idx + 1] : undefined) ??
            (idx > 0 ? ids[idx - 1] : undefined) ??
            null;
          return {
            selectedThreadId: next,
            lastClickedThreadId: next,
            ...(next ? {} : { mobileActiveView: 'list' as const }),
          };
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
      enterTeamView: (userId, userName) =>
        set({
          teamViewUserId: userId,
          teamViewUserName: userName,
          selectedFolder: 'inbox',
          selectedThreadId: null,
          selectedAccountId: null,
          selectedThreadIds: new Set<string>(),
          lastClickedThreadId: null,
          composingNew: false,
        }),
      exitTeamView: () =>
        set({
          teamViewUserId: null,
          teamViewUserName: null,
          selectedFolder: 'team',
          selectedThreadId: null,
          selectedAccountId: null,
          selectedThreadIds: new Set<string>(),
          lastClickedThreadId: null,
          composingNew: false,
        }),
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
