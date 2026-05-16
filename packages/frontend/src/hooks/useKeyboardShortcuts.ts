import { useEffect } from 'react';
import { useUiStore } from '../stores/uiStore';
import { useUpdateThread } from './useThreads';
import { getVisibleThreadNavigationRows } from '../lib/threadNavigationState';

export function useKeyboardShortcuts() {
  const {
    selectedThreadId,
    setSelectedThread,
    toggleNavDropdown,
    setNavDropdownOpen,
    setComposingNew,
    selectedThreadIds,
    clearSelection,
    toggleThreadSelection,
  } = useUiStore();
  const updateThread = useUpdateThread();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      const isEditable =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target.isContentEditable ||
        target.getAttribute('role') === 'combobox' ||
        target.getAttribute('role') === 'textbox' ||
        target.closest('[role="dialog"]') !== null;

      // Cmd+/: toggle nav dropdown
      if (e.key === '/' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleNavDropdown();
        return;
      }

      // Escape: close panels/dropdown, clear selection, close open thread
      if (e.key === 'Escape') {
        if (selectedThreadIds.size > 0) {
          clearSelection();
        } else if (selectedThreadId) {
          // Blur whatever currently has focus so the thread list doesn't end
          // up with a focus ring after the viewer closes.
          (document.activeElement as HTMLElement | null)?.blur?.();
          setSelectedThread(null);
        }
        setNavDropdownOpen(false);
        return;
      }

      // Skip single-key shortcuts when in an editable field or when modifier keys are held
      if (isEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const threads = getVisibleThreadNavigationRows();
      const currentIndex = threads.findIndex((t) => t.id === selectedThreadId);

      switch (e.key) {
        case 'j': {
          // Next thread
          const nextIndex = currentIndex < threads.length - 1 ? currentIndex + 1 : currentIndex;
          if (threads[nextIndex]) setSelectedThread(threads[nextIndex].id);
          break;
        }
        case 'k': {
          // Previous thread
          const prevIndex = currentIndex > 0 ? currentIndex - 1 : 0;
          if (threads[prevIndex]) setSelectedThread(threads[prevIndex].id);
          break;
        }
        case 'Enter': {
          // Open thread (already selected via j/k)
          break;
        }
        case 'e': {
          // Archive selected
          if (selectedThreadIds.size > 0) {
            if (selectedThreadIds.size > 1 && !window.confirm(`Archive ${selectedThreadIds.size} threads?`)) break;
            selectedThreadIds.forEach((id) => updateThread.mutate({ id, isArchived: true }));
            clearSelection();
          } else if (selectedThreadId) {
            updateThread.mutate({ id: selectedThreadId, isArchived: true });
          }
          break;
        }
        case 's': {
          // Star
          if (selectedThreadId) {
            const thread = threads.find((t) => t.id === selectedThreadId);
            if (thread) {
              updateThread.mutate({ id: selectedThreadId, isStarred: !thread.isStarred });
            }
          }
          break;
        }
        case 'c': {
          // Compose new email
          e.preventDefault();
          setComposingNew(true);
          break;
        }
        case 'r': {
          // Reply to selected thread
          if (selectedThreadId) {
            // Set reply mode via a custom event the EmailViewer listens for
            window.dispatchEvent(new CustomEvent('orbi:reply', { detail: { threadId: selectedThreadId } }));
          }
          break;
        }
        case 'Backspace':
        case 'Delete': {
          // Delete selected
          if (selectedThreadIds.size > 0) {
            if (selectedThreadIds.size > 1 && !window.confirm(`Delete ${selectedThreadIds.size} threads?`)) break;
            selectedThreadIds.forEach((id) => updateThread.mutate({ id, isTrashed: true }));
            clearSelection();
          } else if (selectedThreadId) {
            updateThread.mutate({ id: selectedThreadId, isTrashed: true });
          }
          break;
        }
        case 'x': {
          // Toggle selection on current thread
          if (selectedThreadId) {
            toggleThreadSelection(selectedThreadId);
          }
          break;
        }
        case '?': {
          useUiStore.getState().setShortcutsModalOpen(true);
          break;
        }
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [
    selectedThreadId,
    setSelectedThread,
    toggleNavDropdown,
    setNavDropdownOpen,
    updateThread,
    setComposingNew,
    selectedThreadIds,
    clearSelection,
    toggleThreadSelection,
  ]);
}
