import { useState, useRef, useEffect, useCallback } from 'react';
import { Sparkles, X, CalendarClock, Save, Play, ChevronDown, TextQuote, Trash2, Paperclip, Maximize2, Minimize2 } from 'lucide-react';
import { SignatureIcon } from '../icons/SignatureIcon';
import { RecipientInput, ChipRecipientInput } from './RecipientInput';
import { useMutation, useAction } from 'convex/react';
import toast from 'react-hot-toast';
import { useUiStore } from '../../stores/uiStore';
import { useUndoSendStore } from '../../stores/undoSendStore';
import { api as convexApi } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { ScheduleSendMenu } from './ScheduleSendMenu';
import { useSignatures } from '../../hooks/useSignatures';
import { useSnippets } from '../../hooks/useSnippets';
import { useAuthStore } from '../../stores/authStore';
import { useAccounts } from '../../hooks/useAccounts';
import { useAutoSaveDraft } from '../../hooks/useAutoSaveDraft';
import { useSendDraft } from '../../hooks/useDrafts';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Table from '@tiptap/extension-table';

// Preserve each table element's own inline `style` through the editor
// round-trip (TipTap drops unknown attributes by default — which is why
// borders used to be force-injected on every cell).
const keepStyle = {
  style: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('style'),
    renderHTML: (attrs: { style?: string | null }) =>
      attrs.style ? { style: attrs.style } : {},
  },
  width: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('width'),
    renderHTML: (attrs: { width?: string | null }) =>
      attrs.width ? { width: attrs.width } : {},
  },
};
const StyledTable = Table.extend({
  addAttributes() {
    return { ...this.parent?.(), ...keepStyle };
  },
}).configure({ resizable: false, HTMLAttributes: { class: 'my-2' } });
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
const StyledTableRow = TableRow.extend({
  addAttributes() {
    return { ...this.parent?.(), ...keepStyle };
  },
});
const StyledTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...keepStyle };
  },
});
const StyledTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...keepStyle };
  },
});
import { pasteMarkdown } from '../../lib/composePaste';
import { haptic } from '../../lib/haptics';
import { useIsMobile } from '../../hooks/useIsMobile';
import { MobileFormatToolbar } from './MobileFormatToolbar';

interface ComposeInlineProps {
  threadId?: string;
  lastEmailId?: string;
  accountId?: string;
  mode: 'reply' | 'forward' | 'compose';
  onClose: () => void;
  initialDraft?: { body: string; bodyHtml?: string; to?: string; subject?: string };
  aiOriginal?: { body: string };
  replyRecipients?: { email: string; name?: string }[];
  fromEmail?: string;
  existingDraftId?: string;
  /** Notifies the parent when the user toggles the full-height expand mode. */
  onExpandedChange?: (expanded: boolean) => void;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatScheduleLabel(date: Date): string {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  if (date.toDateString() === now.toDateString()) return `Today ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow ${time}`;
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

export function ComposeInline({ threadId, lastEmailId, accountId, mode, onClose, initialDraft, aiOriginal: initialAiOriginal, replyRecipients, fromEmail: _fromEmail, existingDraftId, onExpandedChange }: ComposeInlineProps) {
  const { toggleAiChat, editingScheduledId, setEditingScheduledId, setComposeContext } = useUiStore();
  const [to, setTo] = useState(initialDraft?.to ?? '');
  const [subject, setSubject] = useState(initialDraft?.subject ?? '');
  const [body, setBody] = useState(initialDraft?.body ?? '');
  const [sending, setSending] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<Date | null>(null);
  const aiOriginalRef = useRef<{ body: string } | undefined>(initialAiOriginal);
  const { data: signatures } = useSignatures();
  const { data: snippets } = useSnippets();
  const { user } = useAuthStore();
  const [selectedSignatureId, setSelectedSignatureId] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<{ email: string; name?: string }[]>(replyRecipients ?? []);
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [ccRecipients, setCcRecipients] = useState<{ email: string; name?: string }[]>([]);
  const [bccRecipients, setBccRecipients] = useState<{ email: string; name?: string }[]>([]);
  const [ccInput, setCcInput] = useState('');
  const [bccInput, setBccInput] = useState('');
  // Buffer for typing additional reply-mode recipients before they commit to
  // the chip list. Enter / comma / Tab / blur commits; backspace on empty
  // input removes the trailing chip — same pattern as the cc/bcc rows below.
  const [toInput, setToInput] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draggingOver, setDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const generateUploadUrl = useMutation(convexApi.emails.generateAttachmentUploadUrl);
  const createScheduledEmail = useMutation(convexApi.scheduledEmails.create);
  const { data: accountsData } = useAccounts();
  // useAccounts() returns { data: <array>, isLoading, ... }, so `accountsData`
  // IS the array — `accountsData?.data` would call .data on an array (always
  // undefined) and silently leave us with no accounts at all.
  const accounts = (accountsData ?? []) as Array<{
    id: string;
    email: string;
    displayName: string | null;
  }>;
  const [sendingAccountId, setSendingAccountId] = useState(accountId || '');
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const sendingAccount = accounts.find((a: any) => a.id === sendingAccountId) || accounts[0];

  // Compose-new opens without an accountId prop, so sendingAccountId starts as ''.
  // The UI always renders accounts[0] as the active account via the fallback above,
  // but the *state* needs to match — otherwise handleSend computes activeAccountId
  // as undefined and the compose mutation branch is skipped silently.
  useEffect(() => {
    if (!sendingAccountId && accounts.length > 0) {
      setSendingAccountId(accounts[0].id);
    }
  }, [sendingAccountId, accounts]);
  const [sigMenuOpen, setSigMenuOpen] = useState(false);
  const [snippetMenuOpen, setSnippetMenuOpen] = useState(false);
  const signatureInserted = useRef(false);
  const isMobile = useIsMobile();
  const [editorFocused, setEditorFocused] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    onExpandedChange?.(expanded);
  }, [expanded, onExpandedChange]);

