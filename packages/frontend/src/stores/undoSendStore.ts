import { create } from 'zustand';

export interface PendingUndoEmail {
  id: string;
  threadId?: string;
  accountId?: string;
  body: string;
  bodyHtml?: string;
  to: string;
  subject: string;
  mode: 'reply' | 'forward' | 'compose';
  lastEmailId?: string;
  // Epoch milliseconds; the Convex backend hands us `Date.now() + UNDO_WINDOW_MS`.
  undoDeadlineAt: number;
}

interface UndoSendState {
  pendingEmails: PendingUndoEmail[];
  /** The email currently being viewed/edited from the pill */
  viewingEmailId: string | null;
  editingEmailId: string | null;

  addPendingEmail: (email: PendingUndoEmail) => void;
  removePendingEmail: (id: string) => void;
  setViewingEmail: (id: string | null) => void;
  setEditingEmail: (id: string | null) => void;
  clearAll: () => void;
}

export const useUndoSendStore = create<UndoSendState>((set) => ({
  pendingEmails: [],
  viewingEmailId: null,
  editingEmailId: null,

  addPendingEmail: (email) =>
    set((s) => ({ pendingEmails: [...s.pendingEmails, email] })),
  removePendingEmail: (id) =>
    set((s) => ({
      pendingEmails: s.pendingEmails.filter((e) => e.id !== id),
      viewingEmailId: s.viewingEmailId === id ? null : s.viewingEmailId,
      editingEmailId: s.editingEmailId === id ? null : s.editingEmailId,
    })),
  setViewingEmail: (id) => set({ viewingEmailId: id, editingEmailId: null }),
  setEditingEmail: (id) => set({ editingEmailId: id, viewingEmailId: null }),
  clearAll: () => set({ pendingEmails: [], viewingEmailId: null, editingEmailId: null }),
}));
