import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  sidebarWidth: number;
  threadListWidth: number;
  selectedThreadId: string | null;
  selectedAccountId: string | null;
  selectedFolder: string;
  aiAssistOpen: boolean;

  setSidebarWidth: (width: number) => void;
  setThreadListWidth: (width: number) => void;
  setSelectedThread: (id: string | null) => void;
  setSelectedAccount: (id: string | null) => void;
  setSelectedFolder: (folder: string) => void;
  toggleAiAssist: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarWidth: 240,
      threadListWidth: 360,
      selectedThreadId: null,
      selectedAccountId: null,
      selectedFolder: 'inbox',
      aiAssistOpen: true,

      setSidebarWidth: (width) => set({ sidebarWidth: Math.max(200, Math.min(320, width)) }),
      setThreadListWidth: (width) =>
        set({ threadListWidth: Math.max(280, Math.min(500, width)) }),
      setSelectedThread: (id) => set({ selectedThreadId: id }),
      setSelectedAccount: (id) => set({ selectedAccountId: id }),
      setSelectedFolder: (folder) => set({ selectedFolder: folder }),
      toggleAiAssist: () => set((state) => ({ aiAssistOpen: !state.aiAssistOpen })),
    }),
    {
      name: 'orbi-ui',
      partialize: (state) => ({
        sidebarWidth: state.sidebarWidth,
        threadListWidth: state.threadListWidth,
        aiAssistOpen: state.aiAssistOpen,
      }),
    },
  ),
);
