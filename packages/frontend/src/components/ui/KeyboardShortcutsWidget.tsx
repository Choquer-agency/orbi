import { X } from 'lucide-react';
import { useUiStore } from '../../stores/uiStore';
import { cn } from '../../lib/utils';

const SHORTCUT_GROUPS = [
  {
    label: 'Navigation',
    shortcuts: [
      { keys: ['J'], desc: 'Next thread' },
      { keys: ['K'], desc: 'Previous thread' },
      { keys: ['\u2318', '/'], desc: 'Toggle nav menu' },
      { keys: ['Esc'], desc: 'Clear selection / close' },
    ],
  },
  {
    label: 'Thread Actions',
    shortcuts: [
      { keys: ['E'], desc: 'Archive' },
      { keys: ['S'], desc: 'Star / unstar' },
      { keys: ['\u232B'], desc: 'Delete' },
      { keys: ['X'], desc: 'Toggle select' },
      { keys: ['Shift', 'Click'], desc: 'Select range' },
    ],
  },
  {
    label: 'Compose',
    shortcuts: [
      { keys: ['C'], desc: 'Compose new email' },
      { keys: ['R'], desc: 'Reply' },
    ],
  },
  {
    label: 'General',
    shortcuts: [
      { keys: ['?'], desc: 'Show keyboard shortcuts' },
    ],
  },
];

export function KeyboardShortcutsWidget({ inline = false }: { inline?: boolean }) {
  const shortcutsModalOpen = useUiStore((s) => s.shortcutsModalOpen);
  const setShortcutsModalOpen = useUiStore((s) => s.setShortcutsModalOpen);

  return (
    <>
      {/* Trigger button + (when floating) build version label */}
      <div className={inline ? undefined : 'fixed bottom-4 right-4 z-40 flex items-center gap-2'}>
        {!inline && (
          <span className="select-none rounded-full bg-white/80 px-2 py-0.5 text-[10px] font-medium text-text-tertiary ring-1 ring-border/60 shadow-sm backdrop-blur">
            V.1
          </span>
        )}
        <button
          onClick={() => setShortcutsModalOpen(true)}
          className={cn(
            inline
              ? 'flex h-6 w-6 items-center justify-center rounded-full text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary'
              : 'flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-md ring-1 ring-border/60 transition-all hover:shadow-lg hover:ring-border',
          )}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={inline ? 15 : 18}
            height={inline ? 15 : 18}
            fill="currentColor"
            viewBox="0 0 256 256"
            className="text-text-secondary"
          >
            <path d="M180,144H160V112h20a36,36,0,1,0-36-36V96H112V76a36,36,0,1,0-36,36H96v32H76a36,36,0,1,0,36,36V160h32v20a36,36,0,1,0,36-36ZM160,76a20,20,0,1,1,20,20H160ZM56,76a20,20,0,0,1,40,0V96H76A20,20,0,0,1,56,76ZM96,180a20,20,0,1,1-20-20H96Zm16-68h32v32H112Zm68,88a20,20,0,0,1-20-20V160h20a20,20,0,0,1,0,40Z" />
          </svg>
        </button>
      </div>

      {/* Modal */}
      {shortcutsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShortcutsModalOpen(false)}>
          <div
            className="relative w-full max-w-md rounded-xl border border-border bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-[14px] font-semibold text-text-primary">Keyboard Shortcuts</h2>
              <button
                onClick={() => setShortcutsModalOpen(false)}
                className="rounded-lg p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-5">
              {SHORTCUT_GROUPS.map((group) => (
                <div key={group.label}>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
                    {group.label}
                  </h3>
                  <div className="space-y-1.5">
                    {group.shortcuts.map((s) => (
                      <div key={s.desc} className="flex items-center justify-between py-0.5">
                        <span className="text-[12px] text-text-secondary">{s.desc}</span>
                        <div className="flex items-center gap-1">
                          {s.keys.map((k) => (
                            <kbd
                              key={k}
                              className="inline-flex min-w-[22px] items-center justify-center rounded-md bg-surface px-1.5 py-0.5 font-mono text-[10px] font-medium text-text-primary ring-1 ring-border"
                            >
                              {k}
                            </kbd>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