  const [closeMenuOpen, setCloseMenuOpen] = useState(false);
  const closeMenuRef = useRef<HTMLDivElement>(null);

  // Track keyboard visibility for mobile format toolbar
  useEffect(() => {
    if (!isMobile) return;
    // Listen for Capacitor keyboard events via CSS variable changes
    const observer = new MutationObserver(() => {
      const height = getComputedStyle(document.documentElement).getPropertyValue('--keyboard-height').trim();
      setKeyboardVisible(height !== '' && height !== '0px');
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, [isMobile]);

  // Sync compose state to uiStore so AI chat can see it
  useEffect(() => {
    const timer = setTimeout(() => {
      const toValue = mode === 'compose' ? to : recipients.map((r) => r.email).join(', ');
      setComposeContext({ to: toValue, subject, body, mode, threadId });
    }, 500);
    return () => clearTimeout(timer);
  }, [to, subject, body, recipients, mode, threadId, setComposeContext]);

  // Clear compose context on unmount
  useEffect(() => {
    return () => {
      useUiStore.getState().setComposeContext(null);
    };
  }, []);

  // TipTap rich text editor
  const initialDraftKey = `${initialDraft?.to ?? ''}|${initialDraft?.subject ?? ''}|${initialDraft?.bodyHtml ?? ''}|${initialDraft?.body ?? ''}`;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: { HTMLAttributes: { class: 'border-l-2 border-border pl-3 text-text-secondary' } },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: {
          class: 'text-primary underline cursor-pointer',
        },
      }),
      Placeholder.configure({
        placeholder: 'Write your message...',
      }),
      // Real <table> support so AI-generated tables (e.g. commission
      // breakdowns) survive into the compose editor. Each table keeps the
      // inline style it ARRIVED with instead of a forced per-cell border:
      // AI data tables ship their own border styles, while signatures are
      // borderless LAYOUT tables — the old forced border outlined the
      // signature's invisible scaffolding on every reply (Bryce 2026-07-28:
      // "weird load / lines").
      StyledTable,
      StyledTableRow,
      StyledTableHeader,
      StyledTableCell,
    ],
    content: initialDraft?.bodyHtml
      ? initialDraft.bodyHtml
      : initialDraft?.body
        ? `<p>${escapeHtml(initialDraft.body).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`
        : '',
    editorProps: {
      attributes: {
        // Note the [&_ul] / [&_ol] / [&_strong] selectors: Tailwind's reset
        // zeroes these out, so we re-establish list bullets, numbering and
        // bold weight inside the editor. Without these, pasted Markdown
        // (and any AI draft using bullets) would render as plain text.
        class:
          'min-h-[80px] max-h-[calc(40dvh-var(--keyboard-height,0px))] overflow-y-auto w-full text-sm text-text-primary outline-none ' +
          '[&_p]:mb-3 [&_p:last-child]:mb-0 ' +
          '[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2 ' +
          '[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2 ' +
          '[&_li]:mb-1 [&_li>p]:mb-0 ' +
          '[&_strong]:font-semibold [&_em]:italic [&_code]:font-mono [&_code]:bg-surface [&_code]:px-1 [&_code]:rounded',
      },
      handlePaste: (view, event) => {
        // Handle image paste from clipboard (iOS Photos, screenshots)
        const files = event.clipboardData?.files;
        if (files && files.length > 0) {
          const imageFiles = Array.from(files).filter((f) => f.type.startsWith('image/'));
          if (imageFiles.length > 0) {
            event.preventDefault();
            setAttachments((prev) => [...prev, ...imageFiles]);
            return true;
          }
        }

        const { from, to } = view.state.selection;
        const clipboardText = event.clipboardData?.getData('text/plain')?.trim();
        const clipboardHtml = event.clipboardData?.getData('text/html')?.trim();

        // URL-over-selection → link the selection.
        if (from !== to && clipboardText) {
          try {
            new URL(clipboardText);
            event.preventDefault();
            const { state, dispatch } = view;
            const linkMark = state.schema.marks.link.create({ href: clipboardText });
            const tr = state.tr.addMark(from, to, linkMark);
            dispatch(tr);
            return true;
          } catch {
            // not a URL — fall through to other handlers
          }
        }

        // Plain-text LLM output can contain Markdown. Insert the parsed
        // editor nodes; real clipboard HTML uses Tiptap's default handling.
        try {
          if (clipboardText && pasteMarkdown(view, clipboardText, clipboardHtml)) {
            event.preventDefault();
            return true;
          }
        } catch {
          // Leave the clipboard available to the default paste handler.
        }

        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      setBody(ed.getText());
    },
    onFocus: () => setEditorFocused(true),
    onBlur: () => setEditorFocused(false),
  });

  // Keep an already-open compose box synced when AI produces a revised draft.
  useEffect(() => {
    if (!initialDraft) return;
    setTo(initialDraft.to ?? '');
    setSubject(initialDraft.subject ?? '');
    setBody(initialDraft.body ?? '');
    const nextHtml = initialDraft.bodyHtml
      ? initialDraft.bodyHtml
      : initialDraft.body
        ? `<p>${escapeHtml(initialDraft.body).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`
        : '';
    if (editor && editor.getHTML() !== nextHtml) {
      editor.commands.setContent(nextHtml, false);
    }
  }, [initialDraftKey, editor]);

  // Auto-save drafts
  const { draftId, saveDraft: saveDraftFn, deleteDraft: deleteDraftFn, markSent, prepareForSend, resumeAfterSendFailure, isSaving: isDraftSaving, lastSavedAt } = useAutoSaveDraft({
    accountId: sendingAccountId || accountId || '',
    threadId,
    mode,
    parentEmailId: lastEmailId,
    existingDraftId,
    enabled: !editingScheduledId,
  });
  const sendDraftMutation = useSendDraft();
  const sendEmailMutation = useMutation(convexApi.emails.send);
  const replyEmailMutation = useMutation(convexApi.emails.reply);
  const forwardEmailMutation = useMutation(convexApi.emails.forward);
  const updateDraftMutation = useMutation(convexApi.drafts.update);
  const updateScheduledMutation = useMutation(convexApi.scheduledEmails.update);
  const sendScheduledNowMutation = useMutation(convexApi.scheduledEmails.sendScheduledNow);
  const recordEditAction = useAction(convexApi.ai.learn.recordEdit);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Guard against losing unsaved work. We treat any non-empty body, subject,
  // typed recipient, or attached file as "dirty" — clicking X on a dirty
  // compose opens a small menu (Save / Delete) instead of closing outright.
  // Reply-mode pre-fills `recipients` from props — that's NOT user input, so
  // we only count `to` (compose/forward) toward dirtiness.
  useEffect(() => {
    if (!closeMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (closeMenuRef.current && !closeMenuRef.current.contains(e.target as Node)) {
        setCloseMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [closeMenuOpen]);

  const isDirty =
    body.length > 0 ||
    subject.length > 0 ||
    (mode !== 'reply' && to.length > 0) ||
    attachments.length > 0;

  const handleCloseClick = useCallback(() => {
    if (isDirty) {
      setCloseMenuOpen((v) => !v);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  const handleSaveAndClose = useCallback(() => {
    setCloseMenuOpen(false);
    onClose();
  }, [onClose]);

  const clearComposeStash = useCallback(() => {
    try {
      sessionStorage.removeItem(`orbi-compose-stash-${threadId ?? 'new'}`);
    } catch {
      /* ignore */
    }
  }, [threadId]);

  const handleDeleteDraft = useCallback(async () => {
    clearComposeStash();
    setCloseMenuOpen(false);
    try {
      await deleteDraftFn();
    } catch {
      // Already-missing draft is fine; close anyway.
    }
    onClose();
  }, [deleteDraftFn, onClose]);

  // Upload attachments to Convex storage; returns the array shape send/reply/forward expect.
  const uploadAttachments = async (files: File[]): Promise<Array<{ filename: string; mimeType: string; size: number; storageId: Id<'_storage'> }>> => {
    if (files.length === 0) return [];
    const out: Array<{ filename: string; mimeType: string; size: number; storageId: Id<'_storage'> }> = [];
    for (const f of files) {
      const url = await generateUploadUrl({});
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': f.type || 'application/octet-stream' }, body: f });
      if (!res.ok) throw new Error('Attachment upload failed');
      const { storageId } = await res.json() as { storageId: Id<'_storage'> };
      out.push({ filename: f.name, mimeType: f.type || 'application/octet-stream', size: f.size, storageId });
    }
    return out;
  };

  const triggerAutoSave = useCallback(() => {
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      if (!editor) return;
      saveDraftFn({
        subject,
        bodyHtml: editor.getHTML(),
        bodyText: editor.getText(),
        toAddresses: mode === 'reply'
          ? recipients.map((r) => ({ email: r.email, name: r.name }))
          : to.split(',').map((e) => e.trim()).filter(Boolean).map((e) => ({ email: e })),
      });
    }, 5000);
  }, [editor, subject, to, recipients, mode, saveDraftFn]);

  // Save immediately on visibility change (tab close/switch)
  useEffect(() => {
    const handler = () => {
      if (document.visibilityState === 'hidden' && editor) {
        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
        saveDraftFn({
          subject,
          bodyHtml: editor.getHTML(),
          bodyText: editor.getText(),
          toAddresses: mode === 'reply'
            ? recipients.map((r) => ({ email: r.email, name: r.name }))
            : to.split(',').map((e) => e.trim()).filter(Boolean).map((e) => ({ email: e })),
        });
      }
    };
    document.addEventListener('visibilitychange', handler);
    // Also save on iOS app backgrounding (capacitorInit dispatches this)
    window.addEventListener('app-background', handler);
    return () => {
      document.removeEventListener('visibilitychange', handler);
      window.removeEventListener('app-background', handler);
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [editor, subject, to, recipients, mode, saveDraftFn]);

  // Trigger auto-save on editor content changes + keep a local crash-net
  // copy: whatever destroys the composer (remount, crash, reload), the
  // typed text survives in sessionStorage and is restored on next mount.
  const stashKey = `orbi-compose-stash-${threadId ?? 'new'}`;
  useEffect(() => {
    if (!editor) return;
    const handler = () => {
      triggerAutoSave();
      try {
        sessionStorage.setItem(
          stashKey,
          JSON.stringify({ at: Date.now(), bodyHtml: editor.getHTML(), bodyText: editor.getText(), subject }),
        );
      } catch {
        /* storage full — autosave still covers us */
      }
    };
    editor.on('update', handler);
    return () => { editor.off('update', handler); };
  }, [editor, triggerAutoSave, stashKey, subject]);

  // Restore the crash-net stash if it's meaningfully richer than what this
  // mount started with (draft row may lag several seconds behind typing).
  const stashRestoredRef = useRef(false);
  useEffect(() => {
    if (!editor || stashRestoredRef.current) return;
    stashRestoredRef.current = true;
    try {
      const raw = sessionStorage.getItem(stashKey);
      if (!raw) return;
      const stash = JSON.parse(raw) as { at: number; bodyHtml: string; bodyText: string };
      if (Date.now() - stash.at > 24 * 60 * 60 * 1000) return;
      const current = editor.getText().trim();
      if ((stash.bodyText ?? '').trim().length > current.length + 5) {
        editor.commands.setContent(stash.bodyHtml);
      }
    } catch {
      /* corrupt stash — ignore */
    }
  }, [editor, stashKey]);

  // Close account menu on outside click
  useEffect(() => {
    if (!accountMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (accountMenuRef.current && !accountMenuRef.current.contains(e.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [accountMenuOpen]);

  // Auto-insert default signature
  useEffect(() => {
    if (signatureInserted.current || !signatures || signatures.length === 0) return;
    const defaultSig = signatures.find((s) => s.isDefault) || null;
    if (defaultSig) {
      setSelectedSignatureId(defaultSig.id);
      signatureInserted.current = true;
    }
  }, [signatures]);

  // Warn before losing unsaved compose draft
  useEffect(() => {
    if (!body.trim()) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [body]);

  const { addPendingEmail } = useUndoSendStore();
  const UNDO_WINDOW_SECONDS = 60;
  const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024; // 25MB

  const addFiles = (newFiles: FileList | File[]) => {
    const fileArray = Array.from(newFiles);
    const currentSize = attachments.reduce((sum, f) => sum + f.size, 0);
    const newSize = fileArray.reduce((sum, f) => sum + f.size, 0);
    if (currentSize + newSize > MAX_ATTACHMENT_SIZE) {
      toast.error('Total attachments exceed 25MB limit');
      return;
    }
    setAttachments((prev) => [...prev, ...fileArray]);
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };


  const submitAiLearn = async () => {
    if (aiOriginalRef.current && aiOriginalRef.current.body !== body) {
      const contactEmail = to.trim().split(',')[0]?.trim();
      try {
        await recordEditAction({
          originalText: aiOriginalRef.current.body,
          editedText: body,
          contactEmail: contactEmail || undefined,
          threadId: threadId || undefined,
        });
      } catch {
        // Learning is non-critical
      }
    }
  };

  /** Register the email in the undo store so the pill appears */
  const registerUndo = (res: { data: any }) => {
    if (res.data?.undoDeadlineAt) {
      const recipientStr = mode === 'reply' && recipients.length > 0
        ? recipients.map((r) => r.name || r.email).join(', ')
        : to;
      addPendingEmail({
        id: res.data.id,
        threadId: res.data.threadId || threadId,
        accountId: sendingAccountId || accountId,
        body,
        bodyHtml: editor?.getHTML() || '',
        to: recipientStr,
        subject: res.data.subject || subject,
        mode,
        lastEmailId,
        undoDeadlineAt: res.data.undoDeadlineAt,
      });
    }
  };

  const sendInFlightRef = useRef(false);
  const handleSend = async () => {
    if (!body.trim() || sendInFlightRef.current) return;

    // Validate email addresses for compose/forward mode
    if (mode !== 'reply') {
      const addresses = to.split(',').map((e) => e.trim()).filter(Boolean);
      if (addresses.length === 0) {
        toast.error('Please add at least one recipient');
        return;
      }
      const allAddresses = [
        ...addresses,
        ...(showCc ? cc.split(',').map((e) => e.trim()).filter(Boolean) : []),
        ...(showBcc ? bcc.split(',').map((e) => e.trim()).filter(Boolean) : []),
      ];
      const invalid = allAddresses.filter((e) => !EMAIL_REGEX.test(e));
      if (invalid.length > 0) {
        toast.error(`Invalid email address: ${invalid[0]}`);
        return;
      }
    }

    // Build cc/bcc arrays
    const ccArray = mode === 'reply'
      ? ccRecipients
      : (showCc ? cc.split(',').map((e) => e.trim()).filter(Boolean).map((e) => ({ email: e })) : []);
    const bccArray = mode === 'reply'
      ? bccRecipients
      : (showBcc ? bcc.split(',').map((e) => e.trim()).filter(Boolean).map((e) => ({ email: e })) : []);

    sendInFlightRef.current = true;
    // Cancel any pending autosave before we touch the draft row.
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    setSending(true);
    try {
      const savedDraftId = await prepareForSend();
      await submitAiLearn();
      const selectedSig = selectedSignatureId ? signatures?.find((s) => s.id === selectedSignatureId) : null;
      const messageHtml = editor?.getHTML() || '';
      const bodyHtml = selectedSig
        ? `${messageHtml}<div class="email-signature" style="margin-top:16px">${selectedSig.bodyHtml}</div>`
        : messageHtml;

      // If a schedule date is set, schedule instead of sending
      if (scheduledAt) {
        // Reply recipients live in the `recipients` chip list, not the `to`
        // string — storing [] here used to make every scheduled reply send
        // to nobody.
        const toAddresses = mode === 'reply'
          ? recipients.map((r) => ({ email: r.email, name: r.name }))
          : to.split(',').map((e) => ({ email: e.trim() })).filter((a) => a.email);
        if (toAddresses.length === 0 && mode !== 'reply') {
          throw new Error('Please add at least one recipient');
        }

        // Upload attachments now so the files are in Convex storage when the
        // scheduled send fires (possibly days later, app closed).
        const scheduledUploads = await uploadAttachments(attachments);

        await createScheduledEmail({
          accountId: (sendingAccountId || accountId) as Id<'mailAccounts'>,
          threadId: threadId ? (threadId as Id<'threads'>) : undefined,
          parentEmailId: lastEmailId || undefined,
          mode,
          to: toAddresses,
          cc: ccArray.length > 0 ? ccArray : undefined,
          bcc: bccArray.length > 0 ? bccArray : undefined,
          subject: subject || '(no subject)',
          bodyHtml,
          bodyText: body,
          sendAt: scheduledAt.getTime(),
          attachments: scheduledUploads.length > 0 ? scheduledUploads : undefined,
        });

        // Retire the autosaved draft, same as the immediate-send path —
        // otherwise it lingers and reopens pre-filled, one Cmd+Enter from a
        // duplicate send.
        if (!(await markSent())) toast.error('Message queued, but its old draft could not be removed.');
        clearComposeStash();
        onClose();
        return;
      }

      let res: { data: any };

      // Consume the saved row when this endpoint can carry the complete
      // message. Attachments/CC/BCC use the fresh-send path and then discard
      // only this composer's saved draft.
      if (savedDraftId && attachments.length === 0 && ccArray.length === 0 && bccArray.length === 0) {
        const upd = await updateDraftMutation({
          draftId: savedDraftId as Id<'emails'>,
          subject: subject || '(no subject)', bodyHtml, bodyText: body,
          toAddresses: mode === 'reply'
            ? recipients.map((r) => ({ email: r.email, name: r.name }))
            : to.split(',').map((e) => ({ email: e.trim() })).filter(a => a.email),
        });
        if (upd.stale || !upd.data) {
          throw new Error('This draft was changed or already sent. Reopen the conversation before sending again.');
        }
        if (upd.data.accountId === (sendingAccountId || accountId)) {
          // Do not fall back to a second send after an ambiguous send error.
          res = await sendDraftMutation.mutateAsync({ draftId: savedDraftId, undoWindowSeconds: UNDO_WINDOW_SECONDS });
          if (!(await markSent())) toast.error('Message queued, but its old draft could not be removed.');
          clearComposeStash();
          haptic.success();
          registerUndo(res);
          onClose();
          return;
        }
      }

      const activeAccountId = (sendingAccountId || accountId) as Id<'mailAccounts'>;
      const attachmentUploads = await uploadAttachments(attachments);

      if (mode === 'reply' && lastEmailId && activeAccountId) {
        if (recipients.length === 0) {
          throw new Error('Please add at least one recipient');
        }
        res = await replyEmailMutation({
          parentEmailId: lastEmailId as Id<'emails'>,
          accountId: activeAccountId,
          to: recipients.map((r) => ({ email: r.email, name: r.name })),
          bodyHtml,
          bodyText: body,
          cc: ccArray.length > 0 ? ccArray : undefined,
          bcc: bccArray.length > 0 ? bccArray : undefined,
          attachments: attachmentUploads.length > 0 ? attachmentUploads : undefined,
        }) as { data: any };
      } else if (mode === 'forward' && lastEmailId && activeAccountId) {
        res = await forwardEmailMutation({
          sourceEmailId: lastEmailId as Id<'emails'>,
          accountId: activeAccountId,
          to: to.split(',').map((e) => ({ email: e.trim() })),
          bodyHtml,
          bodyText: body,
          attachments: attachmentUploads.length > 0 ? attachmentUploads : undefined,
        }) as { data: any };
      } else if (mode === 'compose' && activeAccountId) {
        res = await sendEmailMutation({
          accountId: activeAccountId,
          to: to.split(',').map((e) => ({ email: e.trim() })),
          cc: ccArray.length > 0 ? ccArray : undefined,
          bcc: bccArray.length > 0 ? bccArray : undefined,
          subject,
          bodyHtml,
          bodyText: body,
          attachments: attachmentUploads.length > 0 ? attachmentUploads : undefined,
        }) as { data: any };
      } else {
        // We get here only if no mutation matched — typically because no
        // account is selected (sendingAccountId still '' AND accountId prop
        // missing). Surface this loudly instead of silently dropping the send.
        if (!activeAccountId) {
          throw new Error('No mail account selected — connect or pick a sending account.');
        }
        if ((mode === 'reply' || mode === 'forward') && !lastEmailId) {
          throw new Error(`Cannot ${mode}: missing source email.`);
        }
        throw new Error(`Could not send (mode=${mode}, accountId=${activeAccountId ? 'set' : 'missing'}).`);
      }

      if (!(await markSent())) toast.error('Message queued, but its old draft could not be removed.');
      clearComposeStash();
      haptic.success();
      registerUndo(res!);
      onClose();
    } catch (err: any) {
      resumeAfterSendFailure();
      console.error('Send failed:', err);
      haptic.error();
      toast.error(err?.message || 'Failed to send');
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  };

  const handleSaveScheduled = async () => {
    if (!editingScheduledId || !body.trim()) return;
    setSending(true);
    try {
      const bodyHtml = editor?.getHTML() || '';
      await updateScheduledMutation({
        id: editingScheduledId as Id<'scheduledEmails'>,
        bodyHtml,
        bodyText: body,
        subject: subject || '(no subject)',
        ...(mode !== 'reply' ? { to: to.split(',').map((e) => ({ email: e.trim() })) } : {}),
      });
      setEditingScheduledId(null);
      onClose();
    } catch (err: any) {
      console.error('Save failed:', err);
      toast.error(err?.message || 'Failed to save scheduled email');
    } finally {
      setSending(false);
    }
  };

  const handleSendScheduledNow = async () => {
    if (!editingScheduledId) return;
    setSending(true);
    try {
      const bodyHtml = editor?.getHTML() || '';
      // One backend call: saves the latest edits AND dispatches through the
      // scheduled-send pipeline (which knows how to derive reply recipients
      // and threading from the parent email). The old version fired a
      // separate emails.send here while leaving the row SCHEDULED — a recipe
      // for a double-send and replies that broke out of their thread.
      const toAddresses = mode === 'reply'
        ? recipients.map((r) => ({ email: r.email, name: r.name }))
        : to.split(',').map((e) => ({ email: e.trim() })).filter((a) => a.email);
      await sendScheduledNowMutation({
        id: editingScheduledId as Id<'scheduledEmails'>,
        bodyHtml,
        bodyText: body,
        subject: subject || '(no subject)',
        ...(toAddresses.length > 0 ? { to: toAddresses } : {}),
      });
      setEditingScheduledId(null);
      onClose();
    } catch (err: any) {
      console.error('Send now failed:', err);
      toast.error(err?.message || 'Failed to send scheduled email');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (editingScheduledId) {
        handleSaveScheduled();
      } else {
        handleSend();
      }
    }
  };

  return (
    <div
      className={`flex flex-col border-t border-border bg-white${expanded ? ' min-h-0' : ''}`}
      style={expanded ? { flex: '999 1 0%' } : undefined}
      onKeyDown={handleKeyDown}
    >
      {/* Header — mode label, recipients, from account, AI + expand + close */}
      <div className="shrink-0 border-b border-border px-5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="shrink-0 text-xs font-semibold uppercase tracking-wider text-text-tertiary">
            {editingScheduledId ? 'Edit Scheduled' : mode === 'reply' ? 'Reply all' : mode === 'forward' ? 'Forward' : 'New Email'}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => toggleAiChat()}
              className="rounded-lg p-1 text-ai transition-colors hover:bg-ai/10"
              title="AI Assistant"
              aria-label="AI Assistant"
            >
              <Sparkles className="h-3.5 w-3.5" />
            </button>
            {!isMobile && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="rounded-lg p-1 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
                title={expanded ? 'Collapse' : 'Expand'}
                aria-label={expanded ? 'Collapse compose' : 'Expand compose'}
              >
                {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
            )}
            <div ref={closeMenuRef} className="relative">
              <button
                onClick={handleCloseClick}
                className="rounded-lg p-1 text-text-tertiary transition-colors hover:bg-surface"
                aria-label="Close compose"
                aria-haspopup={isDirty ? 'menu' : undefined}
                aria-expanded={closeMenuOpen}
              >
                <X className="h-3.5 w-3.5" />
              </button>
              {closeMenuOpen && (
                <div className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-white shadow-lg">
                  <button
                    onClick={handleSaveAndClose}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-text-primary transition-colors hover:bg-primary/10"
                  >
                    <X className="h-3.5 w-3.5 text-blue-500" />
                    <span>Save and Close Draft</span>
                  </button>
                  <button
                    onClick={handleDeleteDraft}
                    className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12px] text-text-primary transition-colors hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    <span>Delete Draft</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Reply recipients + from account */}
        {mode === 'reply' && (<>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-text-tertiary">To:</span>
            {recipients.map((r, i) => (
              <span
                key={r.email}
                className="group inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] text-text-secondary"
              >
                {r.name || r.email}
                <button
                  onClick={() => setRecipients((prev) => prev.filter((_, j) => j !== i))}
                  className="hidden rounded-full p-0.5 text-text-tertiary hover:bg-border hover:text-text-primary group-hover:inline-flex"
                  aria-label={`Remove recipient ${r.name || r.email}`}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
            <ChipRecipientInput
              inputValue={toInput}
              onInputChange={setToInput}
              onCommit={(email, name) => {
                if (!recipients.some((r) => r.email === email)) {
                  setRecipients((prev) => [...prev, { email, ...(name ? { name } : {}) }]);
                }
              }}
              onBackspaceEmpty={() => {
                if (recipients.length > 0) setRecipients((prev) => prev.slice(0, -1));
              }}
              placeholder={recipients.length === 0 ? 'Add recipient…' : ''}
            />
            <div className="flex items-center gap-1.5 ml-auto">
              {!showCc && (
                <button
                  onClick={() => setShowCc(true)}
                  className="text-[10px] text-text-tertiary transition-colors hover:text-text-secondary"
                >
                  Cc
                </button>
              )}
              {!showBcc && (
                <button
                  onClick={() => setShowBcc(true)}
                  className="text-[10px] text-text-tertiary transition-colors hover:text-text-secondary"
                >
                  Bcc
                </button>
              )}
              {sendingAccount && (
                <div className="relative shrink-0" ref={accountMenuRef}>
                  <button
                    onClick={() => setAccountMenuOpen(!accountMenuOpen)}
                    className="flex items-center gap-1 rounded-full bg-surface/80 px-2.5 py-0.5 text-[10px] text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary"
                  >
                    {sendingAccount.displayName || sendingAccount.email}
                    {accounts.length > 1 && <ChevronDown className="h-2.5 w-2.5" />}
                  </button>
                  {accountMenuOpen && accounts.length > 1 && (
                    <div className="absolute right-0 bottom-full mb-1 z-50 w-56 rounded-lg border border-border bg-white py-1 shadow-lg">
                      <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Send from</p>
                      {accounts.map((acc: any) => (
                        <button
                          key={acc.id}
                          onClick={() => {
                            setSendingAccountId(acc.id);
                            setAccountMenuOpen(false);
                          }}
                          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface ${
                            acc.id === sendingAccountId ? 'bg-selected' : ''
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium text-text-primary">
                              {acc.displayName || acc.email.split('@')[0]}
                            </p>
                            <p className="truncate text-[10px] text-text-tertiary">{acc.email}</p>
                          </div>
                          {acc.id === sendingAccountId && (
                            <span className="text-[10px] text-primary font-medium">Active</span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* CC row for reply mode */}
          {showCc && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-text-tertiary">Cc:</span>
              {ccRecipients.map((r, i) => (
                <span
                  key={r.email}
                  className="group inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] text-text-secondary"
                >
                  {r.name || r.email}
                  <button
                    onClick={() => setCcRecipients((prev) => prev.filter((_, j) => j !== i))}
                    className="hidden rounded-full p-0.5 text-text-tertiary hover:bg-border hover:text-text-primary group-hover:inline-flex"
                    aria-label={`Remove CC recipient ${r.name || r.email}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
              <ChipRecipientInput
                inputValue={ccInput}
                onInputChange={setCcInput}
                onCommit={(email, name) => {
                  if (!ccRecipients.some((r) => r.email === email)) {
                    setCcRecipients((prev) => [...prev, { email, ...(name ? { name } : {}) }]);
                  }
                }}
                onBackspaceEmpty={() => {
                  if (ccRecipients.length > 0) setCcRecipients((prev) => prev.slice(0, -1));
                }}
                placeholder="Add CC recipient..."
              />
            </div>
          )}
          {/* BCC row for reply mode */}
          {showBcc && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-text-tertiary">Bcc:</span>
              {bccRecipients.map((r, i) => (
                <span
                  key={r.email}
                  className="group inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] text-text-secondary"
                >
                  {r.name || r.email}
                  <button
                    onClick={() => setBccRecipients((prev) => prev.filter((_, j) => j !== i))}
                    className="hidden rounded-full p-0.5 text-text-tertiary hover:bg-border hover:text-text-primary group-hover:inline-flex"
                    aria-label={`Remove BCC recipient ${r.name || r.email}`}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
              <ChipRecipientInput
                inputValue={bccInput}
                onInputChange={setBccInput}
                onCommit={(email, name) => {
                  if (!bccRecipients.some((r) => r.email === email)) {
                    setBccRecipients((prev) => [...prev, { email, ...(name ? { name } : {}) }]);
                  }
                }}
                onBackspaceEmpty={() => {
                  if (bccRecipients.length > 0) setBccRecipients((prev) => prev.slice(0, -1));
                }}
                placeholder="Add BCC recipient..."
              />
            </div>
          )}
        </>)}
      </div>

      {/* To / Subject fields for forward/compose */}
      {(mode === 'forward' || mode === 'compose') && (
        <div className="shrink-0 space-y-2 border-b border-border px-5 py-2.5">
          <div className="flex items-center gap-2">
            <label className="w-12 text-xs text-text-tertiary">To:</label>
            <RecipientInput
              value={to}
              onChange={setTo}
              placeholder="recipient@example.com"
            />
            <div className="flex items-center gap-1.5 shrink-0">
              {!showCc && (
                <button
                  onClick={() => setShowCc(true)}
                  className="text-xs text-text-tertiary transition-colors hover:text-text-secondary"
                >
                  Cc
                </button>
              )}
              {!showBcc && (
                <button
                  onClick={() => setShowBcc(true)}
                  className="text-xs text-text-tertiary transition-colors hover:text-text-secondary"
                >
                  Bcc
                </button>
              )}
            </div>
          </div>
          {showCc && (
            <div className="flex items-center gap-2">
              <label className="w-12 text-xs text-text-tertiary">Cc:</label>
              <RecipientInput
                value={cc}
                onChange={setCc}
                placeholder="cc@example.com"
              />
            </div>
          )}
          {showBcc && (
            <div className="flex items-center gap-2">
              <label className="w-12 text-xs text-text-tertiary">Bcc:</label>
              <RecipientInput
                value={bcc}
                onChange={setBcc}
                placeholder="bcc@example.com"
              />
            </div>
          )}
          {mode === 'compose' && (
            <div className="flex items-center gap-2">
              <label className="w-12 text-xs text-text-tertiary">Subject:</label>
              <input
                type="text"
                value={subject}
                onChange={(e) => { setSubject(e.target.value); triggerAutoSave(); }}
                className="flex-1 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
                placeholder="Subject"
              />
            </div>
          )}
        </div>
      )}

      {/* Compose body — TipTap rich text editor */}
      <div
        className={`px-5 py-3 transition-colors${draggingOver ? ' bg-primary/5 ring-2 ring-inset ring-primary/20 rounded' : ''}${expanded ? ' min-h-0 flex-1 overflow-y-auto' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDraggingOver(true); }}
        onDragLeave={() => setDraggingOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDraggingOver(false);
          if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
        }}
      >
        {editor ? (
          <EditorContent editor={editor} className={expanded ? 'h-full' : undefined} />
        ) : (
          <div className="min-h-[80px]" />
        )}
        {draggingOver && (
          <p className="mt-1 text-center text-xs text-primary">Drop files to attach</p>
        )}
      </div>

      {/* Attachment list */}
      {attachments.length > 0 && (
        <div className="shrink-0 flex flex-wrap gap-1.5 border-t border-border/50 px-5 py-2">
          {attachments.map((file, i) => (
            <div key={`${file.name}-${i}`} className="group flex items-center gap-1.5 rounded-lg border border-border bg-surface/50 px-2.5 py-1 text-xs">
              <Paperclip className="h-3 w-3 shrink-0 text-text-tertiary" />
              <span className="max-w-[140px] truncate text-text-secondary">{file.name}</span>
              <span className="text-text-tertiary">({formatFileSize(file.size)})</span>
              <button
                onClick={() => removeAttachment(i)}
                className="rounded-full p-0.5 text-text-tertiary transition-colors hover:bg-border hover:text-text-primary"
                aria-label={`Remove attachment ${file.name}`}
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {/* Actions */}
      <div className="shrink-0 flex items-center justify-between gap-3 border-t border-border px-5 py-2.5">
        <div className="flex min-w-0 items-center gap-2 overflow-hidden">
          {/* Keyboard hint is the first thing to go when the row gets tight —
              a pending schedule chip is far more useful than a shortcut
              reminder (Bryce 2026-09-07: "trying to fit so much in a small
              space"). */}
          {!scheduledAt && (
            <span className="hidden whitespace-nowrap font-mono text-[10px] text-text-tertiary lg:inline">
              {editingScheduledId ? 'Cmd+Enter to save' : 'Cmd+Enter to send'}
            </span>
          )}
          {!editingScheduledId && (isDraftSaving ? (
            <span className="whitespace-nowrap text-[10px] text-text-tertiary">Saving...</span>
          ) : lastSavedAt ? (
            <span className="whitespace-nowrap text-[10px] text-text-tertiary">Draft saved</span>
          ) : null)}
          {/* Attach file button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary"
            title="Attach file"
          >
            <Paperclip className="h-3 w-3 shrink-0" />
            Attach
          </button>
          {/* Signature selector */}
          {signatures && signatures.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setSigMenuOpen((v) => !v)}
                className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary"
                title="Select signature"
              >
                <SignatureIcon className="h-3 w-3 shrink-0" />
                <span className="max-w-[9rem] truncate">
                  {selectedSignatureId
                    ? signatures.find((s) => s.id === selectedSignatureId)?.name ?? 'Signature'
                    : 'No signature'}
                </span>
                <ChevronDown className="h-2.5 w-2.5 shrink-0" />
              </button>
              {sigMenuOpen && (
                <div className="absolute bottom-full left-0 mb-1 w-44 rounded-lg border border-border bg-white py-1 shadow-lg z-10">
                  <button
                    onClick={() => { setSelectedSignatureId(null); setSigMenuOpen(false); }}
                    className={`w-full px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-surface ${!selectedSignatureId ? 'font-semibold text-primary' : 'text-text-secondary'}`}
                  >
                    None
                  </button>
                  {signatures.map((sig) => (
                    <button
                      key={sig.id}
                      onClick={() => { setSelectedSignatureId(sig.id); setSigMenuOpen(false); }}
                      className={`w-full px-3 py-1.5 text-left text-[11px] transition-colors hover:bg-surface ${selectedSignatureId === sig.id ? 'font-semibold text-primary' : 'text-text-secondary'}`}
                    >
                      {sig.name} {sig.isDefault && '(default)'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {/* Snippet inserter */}
          {snippets && snippets.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setSnippetMenuOpen((v) => !v)}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary"
                title="Insert snippet"
              >
                <TextQuote className="h-3 w-3" />
                Snippet
              </button>
              {snippetMenuOpen && (
                <div className="absolute bottom-full left-0 mb-1 w-52 rounded-lg border border-border bg-white py-1 shadow-lg z-10 max-h-48 overflow-y-auto">
                  {snippets.map((snippet) => (
                    <button
                      key={snippet.id}
                      onClick={() => {
                        // Replace variables
                        let text = snippet.bodyText;
                        const recipientName = to.split(',')[0]?.split('@')[0]?.trim() || '';
                        text = text.replace(/\{\{recipient_name\}\}/g, recipientName);
                        text = text.replace(/\{\{my_name\}\}/g, user?.name || '');
                        text = text.replace(/\{\{company\}\}/g, 'Orbi');
                        text = text.replace(/\{\{date\}\}/g, new Date().toLocaleDateString());
                        text = text.replace(/\{\{subject\}\}/g, subject);
                        if (editor) {
                          const html = `<p>${escapeHtml(text).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`;
                          editor.chain().focus().insertContent(html).run();
                        }
                        setSnippetMenuOpen(false);
                      }}
                      className="w-full px-3 py-1.5 text-left transition-colors hover:bg-surface"
                    >
                      <p className="text-[11px] font-medium text-text-primary">{snippet.name}</p>
                      <p className="text-[10px] text-text-tertiary line-clamp-1">{snippet.bodyText}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {editingScheduledId ? (
            <>
              <button
                onClick={handleSendScheduledNow}
                disabled={!body.trim() || sending}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                {sending ? 'Sending...' : 'Send Now'}
              </button>
              <button
                onClick={handleSaveScheduled}
                disabled={!body.trim() || sending}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {sending ? 'Saving...' : 'Save'}
              </button>
            </>
          ) : (
            <>
              {/* Discard draft */}
              {draftId && (
                <button
                  onClick={async () => {
                    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
                    await deleteDraftFn();
                    onClose();
                  }}
                  className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-red-50 hover:text-red-500"
                  title="Discard draft"
                  aria-label="Discard draft"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              )}
              {/* Scheduled time — shown ONCE. It used to appear in this chip
                  AND again inside the send button, on a row that then wrapped
                  every label onto two lines. The chip owns the time (× clears
                  it) and the button just states the verb. */}
              {scheduledAt ? (
                <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-lg bg-amber-50 py-1 pl-2 pr-1 text-[11px] font-medium text-amber-600">
                  <CalendarClock className="h-3 w-3 shrink-0" />
                  {formatScheduleLabel(scheduledAt)}
                  <button
                    onClick={() => setScheduledAt(null)}
                    className="rounded p-0.5 transition-colors hover:bg-amber-100"
                    title="Clear schedule — send immediately instead"
                    aria-label="Clear scheduled send"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ) : null}
              <ScheduleSendMenu
                onSchedule={(date) => setScheduledAt(date)}
                disabled={!body.trim() || sending}
              />
              <button
                onClick={handleSend}
                disabled={!body.trim() || sending}
                className="shrink-0 whitespace-nowrap rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
                title={scheduledAt ? `Send on ${formatScheduleLabel(scheduledAt)}` : undefined}
              >
                {sending ? 'Sending...' : scheduledAt ? 'Schedule' : 'Send'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Mobile formatting toolbar — floats above keyboard */}
      {isMobile && (
        <MobileFormatToolbar
          editor={editor}
          visible={editorFocused && keyboardVisible}
        />
      )}
    </div>
  );
}
