import { create } from 'zustand';

// Undo stack for mailbox actions (delete / archive). Each entry is one user
// gesture — a bulk delete of 5 threads is ONE entry (calls arriving within
// the merge window with the same action are coalesced), so one ⌘Z restores
// all five. Only destructive folder moves are recorded; read/star toggles
// would pollute the stack (opening a thread marks it read automatically).

export interface UndoThreadPatch {
  id: string;
  patch: { isTrashed?: boolean; isArchived?: boolean };
}

interface UndoEntry {
  threads: UndoThreadPatch[];
  /** 'trash' | 'archive' — used for the merge window and the toast copy. */
  action: string;
  at: number;
}

interface UndoState {
  stack: UndoEntry[];
  push: (item: UndoThreadPatch, action: string) => void;
  pop: () => UndoEntry | null;
}

const MERGE_WINDOW_MS = 1000;
const MAX_ENTRIES = 20;
/** Entries older than this are stale — the mailbox has likely moved on. */
export const UNDO_TTL_MS = 10 * 60 * 1000;

export const useUndoStore = create<UndoState>((set, get) => ({
  stack: [],
  push: (item, action) =>
    set((s) => {
      const last = s.stack[s.stack.length - 1];
      // Coalesce a burst of identical actions (bulk select → delete) into
      // one gesture, unless this thread is already in it.
      if (
        last &&
        last.action === action &&
        Date.now() - last.at < MERGE_WINDOW_MS &&
        !last.threads.some((t) => t.id === item.id)
      ) {
        const merged = { ...last, threads: [...last.threads, item] };
        return { stack: [...s.stack.slice(0, -1), merged] };
      }
      return {
        stack: [
          ...s.stack.slice(-(MAX_ENTRIES - 1)),
          { threads: [item], action, at: Date.now() },
        ],
      };
    }),
  pop: () => {
    const s = get();
    const fresh = s.stack.filter((e) => Date.now() - e.at < UNDO_TTL_MS);
    const last = fresh[fresh.length - 1] ?? null;
    set({ stack: fresh.slice(0, -1) });
    return last;
  },
}));
