import { useEffect, useState, useCallback, useRef } from 'react';
import { X, Eye, Pencil, Send } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useUndoSendStore, type PendingUndoEmail } from '../../stores/undoSendStore';
import DOMPurify from 'dompurify';
import toast from 'react-hot-toast';
import { Tooltip } from '../ui/Tooltip';
import { useMutation } from 'convex/react';
import { api as convexApi } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';

function UndoPill({ email, onCancel, onExpired, onSendNow }: {
  email: PendingUndoEmail;
  onCancel: (email: PendingUndoEmail) => void;
  onExpired: (id: string) => void;
  onSendNow: (email: PendingUndoEmail) => void;
}) {
  const deadline = new Date(email.undoDeadlineAt).getTime();
  const [remaining, setRemaining] = useState(() => Math.max(0, deadline - Date.now()));
  const { viewingEmailId, editingEmailId, setViewingEmail, setEditingEmail } = useUndoSendStore();
  const isViewing = viewingEmailId === email.id;
  const isEditing = editingEmailId === email.id;

  useEffect(() => {
    const interval = setInterval(() => {
      const left = Math.max(0, deadline - Date.now());
      setRemaining(left);
      if (left <= 0) {
        clearInterval(interval);
        onExpired(email.id);
      }
    }, 100);
    return () => clearInterval(interval);
  }, [deadline, email.id, onExpired]);

  const seconds = Math.ceil(remaining / 1000);
  const totalWindow = 60;
  const progress = remaining / (totalWindow * 1000);

  const subjectLine = email.subject || '(no subject)';
  const recipients = email.to || 'unknown';

  return (
    <div className={`w-[500px] overflow-hidden border border-border bg-white shadow-xl ${isViewing || isEditing ? 'rounded-2xl' : 'rounded-full'}`}>
      <div className="flex items-center gap-3 px-4 py-2.5">
        {/* Subject + recipient */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-semibold text-text-primary">{subjectLine}</p>
          <p className="truncate text-[10px] text-text-tertiary">To: {recipients}</p>
        </div>

        {/* Icons + timer with progress bar above */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          {/* Progress bar — spans width of icons + timer */}
          <div className="h-[3px] w-full rounded-full bg-gray-100">
            <div
              className="h-full rounded-full bg-primary transition-all duration-100 ease-linear"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <div className="flex items-center gap-1">
          <Tooltip content="Edit">
            <button
              onClick={() => isEditing ? setEditingEmail(null) : setEditingEmail(email.id)}
              className={`rounded-lg p-1.5 transition-colors ${
                isEditing
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-tertiary hover:bg-surface hover:text-text-primary'
              }`}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="View">
            <button
              onClick={() => isViewing ? setViewingEmail(null) : setViewingEmail(email.id)}
              className={`rounded-lg p-1.5 transition-colors ${
                isViewing
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-tertiary hover:bg-surface hover:text-text-primary'
              }`}
            >
              <Eye className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Cancel send">
            <button
              onClick={() => onCancel(email)}
              className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-red-50 hover:text-red-500"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Send now">
            <button
              onClick={() => onSendNow(email)}
              className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-green-50 hover:text-green-600"
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </Tooltip>

          {/* Timer */}
          <div className="ml-1 flex items-baseline gap-0.5">
            <span className="tabular-nums text-[16px] font-bold text-primary">{seconds}</span>
            <span className="text-[9px] font-medium text-text-tertiary">s</span>
          </div>
          </div>
        </div>
      </div>

      {/* View panel */}
      {isViewing && (
        <div className="border-t border-border bg-surface/50 px-4 py-3">
          <div
            className="prose prose-sm max-h-[200px] max-w-none overflow-y-auto text-[12px] leading-relaxed text-text-primary"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(email.bodyHtml || email.body.replace(/\n/g, '<br/>'), {
                FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
              }),
            }}
          />
        </div>
      )}

      {/* Edit panel */}
      {isEditing && (
        <EditPanel email={email} />
      )}
    </div>
  );
}

function EditPanel({ email }: { email: PendingUndoEmail }) {
  const queryClient = useQueryClient();
  const { setEditingEmail } = useUndoSendStore();
  const [body, setBody] = useState(email.body);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const updatePending = useMutation(convexApi.emails.updatePending);

  const handleSave = async () => {
    setSaving(true);
    try {
      const bodyHtml = `<p>${body.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br/>')}</p>`;

      await updatePending({
        emailId: email.id as Id<'emails'>,
        bodyText: body,
        bodyHtml,
      });

      email.body = body;
      email.bodyHtml = bodyHtml;

      if (email.threadId) {
        queryClient.invalidateQueries({ queryKey: ['thread', email.threadId] });
      }
      toast.success('Email updated');
      setEditingEmail(null);
    } catch (err) {
      toast.error('Failed to save changes');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border-t border-border bg-surface/50 px-4 py-3">
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        className="max-h-[200px] min-h-[80px] w-full resize-none rounded-lg border border-border bg-white px-3 py-2 text-[12px] text-text-primary outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/20"
        rows={4}
      />
      <div className="mt-2 flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving || body === email.body}
          className="rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}

export function UndoSendToast() {
  const { pendingEmails, removePendingEmail } = useUndoSendStore();
  const undoMutation = useMutation(convexApi.emails.undoSend);
  const sendNowMutation = useMutation(convexApi.emails.sendNow);

  const handleCancel = useCallback(async (email: PendingUndoEmail) => {
    try {
      await undoMutation({ emailId: email.id as Id<'emails'> });
      removePendingEmail(email.id);
      toast.success('Send cancelled');
    } catch (err) {
      console.error('Cancel failed:', err);
      toast.error('Could not cancel — email may have already sent');
      removePendingEmail(email.id);
    }
  }, [removePendingEmail, undoMutation]);

  const handleExpired = useCallback((id: string) => {
    removePendingEmail(id);
  }, [removePendingEmail]);

  const handleSendNow = useCallback(async (email: PendingUndoEmail) => {
    try {
      await sendNowMutation({ emailId: email.id as Id<'emails'> });
      removePendingEmail(email.id);
    } catch {
      toast.error('Could not send — email may have already sent');
      removePendingEmail(email.id);
    }
  }, [removePendingEmail, sendNowMutation]);

  if (pendingEmails.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
      {pendingEmails.map((email) => (
        <UndoPill
          key={email.id}
          email={email}
          onCancel={handleCancel}
          onExpired={handleExpired}
          onSendNow={handleSendNow}
        />
      ))}
    </div>
  );
}
