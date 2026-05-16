import { useState, useRef, useEffect, useCallback } from 'react';
import { Sparkles, X, Loader2, CalendarClock, Save, Play, FileSignature, ChevronDown, TextQuote, Trash2, Paperclip } from 'lucide-react';
import { RecipientInput } from './RecipientInput';
import { useQueryClient } from '@tanstack/react-query';
import { useMutation, useAction } from 'convex/react';
import toast from 'react-hot-toast';
import { useUiStore } from '../../stores/uiStore';
import { useUndoSendStore } from '../../stores/undoSendStore';
import { api as convexApi } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import { ScheduleSendMenu } from './ScheduleSendMenu';
import { useSignatures, type Signature } from '../../hooks/useSignatures';
import { useSnippets } from '../../hooks/useSnippets';
import { useAuthStore } from '../../stores/authStore';
import { useAccounts } from '../../hooks/useAccounts';
import { useAutoSaveDraft } from '../../hooks/useAutoSaveDraft';
import { useSendDraft } from '../../hooks/useDrafts';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
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

  if (date.toDateString() === now.toDateString()) return `today at ${time}`;
  if (date.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${time}`;
}

export function ComposeInline({ threadId, lastEmailId, accountId, mode, onClose, initialDraft, aiOriginal: initialAiOriginal, replyRecipients, fromEmail, existingDraftId }: ComposeInlineProps) {
  const { toggleAiChat, editingScheduledId, setEditingScheduledId, setComposeContext } = useUiStore();
  const queryClient = useQueryClient();
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
  const [attachments, setAttachments] = useState<File[]>([]);
  const [draggingOver, setDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const generateUploadUrl = useMutation(convexApi.emails.generateAttachmentUploadUrl);
  const sendEmail = useMutation(convexApi.emails.send);
  const replyEmail = useMutation(convexApi.emails.reply);
  const forwardEmail = useMutation(convexApi.emails.forward);
  const createScheduledEmail = useMutation(convexApi.scheduledEmails.create);
  const updateScheduledEmail = useMutation(convexApi.scheduledEmails.update);
  const learnFromEdit = useAction(convexApi.ai.learn.recordEdit);
  const { data: accountsData } = useAccounts();
  const accounts = accountsData?.data ?? [];
  const [sendingAccountId, setSendingAccountId] = useState(accountId || '');
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const sendingAccount = accounts.find((a: any) => a.id === sendingAccountId) || accounts[0];
  const [sigMenuOpen, setSigMenuOpen] = useState(false);
  const [snippetMenuOpen, setSnippetMenuOpen] = useState(false);
  const signatureInserted = useRef(false);
  const isMobile = useIsMobile();
  const [editorFocused, setEditorFocused] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

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
    ],
    content: initialDraft?.bodyHtml
      ? initialDraft.bodyHtml
      : initialDraft?.body
        ? `<p>${escapeHtml(initialDraft.body).replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`
        : '',
    editorProps: {
      attributes: {
        class: 'min-h-[80px] max-h-[calc(40dvh-var(--keyboard-height,0px))] overflow-y-auto w-full text-sm text-text-primary outline-none [&_p]:mb-3 [&_p:last-child]:mb-0',
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

        // If text is selected and clipboard contains a URL, create a link
        const { from, to } = view.state.selection;
        if (from === to) return false; // no selection

        const clipboardText = event.clipboardData?.getData('text/plain')?.trim();
        if (!clipboardText) return false;

        try {
          new URL(clipboardText);
        } catch {
          return false; // not a valid URL, let default paste handle it
        }

        // It's a URL pasted over selected text — create a link
        event.preventDefault();
        const { state, dispatch } = view;
        const linkMark = state.schema.marks.link.create({ href: clipboardText });
        const tr = state.tr.addMark(from, to, linkMark);
        dispatch(tr);
        return true;
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
  const { draftId, saveDraft: saveDraftFn, deleteDraft: deleteDraftFn, isSaving: isDraftSaving, lastSavedAt } = useAutoSaveDraft({
    accountId: sendingAccountId || accountId || '',
    threadId,
    mode,
    parentEmailId: lastEmailId,
    existingDraftId,
    enabled: !editingScheduledId,
  });
  const sendDraftMutation = useSendDraft();
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Trigger auto-save on editor content changes
  useEffect(() => {
    if (!editor) return;
    const handler = () => triggerAutoSave();
    editor.on('update', handler);
    return () => { editor.off('update', handler); };
  }, [editor, triggerAutoSave]);

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

  const uploadAttachments = async (files: File[]) => {
    return Promise.all(
      files.map(async (file) => {
        const uploadUrl = await generateUploadUrl();
        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!response.ok) throw new Error(`Failed to upload ${file.name}`);
        const { storageId } = (await response.json()) as { storageId: string };
        return {
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          storageId: storageId as Id<'_storage'>,
        };
      }),
    );
  };

  const submitAiLearn = async () => {
    if (aiOriginalRef.current && aiOriginalRef.current.body !== body) {
      const contactEmail = to.trim().split(',')[0]?.trim();
      try {
        await learnFromEdit({
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

  const handleSend = async () => {
    if (!body.trim()) return;

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

    setSending(true);
    try {
      await submitAiLearn();
      const selectedSig = selectedSignatureId ? signatures?.find((s) => s.id === selectedSignatureId) : null;
      const messageHtml = editor?.getHTML() || '';
      const bodyHtml = selectedSig
        ? `${messageHtml}<div class="email-signature" style="margin-top:16px">${selectedSig.bodyHtml}</div>`
        : messageHtml;

      // If a schedule date is set, schedule instead of sending
      if (scheduledAt) {
        const toAddresses = mode === 'reply'
          ? []
          : to.split(',').map((e) => ({ email: e.trim() }));

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
        });

        queryClient.invalidateQueries({ queryKey: ['scheduled-emails'] });
        onClose();
        return;
      }

      let res: { data: any };
      const activeAccountId = sendingAccountId || accountId;

      // If we have a saved draft, send via draft endpoint
      if (draftId) {
        // Save latest content to draft first
        const latestHtml = selectedSig
          ? `${messageHtml}<div class="email-signature" style="margin-top:16px">${selectedSig.bodyHtml}</div>`
          : messageHtml;
        await saveDraftFn({
          subject: subject || '(no subject)',
          bodyHtml: latestHtml,
          bodyText: body,
          toAddresses: mode === 'reply'
            ? recipients.map((r) => ({ email: r.email, name: r.name }))
            : to.split(',').map((e) => ({ email: e.trim() })),
        });
        res = await sendDraftMutation.mutateAsync({
          draftId,
          undoWindowSeconds: UNDO_WINDOW_SECONDS,
        });
        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
        registerUndo(res);
        queryClient.invalidateQueries({ queryKey: ['threads'] });
        if (threadId) queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
        onClose();
        return;
      }

      const uploadedAttachments = attachments.length > 0 ? await uploadAttachments(attachments) : undefined;

      if (mode === 'reply' && lastEmailId && activeAccountId) {
        res = await replyEmail({
          parentEmailId: lastEmailId as Id<'emails'>,
          accountId: activeAccountId as Id<'mailAccounts'>,
          to: recipients.length > 0 ? recipients.map((r) => ({ email: r.email, name: r.name })) : undefined,
          bodyHtml,
          bodyText: body,
          cc: ccArray.length > 0 ? ccArray : undefined,
          bcc: bccArray.length > 0 ? bccArray : undefined,
          attachments: uploadedAttachments,
        });

        if (threadId) {
          queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
          queryClient.invalidateQueries({ queryKey: ['threads'] });
        }
      } else if (mode === 'forward' && lastEmailId && activeAccountId) {
        res = await forwardEmail({
          sourceEmailId: lastEmailId as Id<'emails'>,
          accountId: activeAccountId as Id<'mailAccounts'>,
          to: to.split(',').map((e) => ({ email: e.trim() })),
          bodyHtml,
          bodyText: body,
          attachments: uploadedAttachments,
        });
      } else if (mode === 'compose' && activeAccountId) {
        res = await sendEmail({
          accountId: activeAccountId as Id<'mailAccounts'>,
          to: to.split(',').map((e) => ({ email: e.trim() })),
          cc: ccArray.length > 0 ? ccArray : undefined,
          bcc: bccArray.length > 0 ? bccArray : undefined,
          subject,
          bodyHtml,
          bodyText: body,
          attachments: uploadedAttachments,
        });
      } else {
        onClose();
        return;
      }

      haptic.success();
      registerUndo(res!);
      onClose();
    } catch (err: any) {
      console.error('Send failed:', err);
      haptic.error();
      toast.error(err?.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  const handleSaveScheduled = async () => {
    if (!editingScheduledId || !body.trim()) return;
    setSending(true);
    try {
      const bodyHtml = editor?.getHTML() || '';
      const updates: Record<string, any> = {
        bodyHtml,
        bodyText: body,
        subject: subject || '(no subject)',
      };
      if (mode !== 'reply') {
        updates.to = to.split(',').map((e) => ({ email: e.trim() }));
      }
      await updateScheduledEmail({
        id: editingScheduledId as Id<'scheduledEmails'>,
        subject: updates.subject,
        bodyHtml: updates.bodyHtml,
        bodyText: updates.bodyText,
        to: updates.to,
      });
      queryClient.invalidateQueries({ queryKey: ['scheduled-emails'] });
      if (threadId) {
        queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      }
      setEditingScheduledId(null);
      onClose();
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSending(false);
    }
  };

  const handleSendScheduledNow = async () => {
    if (!editingScheduledId) return;
    setSending(true);
    try {
      // Save any edits first, then send with undo window
      const bodyHtml = editor?.getHTML() || '';
      const updates: Record<string, any> = {
        bodyHtml,
        bodyText: body,
        subject: subject || '(no subject)',
      };
      if (mode !== 'reply') {
        updates.to = to.split(',').map((e) => ({ email: e.trim() }));
      }
      await updateScheduledEmail({
        id: editingScheduledId as Id<'scheduledEmails'>,
        subject: updates.subject,
        bodyHtml: updates.bodyHtml,
        bodyText: updates.bodyText,
        to: updates.to,
        sendAt: Date.now() + 1_000,
      });
      toast.success('Scheduled to send now');

      queryClient.invalidateQueries({ queryKey: ['scheduled-emails'] });
      queryClient.invalidateQueries({ queryKey: ['threads'] });
      if (threadId) {
        queryClient.invalidateQueries({ queryKey: ['thread', threadId] });
      }
      setEditingScheduledId(null);
      onClose();
    } catch (err) {
      console.error('Send now failed:', err);
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
    <div className="border-t border-border bg-white" onKeyDown={handleKeyDown}>
      {/* Header — mode label, recipients, from account, AI + close */}
      <div className="border-b border-border px-5 py-2">
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
            <button onClick={onClose} className="rounded-lg p-1 text-text-tertiary transition-colors hover:bg-surface" aria-label="Close compose">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Reply recipients + from account */}
        {mode === 'reply' && recipients.length > 0 && (<>
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
              <input
                type="text"
                value={ccInput}
                onChange={(e) => setCcInput(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ',' || e.key === 'Tab') && ccInput.trim()) {
                    e.preventDefault();
                    const email = ccInput.trim().replace(/,$/, '');
                    if (EMAIL_REGEX.test(email)) {
                      setCcRecipients((prev) => [...prev, { email }]);
                      setCcInput('');
                    }
                  } else if (e.key === 'Backspace' && !ccInput && ccRecipients.length > 0) {
                    setCcRecipients((prev) => prev.slice(0, -1));
                  }
                }}
                onBlur={() => {
                  const email = ccInput.trim().replace(/,$/, '');
                  if (email && EMAIL_REGEX.test(email)) {
                    setCcRecipients((prev) => [...prev, { email }]);
                    setCcInput('');
                  }
                }}
                className="min-w-[120px] flex-1 text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
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
              <input
                type="text"
                value={bccInput}
                onChange={(e) => setBccInput(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ',' || e.key === 'Tab') && bccInput.trim()) {
                    e.preventDefault();
                    const email = bccInput.trim().replace(/,$/, '');
                    if (EMAIL_REGEX.test(email)) {
                      setBccRecipients((prev) => [...prev, { email }]);
                      setBccInput('');
                    }
                  } else if (e.key === 'Backspace' && !bccInput && bccRecipients.length > 0) {
                    setBccRecipients((prev) => prev.slice(0, -1));
                  }
                }}
                onBlur={() => {
                  const email = bccInput.trim().replace(/,$/, '');
                  if (email && EMAIL_REGEX.test(email)) {
                    setBccRecipients((prev) => [...prev, { email }]);
                    setBccInput('');
                  }
                }}
                className="min-w-[120px] flex-1 text-[11px] text-text-primary outline-none placeholder:text-text-tertiary"
                placeholder="Add BCC recipient..."
              />
            </div>
          )}
        </>)}
      </div>

      {/* To / Subject fields for forward/compose */}
      {(mode === 'forward' || mode === 'compose') && (
        <div className="space-y-2 border-b border-border px-5 py-2.5">
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
        className={`px-5 py-3 transition-colors ${draggingOver ? 'bg-primary/5 ring-2 ring-inset ring-primary/20 rounded' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDraggingOver(true); }}
        onDragLeave={() => setDraggingOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDraggingOver(false);
          if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
        }}
      >
        {editor ? (
          <EditorContent editor={editor} />
        ) : (
          <div className="min-h-[80px]" />
        )}
        {draggingOver && (
          <p className="mt-1 text-center text-xs text-primary">Drop files to attach</p>
        )}
      </div>

      {/* Attachment list */}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-border/50 px-5 py-2">
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
      <div className="flex items-center justify-between border-t border-border px-5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] text-text-tertiary">
            {editingScheduledId ? 'Cmd+Enter to save' : 'Cmd+Enter to send'}
          </span>
          {!editingScheduledId && (isDraftSaving ? (
            <span className="text-[10px] text-text-tertiary">Saving...</span>
          ) : lastSavedAt ? (
            <span className="text-[10px] text-text-tertiary">Draft saved</span>
          ) : null)}
          {/* Attach file button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary"
            title="Attach file"
          >
            <Paperclip className="h-3 w-3" />
            Attach
          </button>
          {/* Signature selector */}
          {signatures && signatures.length > 0 && (
            <div className="relative">
              <button
                onClick={() => setSigMenuOpen((v) => !v)}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary"
                title="Select signature"
              >
                <FileSignature className="h-3 w-3" />
                {selectedSignatureId
                  ? signatures.find((s) => s.id === selectedSignatureId)?.name ?? 'Signature'
                  : 'No signature'}
                <ChevronDown className="h-2.5 w-2.5" />
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
        <div className="flex items-center gap-1.5">
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
              {/* Schedule date indicator — clearable */}
              {scheduledAt && (
                <button
                  onClick={() => setScheduledAt(null)}
                  className="flex items-center gap-1 rounded-lg bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-600 transition-colors hover:bg-amber-100"
                  title="Clear schedule — click to send immediately instead"
                >
                  <CalendarClock className="h-3 w-3" />
                  {formatScheduleLabel(scheduledAt)}
                  <X className="ml-0.5 h-2.5 w-2.5" />
                </button>
              )}
              <ScheduleSendMenu
                onSchedule={(date) => setScheduledAt(date)}
                disabled={!body.trim() || sending}
              />
              <button
                onClick={handleSend}
                disabled={!body.trim() || sending}
                className="rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
              >
                {sending
                  ? 'Sending...'
                  : scheduledAt
                    ? `Send on ${formatScheduleLabel(scheduledAt)}`
                    : 'Send'}
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
