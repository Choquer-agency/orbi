import { Bold, Italic, Link2, List, Quote, Undo2 } from 'lucide-react';
import { cn } from '../../lib/utils';
import { haptic } from '../../lib/haptics';
import type { Editor } from '@tiptap/react';

interface MobileFormatToolbarProps {
  editor: Editor | null;
  visible: boolean;
}

export function MobileFormatToolbar({ editor, visible }: MobileFormatToolbarProps) {
  if (!editor || !visible) return null;

  const btn = (
    active: boolean,
    action: () => void,
    icon: React.ReactNode,
    label: string,
  ) => (
    <button
      onMouseDown={(e) => {
        e.preventDefault(); // Prevent editor blur
        haptic.selection();
        action();
      }}
      className={cn(
        'flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
        active ? 'bg-primary/15 text-primary' : 'text-text-secondary',
      )}
      aria-label={label}
    >
      {icon}
    </button>
  );

  return (
    <div
      className="fixed inset-x-0 z-50 flex items-center justify-center gap-1 border-t border-border bg-surface px-4"
      style={{
        bottom: 'var(--keyboard-height, 0px)',
        height: '44px',
      }}
    >
      {btn(editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), <Bold className="h-4 w-4" />, 'Bold')}
      {btn(editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), <Italic className="h-4 w-4" />, 'Italic')}
      {btn(editor.isActive('link'), () => {
        const url = window.prompt('URL:');
        if (url) (editor.chain().focus() as any).setLink({ href: url }).run();
        else (editor.chain().focus() as any).unsetLink().run();
      }, <Link2 className="h-4 w-4" />, 'Link')}
      {btn(editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), <List className="h-4 w-4" />, 'List')}
      {btn(editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), <Quote className="h-4 w-4" />, 'Quote')}
      <div className="mx-1 h-5 w-px bg-border" />
      {btn(false, () => editor.chain().focus().undo().run(), <Undo2 className="h-4 w-4" />, 'Undo')}
    </div>
  );
}
