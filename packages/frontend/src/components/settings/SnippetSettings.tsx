import { useState } from 'react';
import { TextQuote, Plus, Trash2, Pencil, Check, X } from 'lucide-react';
import {
  useSnippets,
  useCreateSnippet,
  useUpdateSnippet,
  useDeleteSnippet,
} from '../../hooks/useSnippets';

const VARIABLE_OPTIONS = ['recipient_name', 'my_name', 'company', 'date', 'subject'];

function SnippetEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial?: { name: string; bodyText: string; category: string | null; variables: string[] };
  onSave: (data: { name: string; bodyHtml: string; bodyText: string; category?: string; variables: string[] }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [bodyText, setBodyText] = useState(initial?.bodyText ?? '');
  const [category, setCategory] = useState(initial?.category ?? '');

  const detectedVars = VARIABLE_OPTIONS.filter((v) => bodyText.includes(`{{${v}}}`));

  const insertVariable = (v: string) => {
    setBodyText((prev) => prev + `{{${v}}}`);
  };

  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Snippet name"
          className="flex-1 rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
        />
        <input
          type="text"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="Category (optional)"
          className="w-32 rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none"
        />
      </div>

      <textarea
        value={bodyText}
        onChange={(e) => setBodyText(e.target.value)}
        placeholder="Type your snippet content here. Use {{variable_name}} for dynamic placeholders."
        rows={4}
        className="w-full rounded-lg border border-border bg-white px-3 py-2 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none resize-none font-mono"
      />

      {/* Variable buttons */}
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-text-secondary">Insert variable:</p>
        <div className="flex flex-wrap gap-1.5">
          {VARIABLE_OPTIONS.map((v) => (
            <button
              key={v}
              onClick={() => insertVariable(v)}
              className="rounded border border-border bg-white px-2 py-0.5 text-[10px] font-mono text-text-secondary hover:border-primary/40 hover:text-primary"
            >
              {`{{${v}}}`}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-end gap-1.5">
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface">
          Cancel
        </button>
        <button
          onClick={() => {
            if (!name.trim() || !bodyText.trim()) return;
            const bodyHtml = `<p>${bodyText.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`;
            onSave({
              name: name.trim(),
              bodyHtml,
              bodyText: bodyText.trim(),
              category: category.trim() || undefined,
              variables: detectedVars,
            });
          }}
          disabled={!name.trim() || !bodyText.trim()}
          className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:bg-primary/90 disabled:opacity-50"
        >
          <Check className="h-3 w-3" />
          Save
        </button>
      </div>
    </div>
  );
}

export function SnippetSettings() {
  const { data: snippets } = useSnippets();
  const createSnippet = useCreateSnippet();
  const updateSnippet = useUpdateSnippet();
  const deleteSnippet = useDeleteSnippet();
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const editingSnippet = editingId ? snippets?.find((s) => s.id === editingId) : null;

  // Group by category
  const grouped = new Map<string, typeof snippets>();
  snippets?.filter((s) => s.id !== editingId).forEach((s) => {
    const cat = s.category || 'Uncategorized';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(s);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <TextQuote className="h-4 w-4 text-text-secondary" />
          <h3 className="text-[13px] font-semibold text-text-primary">Snippets</h3>
        </div>
        {!showEditor && !editingId && (
          <button
            onClick={() => setShowEditor(true)}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white hover:bg-primary/90"
          >
            <Plus className="h-3 w-3" />
            New Snippet
          </button>
        )}
      </div>

      <p className="text-[11px] text-text-tertiary leading-relaxed">
        Create reusable email templates with dynamic variables. Insert snippets while composing
        to save time on common responses.
      </p>

      {showEditor && (
        <SnippetEditor
          onSave={(data) => {
            createSnippet.mutate(data, { onSuccess: () => setShowEditor(false) });
          }}
          onCancel={() => setShowEditor(false)}
        />
      )}

      {editingSnippet && (
        <SnippetEditor
          initial={{
            name: editingSnippet.name,
            bodyText: editingSnippet.bodyText,
            category: editingSnippet.category,
            variables: editingSnippet.variables,
          }}
          onSave={(data) => {
            updateSnippet.mutate({ id: editingSnippet.id, ...data }, { onSuccess: () => setEditingId(null) });
          }}
          onCancel={() => setEditingId(null)}
        />
      )}

      {/* Grouped snippet list */}
      {grouped.size > 0 && (
        <div className="space-y-4">
          {Array.from(grouped.entries()).map(([category, items]) => (
            <div key={category}>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">{category}</p>
              <div className="space-y-1.5">
                {items!.map((snippet) => (
                  <div
                    key={snippet.id}
                    className="rounded-lg border border-border bg-surface/50 p-2.5"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[12px] font-semibold text-text-primary">{snippet.name}</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setEditingId(snippet.id)}
                          className="rounded p-1 text-text-tertiary hover:text-primary"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          onClick={() => deleteSnippet.mutate(snippet.id)}
                          className="rounded p-1 text-text-tertiary hover:text-red-500"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                    <p className="text-[11px] text-text-tertiary line-clamp-2 font-mono">{snippet.bodyText}</p>
                    {snippet.variables.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {snippet.variables.map((v) => (
                          <span key={v} className="rounded bg-blue-50 px-1.5 py-0.5 text-[9px] font-mono text-blue-600">
                            {`{{${v}}}`}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {snippets && snippets.length === 0 && !showEditor && (
        <p className="text-center text-[11px] text-text-tertiary py-2">
          No snippets yet. Create templates for common email responses.
        </p>
      )}
    </div>
  );
}
