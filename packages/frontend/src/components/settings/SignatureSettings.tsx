import { useState } from 'react';
import { FileSignature, Plus, Trash2, Star, Pencil, Check, Code, Eye } from 'lucide-react';
import {
  useSignatures,
  useCreateSignature,
  useUpdateSignature,
  useDeleteSignature,
  type Signature,
} from '../../hooks/useSignatures';
import { useAccounts } from '../../hooks/useAccounts';
import { cn } from '../../lib/utils';

interface AccountOption {
  id: string;
  email: string;
  displayName: string | null;
}

function SignatureEditor({
  initial,
  accounts,
  onSave,
  onCancel,
}: {
  initial?: { name: string; bodyHtml: string; isDefault: boolean; accountId: string | null };
  accounts: AccountOption[];
  onSave: (data: { name: string; bodyHtml: string; isDefault: boolean; accountId: string | null }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [bodyHtml, setBodyHtml] = useState(initial?.bodyHtml ?? '');
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const [accountId, setAccountId] = useState<string | null>(initial?.accountId ?? null);
  // "source" = raw HTML textarea (preserves complex markup like Spark/Outlook
  // table-based signatures exactly), "preview" = WYSIWYG contentEditable.
  // Default to source when the existing signature already contains markup
  // that contentEditable would mangle (tables, complex inline styles).
  const looksComplex = /<(table|tbody|tr|td|th|style)\b/i.test(initial?.bodyHtml ?? '');
  const [mode, setMode] = useState<'preview' | 'source'>(looksComplex ? 'source' : 'preview');

  return (
    <div className="space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Signature name (e.g., Work, Personal)"
        className="w-full rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
      />
      <div className="flex items-center justify-end gap-1 -mb-1">
        <button
          type="button"
          onClick={() => setMode('preview')}
          className={cn(
            'flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors',
            mode === 'preview'
              ? 'bg-white text-text-primary shadow-sm'
              : 'text-text-tertiary hover:text-text-secondary',
          )}
        >
          <Eye className="h-3 w-3" /> Preview
        </button>
        <button
          type="button"
          onClick={() => setMode('source')}
          className={cn(
            'flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium transition-colors',
            mode === 'source'
              ? 'bg-white text-text-primary shadow-sm'
              : 'text-text-tertiary hover:text-text-secondary',
          )}
        >
          <Code className="h-3 w-3" /> HTML
        </button>
      </div>
      {mode === 'preview' ? (
        <div
          contentEditable
          suppressContentEditableWarning
          dangerouslySetInnerHTML={{ __html: bodyHtml }}
          onBlur={(e) => setBodyHtml(e.currentTarget.innerHTML)}
          className="min-h-[80px] w-full rounded-lg border border-border bg-white px-3 py-2 text-[12px] text-text-primary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40 [&_a]:text-primary [&_a]:underline"
          data-placeholder="Type your signature HTML here..."
        />
      ) : (
        <textarea
          value={bodyHtml}
          onChange={(e) => setBodyHtml(e.target.value)}
          placeholder="Paste raw HTML (<table>, <img>, inline styles preserved exactly)"
          spellCheck={false}
          className="min-h-[200px] w-full rounded-lg border border-border bg-white px-3 py-2 font-mono text-[11px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
        />
      )}
      <p className="text-[10px] text-text-tertiary">
        {mode === 'preview'
          ? 'Type your signature — formatting buttons coming. For pasted HTML (Spark, Outlook, etc.) use the HTML tab.'
          : 'Raw HTML is saved exactly as written. Tables, inline styles, and images are preserved.'}
      </p>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-[11px] text-text-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-border accent-primary"
          />
          Set as default
        </label>
        {accounts.length > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-text-tertiary">for</span>
            <select
              value={accountId ?? ''}
              onChange={(e) => setAccountId(e.target.value || null)}
              className="rounded border border-border bg-white px-2 py-1 text-[11px] text-text-primary focus:border-primary focus:outline-none"
            >
              <option value="">All accounts</option>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.displayName || acc.email}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-1.5">
        <button
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface"
        >
          Cancel
        </button>
        <button
          onClick={() => name.trim() && onSave({ name: name.trim(), bodyHtml, isDefault, accountId })}
          disabled={!name.trim()}
          className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          <Check className="h-3 w-3" />
          Save
        </button>
      </div>
    </div>
  );
}

export function SignatureSettings() {
  const { data: signatures } = useSignatures();
  const createSignature = useCreateSignature();
  const updateSignature = useUpdateSignature();
  const deleteSignature = useDeleteSignature();
  const { data: accountsRes } = useAccounts();
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const accounts: AccountOption[] = (accountsRes?.data ?? []).map((a: any) => ({
    id: a.id,
    email: a.email,
    displayName: a.displayName,
  }));

  const editingSig = editingId ? signatures?.find((s) => s.id === editingId) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileSignature className="h-4 w-4 text-text-secondary" />
          <h3 className="text-[13px] font-semibold text-text-primary">Signatures</h3>
        </div>
        {!showEditor && !editingId && (
          <button
            onClick={() => setShowEditor(true)}
            className="flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-primary/90"
          >
            <Plus className="h-3 w-3" />
            New Signature
          </button>
        )}
      </div>

      <p className="text-[11px] text-text-tertiary leading-relaxed">
        Create and manage email signatures. Your default signature will be automatically
        appended to new emails.
      </p>

      {/* New signature editor */}
      {showEditor && (
        <SignatureEditor
          accounts={accounts}
          onSave={(data) => {
            createSignature.mutate(data, { onSuccess: () => setShowEditor(false) });
          }}
          onCancel={() => setShowEditor(false)}
        />
      )}

      {/* Edit signature editor */}
      {editingSig && (
        <SignatureEditor
          initial={{
            name: editingSig.name,
            bodyHtml: editingSig.bodyHtml,
            isDefault: editingSig.isDefault,
            accountId: editingSig.accountId,
          }}
          accounts={accounts}
          onSave={(data) => {
            updateSignature.mutate({ id: editingSig.id, ...data }, { onSuccess: () => setEditingId(null) });
          }}
          onCancel={() => setEditingId(null)}
        />
      )}

      {/* Signature list */}
      {signatures && signatures.length > 0 && (
        <div className="space-y-2">
          {signatures.filter((s) => s.id !== editingId).map((sig) => (
            <div
              key={sig.id}
              className="rounded-lg border border-border bg-surface/50 p-3"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-semibold text-text-primary">{sig.name}</span>
                  {sig.isDefault && (
                    <span className="flex items-center gap-0.5 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-600">
                      <Star className="h-2.5 w-2.5" />
                      Default
                      {sig.account && (
                        <span className="ml-0.5 text-amber-500">
                          for {sig.account.displayName || sig.account.email}
                        </span>
                      )}
                    </span>
                  )}
                  {!sig.isDefault && sig.account && (
                    <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] text-text-tertiary">
                      {sig.account.displayName || sig.account.email}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  {!sig.isDefault && (
                    <button
                      onClick={() => updateSignature.mutate({ id: sig.id, isDefault: true })}
                      className="rounded p-1 text-[10px] text-text-tertiary transition-colors hover:bg-white hover:text-amber-500"
                      title="Set as default"
                    >
                      <Star className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => setEditingId(sig.id)}
                    className="rounded p-1 text-text-tertiary transition-colors hover:bg-white hover:text-primary"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => deleteSignature.mutate(sig.id)}
                    className="rounded p-1 text-text-tertiary transition-colors hover:bg-white hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div
                className="text-[11px] text-text-secondary leading-relaxed [&_a]:text-primary [&_a]:underline"
                dangerouslySetInnerHTML={{ __html: sig.bodyHtml }}
              />
            </div>
          ))}
        </div>
      )}

      {signatures && signatures.length === 0 && !showEditor && (
        <p className="text-center text-[11px] text-text-tertiary py-2">
          No signatures yet. Create one to auto-append to your emails.
        </p>
      )}
    </div>
  );
}
