import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef, lazy, Suspense } from 'react';
import {
  Archive,
  Reply,
  Forward,
  Star,
  Trash2,
  MessageSquare,
  ArrowLeft,
  Mail,
  Send,
  UserPlus,
  X,
  CalendarClock,
  Pencil,
  Play,
  Loader2,
  AlertTriangle,
  RotateCcw,
  CheckCircle2,
  Clock,
  FileText,
  FileSpreadsheet,
  FileImage,
  File,
  FileArchive,
  FileCode,
  Presentation,
  Download,
  ShieldBan,
  MailOpen,
  Eye,
} from 'lucide-react';
import * as Avatar from '@radix-ui/react-avatar';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import { useThread, useUpdateThread } from '../../hooks/useThreads';
import { TriageBanner } from './TriageBanner';
import { DeliveryStatus } from './DeliveryStatus';
import { TriageCategoryPill } from './TriageCategoryPill';
import { useAddComment } from '../../hooks/useComments';
import { useAccounts } from '../../hooks/useAccounts';
import { useUiStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { formatExactTime, getInitials, cn } from '../../lib/utils';
import { getAvatarColor } from '../../lib/constants';
// Lazy-loaded: the inline composer pulls TipTap (~370 KB gzipped) which we
// don't want on the critical path of opening a thread. It only renders when
// the user clicks Reply / Forward / Add note.
const ComposeInline = lazy(() =>
  import('../compose/ComposeInline').then((m) => ({ default: m.ComposeInline })),
);
import { Tooltip } from '../ui/Tooltip';
import { ContactCard } from '../contacts/ContactCard';
import { useContactAutocomplete, useContactNameResolver } from '../../hooks/useContacts';
import { useThreadScheduledEmails, useSendScheduledNow, useCancelScheduledEmail } from '../../hooks/useScheduledEmails';
import { useUndoSendStore } from '../../stores/undoSendStore';
import { useBlockSender } from '../../hooks/useBlockedSenders';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useMarkThreadNotificationsRead } from '../../hooks/useNotifications';
import { haptic } from '../../lib/haptics';
import { ImageLightbox } from './ImageLightbox';
import DOMPurify from 'dompurify';
import { useQueryClient } from '@tanstack/react-query';
import { useMutation as useConvexMutation } from 'convex/react';
import { useAuthToken } from '@convex-dev/auth/react';
import { api } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import toast from 'react-hot-toast';

// Team domain — emails from this domain get the pastel triangle
const TEAM_DOMAIN = 'orbi.agency';

function SendFailedBanner({ emailId, error, attempts }: { emailId: string; error?: string | null; attempts?: number }) {
  const queryClient = useQueryClient();
  const retrySend = useConvexMutation(api.emails.retrySend);
  const discardSend = useConvexMutation(api.emails.discardFailedSend);
  const [isRetrying, setIsRetrying] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);

  const handleRetry = async () => {
    setIsRetrying(true);
    try {
      await retrySend({ emailId: emailId as Id<'emails'> });
      toast.success('Retry queued — sending again');
      queryClient.invalidateQueries({ queryKey: ['thread'] });
    } catch (err) {
      console.error('Retry send failed:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to queue retry');
    } finally {
      setIsRetrying(false);
    }
  };

  const handleDiscard = async () => {
    if (!window.confirm('Discard this failed message? It will be removed from the thread.')) return;
    setIsDiscarding(true);
    try {
      await discardSend({ emailId: emailId as Id<'emails'> });
      toast.success('Discarded');
      queryClient.invalidateQueries({ queryKey: ['thread'] });
    } catch (err) {
      console.error('Discard failed:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to discard');
    } finally {
      setIsDiscarding(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold text-red-700">
            Failed to send
            {attempts ? ` (${attempts} attempt${attempts > 1 ? 's' : ''})` : ''}
          </p>
          {error && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-red-600/80">
              {error}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={handleDiscard}
            disabled={isDiscarding || isRetrying}
            className="flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
            {isDiscarding ? 'Discarding...' : 'Discard'}
          </button>
          <button
            onClick={handleRetry}
            disabled={isRetrying || isDiscarding}
            className="flex items-center gap-1.5 rounded-md bg-red-100 px-2.5 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-200 disabled:opacity-50"
          >
            <RotateCcw className={cn('h-3 w-3', isRetrying && 'animate-spin')} />
            {isRetrying ? 'Retrying...' : 'Retry'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Strip all on* event handler attributes from sanitized HTML
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.attributes) {
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith('on')) {
        node.removeAttribute(attr.name);
      }
    }
  }
});

/**
 * Strip quoted/forwarded content from email HTML.
 *
 * Strategy: flatten all block-level elements into an ordered list, scan their
 * text for quote-start markers (From:/Sent:, "On … wrote:", separators), then
 * remove that element and everything after it.  This works regardless of how
 * deeply nested the Outlook/Gmail/Apple Mail markup is.
 */
function stripQuotedContent(html: string): { body: string; hasQuoted: boolean } {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // ── Phase 1: remove well-known wrapper elements ──────────────
  doc.querySelectorAll([
    '.gmail_quote', '.gmail_extra', '.gmail_attr',        // Gmail
    '#appendonsend', '#divRplyFwdMsg', '[name="divRplyFwdMsg"]', // Outlook desktop
    '.yahoo_quoted',                                      // Yahoo
    'blockquote[type="cite"]', 'blockquote.cite',         // Apple Mail
  ].join(',')).forEach((el) => el.remove());

  // ── Phase 2: scan elements for quote-start markers ─────────
  const allEls = Array.from(doc.body.querySelectorAll('*'));

  // Patterns that signal the start of a quoted/forwarded block
  const quoteStartPatterns = [
    /On\s+.{5,120}\s+wrote:\s*$/,                          // "On Mon, Jan 5... wrote:"
    /wrote:\s*$/,                                          // ends with "wrote:"
    /^-{3,}\s*(Forwarded|Original)\s*(message|Message)/i,  // "---------- Forwarded message"
    /^_{5,}/,                                              // "___________" (Outlook)
    /^Begin forwarded message/i,                           // Apple Mail
  ];

  // Outlook puts "From:" inside <b>From:</b>, so we need to check
  // full textContent — but only on small elements (< 500 chars) to
  // avoid matching a giant wrapper div that contains the whole email.
  const headerPattern = /^From:\s+.+/im;
  const sentPattern = /^Sent:\s+.+/im;

  // Only count history removal when we drop actual quoted reply markers,
  // not when sanitization shrinks the doc by an arbitrary amount.
  let removedQuoted = false;
  // Phase 1 wrappers above — count them as quoted history.
  if (doc.body.innerHTML.length < html.length - 50) {
    removedQuoted = true;
  }

  let cutEl: Element | null = null;

  for (const el of allEls) {
    const fullText = (el.textContent ?? '').trim();
    if (fullText.length < 3) continue;

    // For small elements, check if they contain "From:" + "Sent:" header block
    // This catches Outlook's <p><b>From:</b> Name<br><b>Sent:</b> Date</p>
    if (fullText.length < 500 && headerPattern.test(fullText) && sentPattern.test(fullText)) {
      cutEl = el;
      break;
    }

    // For direct text nodes, check other patterns
    const directText = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent?.trim() ?? '')
      .join(' ')
      .trim();

    if (directText.length < 3) continue;

    if (quoteStartPatterns.some((p) => p.test(directText))) {
      cutEl = el;
      break;
    }
  }

  if (cutEl) {
    // Walk up until we find a reasonable ancestor to cut from.
    // We want the highest ancestor that is NOT the body itself and still
    // "wraps" just the quoted block (heuristic: stop if we'd remove > 90%
    // of the body, which means we went too high).
    let target: Element = cutEl;
    const bodyLen = doc.body.innerHTML.length;

    while (
      target.parentElement &&
      target.parentElement !== doc.body
    ) {
      // Don't walk up if the parent contains most of the document
      if (target.parentElement.innerHTML.length > bodyLen * 0.85) break;
      target = target.parentElement;
    }

    // Remove target and all following siblings
    let next: Element | null = target;
    while (next) {
      const toRemove = next;
      next = next.nextElementSibling;
      toRemove.remove();
    }
    removedQuoted = true;
  }

  // ── Phase 3: catch-all blockquotes ──────────────────────────
  // Only count blockquotes with substantive text content as history.
  doc.querySelectorAll('blockquote').forEach((el) => {
    if ((el.textContent ?? '').trim().length > 20) removedQuoted = true;
    el.remove();
  });

  // ── Phase 4: remove <hr> that precede "From:" blocks ────────
  doc.querySelectorAll('hr').forEach((hr) => {
    const nextText = hr.nextElementSibling?.textContent?.trim() ?? '';
    if (/^(From|De|Von|Da):\s/i.test(nextText)) {
      let el: Element | null = hr;
      while (el) {
        const toRemove = el;
        el = el.nextElementSibling;
        toRemove.remove();
      }
      removedQuoted = true;
    }
  });

  const cleaned = doc.body.innerHTML;

  return { body: cleaned, hasQuoted: removedQuoted };
}

/**
 * Strip quoted content from plain text emails.
 */
function stripQuotedText(text: string): { body: string; hasQuoted: boolean } {
  const lines = text.split('\n');
  let cutIndex = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^On\s+.{5,120}\s+wrote:\s*$/.test(line)) { cutIndex = i; break; }
    if (/wrote:\s*$/.test(line) && i > 0) { cutIndex = i; break; }
    if (/^-{2,}.*(?:Forwarded|Original)\s+(?:message|Message)/i.test(line)) { cutIndex = i; break; }
    if (/^_{5,}/.test(line)) { cutIndex = i; break; }
    if (/^Begin forwarded message/i.test(line)) { cutIndex = i; break; }
    if (/^From:\s+.+$/.test(line) && i > 0 && lines[i - 1].trim() === '') { cutIndex = i; break; }
    if (/^Sent:\s+.+$/.test(line) && i > 0) { cutIndex = i; break; }
    if (line.startsWith('>') && i + 1 < lines.length && lines[i + 1].trim().startsWith('>')) {
      cutIndex = i; break;
    }
  }

  const body = lines.slice(0, cutIndex).join('\n');
  return { body, hasQuoted: cutIndex < lines.length };
}

/**
 * Replace cid: references with data-cid-ref attributes for later resolution.
 * We can't use direct URLs because the attachment endpoint requires auth.
 */
function inlineAttachmentUrl(attachmentId: string): string {
  const base = import.meta.env.VITE_CONVEX_SITE_URL || import.meta.env.VITE_CONVEX_URL || '';
  return `${base}/api/attachments/inline/${attachmentId}`;
}

function markCidImages(html: string, emailId: string, attachments: any[]): string {
  if (!attachments?.length) return html;

  return html.replace(/src=["']cid:([^"']+)["']/gi, (match, cidRef) => {
    const normalized = cidRef.replace(/^<|>$/g, '');
    const att = attachments.find((a: any) => {
      const attCid = (a.contentId || '').replace(/^<|>$/g, '');
      return attCid === normalized;
    });
    if (att) {
      if (att.url) {
        return `src="${att.url}" referrerpolicy="no-referrer" data-cid-email="${emailId}" data-cid-attachment="${att.id}"`;
      }
      // Keep a placeholder src and mark with data attributes for legacy/provider attachments.
      return `src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-cid-email="${emailId}" data-cid-attachment="${att.id}"`;
    }
    return match;
  });
}

function isForwardedEmail(
  bodyHtml: string | null,
  bodyText: string | null,
  subject?: string | null,
): boolean {
  // A real forward has "Fwd:" / "FW:" in the subject. Without that prefix,
  // any "---- Forwarded message ----" inside the body is part of quoted
  // history (someone replying to a forwarded chain) and should NOT trigger
  // the banner.
  const subj = (subject ?? '').trim();
  if (!/^\s*(fwd?|fw|tr|wg|rv|enc):/i.test(subj)) return false;

  // Subject says forward; still require a body marker to weed out
  // mislabelled subjects.
  const text = `${bodyText || ''}\n${bodyHtml ? bodyHtml.replace(/<[^>]+>/g, ' ') : ''}`;
  return (
    /(?:^|\n)\s*-{2,}\s*(forwarded|original)\s+message\b/i.test(text) ||
    /(?:^|\n)\s*begin forwarded message\b/i.test(text) ||
    /(?:^|\n)\s*forwarded message\s*$/im.test(text)
  );
}

/** Map MIME type / file extension to icon component and color */
function getFileTypeInfo(filename: string, mimeType: string): { icon: typeof File; color: string; bgColor: string } {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  if (mimeType === 'application/pdf' || ext === 'pdf')
    return { icon: FileText, color: 'text-red-600', bgColor: 'bg-red-50' };
  if (mimeType.includes('spreadsheet') || mimeType.includes('excel') || ['xlsx', 'xls', 'csv'].includes(ext))
    return { icon: FileSpreadsheet, color: 'text-green-600', bgColor: 'bg-green-50' };
  if (mimeType.includes('presentation') || mimeType.includes('powerpoint') || ['pptx', 'ppt'].includes(ext))
    return { icon: Presentation, color: 'text-orange-500', bgColor: 'bg-orange-50' };
  if (mimeType.includes('word') || mimeType.includes('document') || ['docx', 'doc'].includes(ext))
    return { icon: FileText, color: 'text-blue-600', bgColor: 'bg-blue-50' };
  if (mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext))
    return { icon: FileImage, color: 'text-purple-500', bgColor: 'bg-purple-50' };
  if (mimeType.includes('zip') || mimeType.includes('archive') || ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext))
    return { icon: FileArchive, color: 'text-yellow-600', bgColor: 'bg-yellow-50' };
  if (mimeType.includes('calendar') || ext === 'ics')
    return { icon: CalendarClock, color: 'text-blue-500', bgColor: 'bg-blue-50' };
  if (['js', 'ts', 'py', 'rb', 'java', 'cpp', 'c', 'h', 'css', 'html', 'json', 'xml'].includes(ext))
    return { icon: FileCode, color: 'text-gray-600', bgColor: 'bg-gray-50' };
  return { icon: File, color: 'text-gray-500', bgColor: 'bg-gray-100' };
}

/** Format file size with appropriate unit */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Download an attachment via authenticated fetch */
function downloadAttachment(emailId: string, attachmentId: string, filename: string) {
  const stored = localStorage.getItem('orbi-auth');
  const token = stored ? JSON.parse(stored)?.state?.token : null;
  fetch(`/api/emails/${emailId}/attachments/${attachmentId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
    .then((res) => {
      if (!res.ok) throw new Error('Download failed');
      return res.blob();
    })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    })
    .catch(() => {
      // silent fail — could add toast here later
    });
}

/** Check if a file type supports inline preview */
function isPreviewable(mimeType: string, filename: string): boolean {
  if (mimeType.startsWith('image/')) return true;
  if (mimeType === 'application/pdf') return true;
  if (mimeType.startsWith('text/')) return true;
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'txt', 'csv', 'json', 'xml', 'html', 'md'].includes(ext);
}

/** Fetch attachment as blob URL for preview */
async function fetchAttachmentBlob(emailId: string, attachmentId: string): Promise<string> {
  const stored = localStorage.getItem('orbi-auth');
  const token = stored ? JSON.parse(stored)?.state?.token : null;
  const res = await fetch(`/api/emails/${emailId}/attachments/${attachmentId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error('Preview failed');
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/** Lightweight attachment preview overlay */
function AttachmentPreview({ emailId, attachment, onClose }: {
  emailId: string;
  attachment: { id: string; filename: string; mimeType: string; size: number };
  onClose: () => void;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const stored = localStorage.getItem('orbi-auth');
    const token = stored ? JSON.parse(stored)?.state?.token : null;

    fetch(`/api/emails/${emailId}/attachments/${attachment.id}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((res) => {
        if (!res.ok) throw new Error('Preview failed');
        // For text files, read as text
        if (attachment.mimeType.startsWith('text/') || ['json', 'xml', 'csv', 'md', 'txt'].includes(attachment.filename.split('.').pop()?.toLowerCase() ?? '')) {
          return res.text().then((text) => {
            if (!cancelled) setTextContent(text);
          });
        }
        return res.blob().then((blob) => {
          if (!cancelled) setBlobUrl(URL.createObjectURL(blob));
        });
      })
      .catch(() => { if (!cancelled) setError(true); });

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [emailId, attachment.id]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const isImage = attachment.mimeType.startsWith('image/');
  const isPdf = attachment.mimeType === 'application/pdf' || attachment.filename.endsWith('.pdf');

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative max-h-[85vh] max-w-[85vw] min-w-[320px] overflow-hidden rounded-xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-text-primary">{attachment.filename}</p>
            <p className="text-[11px] text-text-tertiary">{formatFileSize(attachment.size)}</p>
          </div>
          <div className="flex items-center gap-1.5 ml-3">
            <button
              onClick={() => downloadAttachment(emailId, attachment.id, attachment.filename)}
              className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
              title="Download"
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex items-center justify-center overflow-auto p-4" style={{ maxHeight: 'calc(85vh - 52px)' }}>
          {error ? (
            <p className="text-sm text-text-tertiary">Unable to load preview</p>
          ) : textContent !== null ? (
            <pre className="max-h-[70vh] w-full overflow-auto rounded-lg bg-surface p-4 text-xs text-text-primary font-mono whitespace-pre-wrap">{textContent}</pre>
          ) : !blobUrl ? (
            <Loader2 className="h-6 w-6 animate-spin text-text-tertiary" />
          ) : isImage ? (
            <img src={blobUrl} alt={attachment.filename} className="max-h-[70vh] max-w-full rounded object-contain" />
          ) : isPdf ? (
            <iframe src={blobUrl} className="h-[70vh] w-[70vw] rounded border-0" title={attachment.filename} />
          ) : (
            <p className="text-sm text-text-tertiary">Preview not available for this file type</p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Renders email body inside an isolated <iframe srcdoc> (Spark/Gmail-style).
 *
 * Why an iframe:
 * - CSS isolation: the app's Tailwind preflight cannot bleed into the email,
 *   and the email's CSS cannot leak into the app.
 * - Layout fidelity: marketing emails are built for an isolated viewport with
 *   their own <style> rules targeting body/*. Inline rendering breaks these.
 * - Security: sandbox blocks scripts/forms/cookies even if sanitization misses.
 *
 * How sizing works:
 * - The iframe's srcdoc includes a tiny bootstrap script that posts its full
 *   content height to the parent via `postMessage` whenever it changes
 *   (ResizeObserver + image-load events).
 * - The parent listens for that message (keyed by a per-frame nonce) and grows
 *   the iframe to fit so the page scrolls naturally as one document.
 *
 * Link clicks and image clicks are forwarded the same way.
 */
function CollapsedEmailBody({
  bodyHtml,
  bodyText,
  subject,
  preBodyHtmlClean,
  preBodyHtmlTrimmed,
  preHasQuotedHistory,
  preIsForwarded,
  highlightText,
  emailId,
  attachments,
  authToken,
  onImageClick,
  onImageDownload,
}: {
  bodyHtml: string | null;
  bodyText: string | null;
  subject: string | null;
  // Server-side pre-processed strings. When non-null we skip client work.
  preBodyHtmlClean: string | null;
  preBodyHtmlTrimmed: string | null;
  preHasQuotedHistory: boolean | null;
  preIsForwarded: boolean | null;
  highlightText: string | null;
  emailId: string;
  attachments: any[];
  authToken: string | null;
  onImageClick?: (src: string, alt?: string) => void;
  onImageDownload?: (src: string, alt?: string) => void;
}) {
  const [showQuoted, setShowQuoted] = useState(false);
  const hasServerPreprocess = !!preBodyHtmlClean;

  const { trimmedHtml, trimmedText, hasQuoted, isForwarded } = useMemo(() => {
    // Fast path: server already did the work.
    if (hasServerPreprocess) {
      // The server-side flag was historically computed from the body only,
      // which mislabels reply chains that quote a forwarded message. Gate
      // it on the subject prefix here so legacy rows display correctly.
      const subj = (subject ?? '').trim();
      const subjectLooksForward = /^\s*(fwd?|fw|tr|wg|rv|enc):/i.test(subj);
      return {
        trimmedHtml: preBodyHtmlTrimmed ?? preBodyHtmlClean ?? null,
        trimmedText: null,
        hasQuoted: !!preHasQuotedHistory,
        isForwarded: !!preIsForwarded && subjectLooksForward,
      };
    }
    const forwarded = isForwardedEmail(bodyHtml, bodyText, subject);
    if (bodyHtml) {
      const result = stripQuotedContent(bodyHtml);
      return { trimmedHtml: result.body, trimmedText: null, hasQuoted: result.hasQuoted, isForwarded: forwarded };
    }
    if (bodyText) {
      const result = stripQuotedText(bodyText);
      return { trimmedHtml: null, trimmedText: result.body, hasQuoted: result.hasQuoted, isForwarded: forwarded };
    }
    return { trimmedHtml: null, trimmedText: null, hasQuoted: false, isForwarded: false };
  }, [
    bodyHtml,
    bodyText,
    hasServerPreprocess,
    preBodyHtmlClean,
    preBodyHtmlTrimmed,
    preHasQuotedHistory,
    preIsForwarded,
    subject,
  ]);

  // When showing history we always need the full HTML. Use the pre-cleaned
  // version if we have it; otherwise the raw bodyHtml.
  const displayHtml = showQuoted
    ? hasServerPreprocess
      ? preBodyHtmlClean
      : bodyHtml
    : trimmedHtml;
  const displayText = showQuoted ? bodyText : trimmedText;

  const sanitizedHtml = useMemo(() => {
    if (!displayHtml) return null;
    // Resolve CID images (cheap string replace) regardless of source.
    let resolved = markCidImages(displayHtml, emailId, attachments);
    // Skip the (expensive) DOMPurify pass when we trust the server output.
    if (!hasServerPreprocess) {
      resolved = DOMPurify.sanitize(resolved, {
        FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'button'],
        ADD_TAGS: ['style', 'img'],
        ADD_ATTR: ['src', 'alt', 'width', 'height', 'border', 'align', 'valign', 'bgcolor', 'background', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'data-cid-email', 'data-cid-attachment', 'referrerpolicy'],
        ADD_DATA_URI_TAGS: ['img'],
      });
      resolved = resolved.replace(/<img /gi, '<img referrerpolicy="no-referrer" ');
    }
    if (highlightText) {
      resolved = injectHighlight(resolved, highlightText);
    }
    return resolved;
  }, [displayHtml, highlightText, emailId, attachments, hasServerPreprocess]);

  return (
    <div className="email-body-card">
      {isForwarded && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
          <span className="font-medium">Forwarded to you</span>
          {hasQuoted && (
            <button
              onClick={() => setShowQuoted(!showQuoted)}
              className="rounded-md bg-white/70 px-2 py-1 text-[11px] font-semibold text-amber-800 shadow-sm transition-colors hover:bg-white"
            >
              {showQuoted ? 'Hide history' : 'View history'}
            </button>
          )}
        </div>
      )}
      {sanitizedHtml ? (
        <EmailBodyIframe
          key={`${emailId}-${showQuoted ? 'history' : 'trimmed'}-${sanitizedHtml.length}`}
          html={sanitizedHtml}
          emailId={emailId}
          authToken={authToken}
          attachments={attachments}
          onImageClick={onImageClick}
          onImageDownload={onImageDownload}
        />
      ) : displayText ? (
        <pre
          className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-text-primary"
          dangerouslySetInnerHTML={{
            __html: highlightText
              ? injectHighlight(
                  displayText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
                  highlightText,
                )
              : displayText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
          }}
        />
      ) : null}
      {hasQuoted && !isForwarded && (
        <button
          onClick={() => setShowQuoted(!showQuoted)}
          className="mt-3 rounded-md border border-border bg-white px-2.5 py-1 text-[11px] font-medium text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary"
        >
          {showQuoted ? 'Hide history' : 'View history'}
        </button>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Iframe-based renderer (Spark / Gmail / Outlook parity)
// ----------------------------------------------------------------------------

/** Minimal reset injected into every email iframe.
 *  Mirrors what big mail clients do: clear UA margins, sensible defaults for
 *  links/images/tables, no Tailwind preflight to fight. */
const EMAIL_IFRAME_BASE_CSS = `
/* Minimal reset plus newsletter scaling. Marketing emails often ship a fixed
   600px table canvas. We preserve that canvas, then scale it down inside the
   iframe when the reading pane is narrower. */
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
  color: #1a1a1a;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
/* Many marketing emails ship inline <style> with rules like
   "html, body { height: 100% }" which, inside our 60px-seed iframe,
   collapse the body to viewport size and trap scrollHeight at 60px.
   Force auto height so our measurement wrapper can grow freely. */
html, body { height: auto !important; min-height: 0 !important; max-height: none !important; overflow: visible !important; }
body { padding: 0 2px; max-width: 100%; overflow-x: hidden !important; }
img, video, canvas, svg { border: 0; max-width: 100%; height: auto; }
a { color: #1a73e8; text-decoration: underline; overflow-wrap: anywhere; word-break: break-word; }
pre { white-space: pre-wrap; }
table { border-collapse: collapse; }
/* Wrapper we always measure from — author CSS can't shrink it. The bootstrap
   may apply transform: scale(...) here for fixed-width newsletters. */
#orbi-email-root { display: block; height: auto !important; min-height: 0; transform-origin: top left; }
`;

/* Override CSS appended AFTER the email body so any inline <style> blocks
   the author shipped lose the cascade. Same set of height rules. */
const EMAIL_IFRAME_OVERRIDE_CSS = `
html, body { height: auto !important; min-height: 0 !important; max-height: none !important; overflow-y: visible !important; overflow-x: hidden !important; }
#orbi-email-root { display: block !important; height: auto !important; min-height: 0 !important; transform-origin: top left !important; }
img, video, canvas, svg { max-width: 100%; height: auto; }
a, pre { overflow-wrap: anywhere; word-break: break-word; }
.orbi-image-hover-target { cursor: zoom-in !important; }
.orbi-image-toolbar {
  position: fixed;
  z-index: 2147483647;
  display: flex;
  gap: 5px;
  opacity: 0;
  pointer-events: none;
  transform: translateY(-4px);
  transition: opacity 120ms ease, transform 120ms ease;
}
.orbi-image-toolbar[data-visible="true"] { opacity: 1; pointer-events: auto; transform: translateY(0); }
.orbi-image-toolbar button {
  appearance: none;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 999px;
  cursor: pointer;
  transition: transform 120ms ease, filter 120ms ease;
}
.orbi-image-toolbar button:hover { transform: translateY(-1px); filter: saturate(1.08); }
.orbi-image-toolbar button[data-action="view"] { background: #f97316; color: #ffffff; }
.orbi-image-toolbar button[data-action="download"] { background: #f97316; color: #ffffff; }
.orbi-image-toolbar button svg { width: 14px; height: 14px; stroke: currentColor; stroke-width: 2.5; fill: none; }
`;

function EmailBodyIframe({
  html,
  emailId,
  authToken,
  attachments,
  onImageClick,
  onImageDownload,
}: {
  html: string;
  emailId: string;
  authToken: string | null;
  attachments: any[];
  onImageClick?: (src: string, alt?: string) => void;
  onImageDownload?: (src: string, alt?: string) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  // Unique nonce per render so stale messages from a previous srcdoc are ignored.
  const nonce = useMemo(
    () => `${emailId}-${Math.random().toString(36).slice(2, 10)}`,
    [emailId, html],
  );
  // When the rendered HTML changes (e.g. user toggled "View / Hide history"),
  // shrink the iframe back to a tiny seed so we don't keep the previous
  // taller measurement; the new content's `postMessage('height')` will then
  // grow it to the right size.
  useEffect(() => {
    setHeight(60);
  }, [nonce]);

  // Resolve cid: attachments inside the iframe by fetching with auth and
  // swapping in a blob URL. Done from the parent so we keep auth out of the
  // sandbox.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let cancelled = false;
    const blobUrls: string[] = [];

    const resolveCids = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const cidImgs = doc.querySelectorAll('img[data-cid-attachment]:not([data-cid-resolved])');
      cidImgs.forEach((img) => {
        const attId = img.getAttribute('data-cid-attachment');
        if (!attId) return;
        img.setAttribute('data-cid-resolved', 'loading');
        fetch(inlineAttachmentUrl(attId), {
          credentials: 'include',
          headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        })
          .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(`cid ${res.status}`))))
          .then((blob) => {
            if (cancelled) return;
            const url = URL.createObjectURL(blob);
            blobUrls.push(url);
            const image = img as HTMLImageElement;
            image.style.display = '';
            image.src = url;
            img.setAttribute('data-cid-resolved', 'true');
          })
          .catch((err) => {
            img.removeAttribute('data-cid-resolved');
            console.warn('[email-viewer] inline image failed to load', attId, err);
          });
      });
      // Hide broken non-CID images so they don't reserve large empty boxes.
      doc.querySelectorAll('img').forEach((img) => {
        if (img.hasAttribute('data-cid-attachment')) return;
        img.addEventListener('error', () => {
          (img as HTMLImageElement).style.display = 'none';
        });
      });
    };

    const scheduleResolveCids = () => {
      resolveCids();
      requestAnimationFrame(resolveCids);
      setTimeout(resolveCids, 100);
      setTimeout(resolveCids, 500);
      setTimeout(resolveCids, 1500);
    };

    // contentDocument can initially be a completed about:blank document before
    // srcDoc is parsed. Always listen for iframe load and also retry shortly
    // after mount so CID placeholders added by srcDoc are not missed.
    iframe.addEventListener('load', scheduleResolveCids);
    scheduleResolveCids();

    return () => {
      cancelled = true;
      iframe.removeEventListener('load', scheduleResolveCids);
      blobUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [authToken, nonce, attachments]);

  // Listen for height / link / image messages from the iframe.
  useEffect(() => {
    const onMessage = async (e: MessageEvent) => {
      const data = e.data;
      if (!data || typeof data !== 'object' || data.nonce !== nonce) return;
      if (data.type === 'height') {
        const next = Number(data.height);
        if (Number.isFinite(next) && next > 0) setHeight(Math.ceil(next));
        return;
      }
      if (data.type === 'link' && typeof data.href === 'string') {
        const href = data.href;
        if (href.startsWith('mailto:') || href.startsWith('tel:')) {
          window.location.href = href;
          return;
        }
        try {
          const { isNative } = await import('../../lib/platform');
          if (isNative()) {
            const { Browser } = await import('@capacitor/browser');
            Browser.open({ url: href });
          } else {
            window.open(href, '_blank', 'noopener');
          }
        } catch {
          window.open(href, '_blank', 'noopener');
        }
        return;
      }
      if (data.type === 'image' && typeof data.src === 'string' && onImageClick) {
        onImageClick(data.src, data.alt);
      }
      if (data.type === 'image-download' && typeof data.src === 'string' && onImageDownload) {
        onImageDownload(data.src, data.alt);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [nonce, onImageClick, onImageDownload]);

  // Bootstrap script lives inside the iframe. Reports its own size and forwards
  // link/image clicks. The parent also gets same-origin access so it can fetch
  // authenticated CID attachments and swap them to blob URLs.
  // Bootstrap intentionally avoids rewriting author tables. For fixed-width
  // newsletters it scales the measurement wrapper, preserving layout while
  // fitting the current pane width.
  const bootstrap = `
<script>
(function () {
  var NONCE = ${JSON.stringify(nonce)};
  function post(payload) {
    try { parent.postMessage(Object.assign({ nonce: NONCE }, payload), '*'); } catch (e) {}
  }
  function measure() {
    var root = document.getElementById('orbi-email-root');
    // Preserve fixed-width newsletter layouts (typically 600px tables) and
    // scale the whole canvas down when the pane is narrower. This avoids both
    // horizontal cutoff and broken table styling.
    var rootHeight = 0;
    if (root) {
      root.style.transform = 'none';
      root.style.width = '';
      var nodes = root.querySelectorAll('*');
      var naturalWidth = Math.max(root.scrollWidth, root.offsetWidth, document.documentElement.clientWidth || 0);
      for (var i = 0; i < nodes.length; i++) {
        var wr = nodes[i].getBoundingClientRect();
        if (wr.right > naturalWidth) naturalWidth = Math.ceil(wr.right);
      }
      var viewportWidth = Math.max(1, document.documentElement.clientWidth || window.innerWidth || naturalWidth);
      var scale = naturalWidth > viewportWidth ? Math.max(0.5, viewportWidth / naturalWidth) : 1;
      root.style.transformOrigin = 'top left';
      root.style.transform = scale < 1 ? 'scale(' + scale + ')' : 'none';
      root.style.width = scale < 1 ? (100 / scale) + '%' : '';

      var rect = root.getBoundingClientRect();
      rootHeight = Math.max(Math.ceil(rect.bottom), Math.ceil(root.scrollHeight * scale), Math.ceil(root.offsetHeight * scale));
      // Walk descendants after scaling to catch absolutely-positioned children.
      for (var j = 0; j < nodes.length; j++) {
        var r = nodes[j].getBoundingClientRect();
        if (r.bottom > rootHeight) rootHeight = Math.ceil(r.bottom);
      }
    }
    // If our wrapper exists, trust it. documentElement/body scrollHeight can
    // report the iframe viewport height, which is stale when collapsing from
    // full history back to the trimmed body.
    if (root) return rootHeight;
    return Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0,
      document.documentElement.offsetHeight,
      document.body ? document.body.offsetHeight : 0
    );
  }
  function send() { post({ type: 'height', height: measure() }); }
  var ro = ('ResizeObserver' in window) ? new ResizeObserver(send) : null;
  var root = document.getElementById('orbi-email-root');
  if (ro && root) ro.observe(root);
  if (ro && document.documentElement) ro.observe(document.documentElement);
  window.addEventListener('resize', send);
  window.addEventListener('load', function () {
    send();
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      imgs[i].addEventListener('load', send);
      imgs[i].addEventListener('error', send);
    }
    setTimeout(send, 300);
    setTimeout(send, 1500);
  });
  // First measure as soon as DOM is parsed, even before <img> load.
  function installImageToolbar() {
    var toolbar = document.createElement('div');
    toolbar.className = 'orbi-image-toolbar';
    toolbar.setAttribute('aria-hidden', 'true');
    toolbar.innerHTML = '<button type="button" data-action="view" aria-label="View fullscreen" title="View fullscreen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5"/><path d="M9 9 3.5 3.5M15 9l5.5-5.5M9 15l-5.5 5.5M15 15l5.5 5.5"/></svg></button><button type="button" data-action="download" aria-label="Download image" title="Download image"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg></button>';
    document.body.appendChild(toolbar);
    var activeImg = null;
    var hideTimer = null;
    function clearHide() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
    function hideSoon() {
      clearHide();
      hideTimer = setTimeout(function () {
        toolbar.setAttribute('data-visible', 'false');
        activeImg = null;
      }, 220);
    }
    function showFor(img) {
      if (!img || !img.src) return;
      activeImg = img;
      img.classList.add('orbi-image-hover-target');
      var r = img.getBoundingClientRect();
      var toolbarWidth = 61;
      toolbar.style.left = Math.max(10, Math.min(r.right - toolbarWidth - 10, window.innerWidth - toolbarWidth - 10)) + 'px';
      toolbar.style.top = Math.max(10, r.top + 10) + 'px';
      toolbar.setAttribute('data-visible', 'true');
      clearHide();
    }
    document.addEventListener('mouseover', function (e) {
      var img = e.target && e.target.closest ? e.target.closest('img') : null;
      if (img && img.src && img.naturalWidth > 24 && img.naturalHeight > 24) showFor(img);
    });
    document.addEventListener('mouseout', function (e) {
      var img = e.target && e.target.closest ? e.target.closest('img') : null;
      if (img && !toolbar.contains(e.relatedTarget)) hideSoon();
    });
    toolbar.addEventListener('mouseenter', clearHide);
    toolbar.addEventListener('mouseleave', hideSoon);
    toolbar.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!activeImg || !activeImg.src) return;
      var action = e.target && e.target.getAttribute ? e.target.getAttribute('data-action') : '';
      var payload = { src: activeImg.src, alt: activeImg.getAttribute('alt') || '' };
      if (action === 'download') post(Object.assign({ type: 'image-download' }, payload));
      else post(Object.assign({ type: 'image' }, payload));
    });
    window.addEventListener('scroll', function () { if (activeImg) showFor(activeImg); }, true);
    window.addEventListener('resize', function () { if (activeImg) showFor(activeImg); });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { send(); installImageToolbar(); });
  } else {
    send();
    installImageToolbar();
  }
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a && a.href) {
      var href = a.getAttribute('href') || '';
      if (href && href.charAt(0) !== '#') {
        e.preventDefault();
        post({ type: 'link', href: a.href });
      }
      return;
    }
    var img = e.target && e.target.closest ? e.target.closest('img') : null;
    if (img && img.src) {
      post({ type: 'image', src: img.src, alt: img.getAttribute('alt') || '' });
    }
  });
})();
</script>`;

  // Wrap the author's HTML in a measurement div, and append the override
  // <style> AFTER the content so any inline author CSS rules for
  // html/body/height lose the cascade.
  const srcDoc = `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${EMAIL_IFRAME_BASE_CSS}</style></head><body><div id="orbi-email-root">${html}</div><style>${EMAIL_IFRAME_OVERRIDE_CSS}</style>${bootstrap}</body></html>`;

  return (
    <iframe
      ref={iframeRef}
      title="email"
      // allow-same-origin lets the parent resolve CID/inline attachments with
      // auth headers and swap them to blob URLs. Email HTML is sanitized before
      // reaching srcDoc; sandbox still blocks forms/top-nav and isolates popups.
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      style={{ width: '100%', maxWidth: '100%', minWidth: 0, border: 0, height, display: 'block', overflow: 'hidden' }}
    />
  );
}


type TimelineItem =
  | { type: 'email'; timestamp: string; data: any }
  | { type: 'comment'; timestamp: string; data: any }
  | { type: 'scheduled'; timestamp: string; data: any };

interface EmailViewerProps {
  onBack?: () => void;
}

// Determine left border accent color: you → brand orange, team → pastel, external → none
function getSenderAccent(fromAddress: string, currentUserEmail: string | undefined): string | null {
  if (!currentUserEmail) return null;
  if (fromAddress === currentUserEmail) return '#FF7E16';
  const senderDomain = fromAddress.split('@')[1];
  if (senderDomain === TEAM_DOMAIN) return '#FFC494';
  return null;
}

function asAddressArray(value: unknown): Array<{ email?: string; name?: string }> {
  if (Array.isArray(value)) return value as Array<{ email?: string; name?: string }>;
  if (!value) return [];
  if (typeof value === 'string') return value ? [{ email: value }] : [];
  if (typeof value === 'object') return [value as { email?: string; name?: string }];
  return [];
}

function addressListLabel(value: unknown): string {
  return asAddressArray(value)
    .map((a) => a.name || a.email)
    .filter(Boolean)
    .join(', ');
}

function addressListEmails(value: unknown): string {
  return asAddressArray(value)
    .map((a) => a.email)
    .filter(Boolean)
    .join(', ');
}

function compactAddressLabel(addr: { email?: string; name?: string }): string {
  return addr.name || addr.email || '';
}

function EmailRecipientSummary({ to, cc, bcc }: { to: unknown; cc?: unknown; bcc?: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const toList = asAddressArray(to).filter((a) => a.email || a.name);
  const ccList = asAddressArray(cc).filter((a) => a.email || a.name);
  const bccList = asAddressArray(bcc).filter((a) => a.email || a.name);
  const extraCount = ccList.length + bccList.length;
  const toLabel = toList.slice(0, 2).map(compactAddressLabel).filter(Boolean).join(', ') || 'undisclosed recipients';
  const hiddenToCount = Math.max(0, toList.length - 2);

  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setExpanded(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [expanded]);

  return (
    <span ref={wrapperRef} className="relative ml-2 inline-flex items-center gap-1 text-[11px] text-text-tertiary">
      <span>to {toLabel}</span>
      {(hiddenToCount > 0 || extraCount > 0) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
          className="rounded-full border border-border bg-surface px-1.5 py-0.5 text-[10px] font-semibold text-text-secondary transition-colors hover:border-primary/40 hover:text-primary"
        >
          +{hiddenToCount + extraCount}
        </button>
      )}
      {expanded && (
        <div className="absolute left-0 top-5 z-20 w-[min(420px,80vw)] rounded-xl border border-border bg-white p-3 text-[11px] text-text-secondary shadow-lg">
          <div className="mb-1 flex items-center justify-between border-b border-border/60 pb-2">
            <span className="font-semibold text-text-primary">Recipients</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(false);
              }}
              className="rounded-md p-1 text-text-tertiary hover:bg-surface hover:text-text-primary"
              aria-label="Close recipients"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <RecipientRow label="To" list={toList} />
          {ccList.length > 0 && <RecipientRow label="Cc" list={ccList} />}
          {bccList.length > 0 && <RecipientRow label="Bcc" list={bccList} />}
        </div>
      )}
    </span>
  );
}

function RecipientRow({ label, list }: { label: string; list: Array<{ email?: string; name?: string }> }) {
  return (
    <div className="grid grid-cols-[34px_1fr] gap-2 py-1">
      <span className="font-semibold text-text-tertiary">{label}</span>
      <span className="break-words text-text-secondary">
        {list.map((a) => a.name && a.email ? `${a.name} <${a.email}>` : compactAddressLabel(a)).join(', ')}
      </span>
    </div>
  );
}

function parseAddressString(value: string | undefined): Array<{ email: string }> {
  if (!value) return [];
  return value
    .split(/[;,]/)
    .map((email) => email.trim())
    .filter(Boolean)
    .map((email) => ({ email }));
}

// Mock team members for comment tagging
const TEAM_MEMBERS = [
  { id: '1', name: 'Sarah Chen', email: 'sarah@orbi.agency' },
  { id: '2', name: 'Mike Johnson', email: 'mike@orbi.agency' },
  { id: '3', name: 'Sophie Kim', email: 'sophie@orbi.agency' },
  { id: '4', name: 'Alex Rivera', email: 'alex@orbi.agency' },
  { id: '5', name: 'Jordan Lee', email: 'jordan@orbi.agency' },
];

/** Stop words to ignore when building keyword search */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'that', 'this', 'be', 'are',
  'was', 'were', 'been', 'has', 'have', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'can', 'shall',
  'i', 'you', 'he', 'she', 'we', 'they', 'me', 'my', 'your', 'our',
  'get', 'got', 'need', 'up', 'so', 'if', 'no', 'not', 'all', 'just',
]);

/**
 * Inject <mark data-highlight> around the best matching sentence in the HTML.
 *
 * Strategy:
 * 1. Try exact match first (case-insensitive).
 * 2. Extract keywords from the search text, find the sentence in the HTML
 *    plain-text that contains the most keyword hits, then highlight that
 *    whole sentence in the HTML.
 */
function injectHighlight(html: string, text: string): string {
  // 1. Try exact match directly in HTML (works when text is inside a single tag)
  const escaped = text.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexWhitespace = escaped.replace(/\s+/g, '\\s+');
  const exactRegex = new RegExp(`(${flexWhitespace})`, 'gi');
  if (exactRegex.test(html)) {
    return html.replace(exactRegex, '<mark data-highlight>$1</mark>');
  }

  // 1b. Try matching against tag-stripped text, then highlight the best
  //     single-tag-friendly portion we can find in the raw HTML.
  const plainForMatch = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const plainMatch = plainForMatch.match(exactRegex);
  if (plainMatch && plainMatch[0]) {
    const matchedWords = plainMatch[0].split(/\s+/).filter(Boolean);
    const minLen = Math.min(3, matchedWords.length);

    // Try substrings from the start (longest → shortest)
    for (let len = matchedWords.length; len >= minLen; len--) {
      const sub = matchedWords.slice(0, len).join(' ');
      const subEsc = sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const subRegex = new RegExp(`(${subEsc})`, 'i');
      if (subRegex.test(html)) {
        return html.replace(subRegex, '<mark data-highlight>$1</mark>');
      }
    }
    // Try substrings from the end (longest → shortest)
    for (let len = matchedWords.length; len >= minLen; len--) {
      const sub = matchedWords.slice(matchedWords.length - len).join(' ');
      const subEsc = sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const subRegex = new RegExp(`(${subEsc})`, 'i');
      if (subRegex.test(html)) {
        return html.replace(subRegex, '<mark data-highlight>$1</mark>');
      }
    }
    // Last resort: try each individual word that's 4+ chars
    for (const w of matchedWords) {
      if (w.length < 4) continue;
      const wEsc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Only match inside text nodes (not inside tags) — look for word boundaries
      const wRegex = new RegExp(`(?<=>)([^<]*?)(${wEsc})([^<]*?)(?=<)`, 'i');
      const wMatch = html.match(wRegex);
      if (wMatch) {
        return html.replace(wRegex, `>$1<mark data-highlight>$2</mark>$3<`);
      }
    }
  }

  // 2. Keyword-based sentence matching
  const keywords = text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (keywords.length === 0) return html;

  // Strip tags to get plain text, split into sentences
  const plain = html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ');
  const sentences = plain.split(/(?<=[.!?\n])\s+/).filter((s) => s.trim().length > 10);

  let bestSentence = '';
  let bestScore = 0;

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSentence = sentence.trim();
    }
  }

  // Need at least 2 keyword matches (or 1 if only 1-2 keywords exist)
  const threshold = keywords.length <= 2 ? 1 : 2;
  if (bestScore < threshold || !bestSentence) return html;

  // Find and highlight the best matching sentence in the original HTML
  // Use the first 40+ chars of the sentence to locate it in the HTML
  const snippet = bestSentence.slice(0, Math.min(bestSentence.length, 60)).trim();
  const snippetEscaped = snippet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the snippet plus the rest of the sentence (greedy up to next tag or period)
  const sentenceRegex = new RegExp(`(${snippetEscaped}[^<]*)`, 'i');
  const match = html.match(sentenceRegex);

  if (match && match[1]) {
    return html.replace(match[1], `<mark data-highlight>${match[1]}</mark>`);
  }

  // No strong match in this email — return unchanged
  return html;
}

export function EmailViewer({ onBack }: EmailViewerProps) {
  const { selectedThreadId, setSelectedThread, pendingDraft, setPendingDraft, highlightText, setHighlightText, scrollToScheduled, setScrollToScheduled, editingScheduledId, setEditingScheduledId, composingNew, setComposingNew, pendingReplyMode, setPendingReplyMode } = useUiStore();
  const { user } = useAuthStore();
  const authToken = useAuthToken();
  const { data: accountsData } = useAccounts();
  const resolveName = useContactNameResolver();
  const { data, isLoading, isPlaceholderData, isError, error } = useThread(selectedThreadId);
  // Treat stale (previous thread) data as loading — avoids flashing wrong content
  const isStale = isPlaceholderData && data?.data?.id !== selectedThreadId;
  const effectiveLoading = isLoading || isStale;
  const updateThread = useUpdateThread();
  const markThreadNotificationsRead = useMarkThreadNotificationsRead();
  const addComment = useAddComment();
  const blockSender = useBlockSender();
  const scheduledEmails = useThreadScheduledEmails(selectedThreadId);
  const { addPendingEmail } = useUndoSendStore();
  const UNDO_WINDOW_SECONDS = 10;
  const sendNowMutation = useSendScheduledNow();
  const cancelScheduledMutation = useCancelScheduledEmail();
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const [replyMode, setReplyMode] = useState<'reply' | 'forward' | null>(null);
  const [newComment, setNewComment] = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [taggedMembers, setTaggedMembers] = useState<typeof TEAM_MEMBERS>([]);
  const [contactCardEmail, setContactCardEmail] = useState<string | null>(null);
  const [contactCardAnchor, setContactCardAnchor] = useState<DOMRect | null>(null);
  const contactLookup = useContactAutocomplete(contactCardEmail || '');
  const contactCardData = contactLookup.data?.data?.find((c: any) => c.email === contactCardEmail);
  const [previewAttachment, setPreviewAttachment] = useState<{ emailId: string; attachment: any } | null>(null);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt?: string } | null>(null);
  const isMobile = useIsMobile();

  const downloadInlineImage = useCallback((src: string, alt?: string) => {
    const extFromMime = src.startsWith('data:image/') ? src.slice('data:image/'.length).split(/[;,]/)[0] : '';
    const safeName = (alt || 'inline-image').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'inline-image';
    const filename = /\.(png|jpe?g|gif|webp|svg)$/i.test(safeName) ? safeName : `${safeName}.${extFromMime || 'png'}`;
    const a = document.createElement('a');
    a.href = src;
    a.download = filename;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  // Swipe-back gesture from left edge (iOS convention)
  const swipeBackRef = useRef<{ startX: number; startY: number; active: boolean; hapticFired: boolean } | null>(null);
  const viewerContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMobile || !onBack) return;
    const container = viewerContainerRef.current;
    if (!container) return;

    const EDGE_ZONE = 24; // px from left edge to activate
    const COMMIT_THRESHOLD = 0.4; // 40% of screen width

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (touch.clientX <= EDGE_ZONE && !replyMode) {
        swipeBackRef.current = { startX: touch.clientX, startY: touch.clientY, active: false, hapticFired: false };
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      const ref = swipeBackRef.current;
      if (!ref) return;
      const touch = e.touches[0];
      const dx = touch.clientX - ref.startX;
      const dy = Math.abs(touch.clientY - ref.startY);

      // If vertical movement dominates, abort
      if (!ref.active && dy > 10 && dy > Math.abs(dx)) {
        swipeBackRef.current = null;
        return;
      }

      if (dx > 10) {
        ref.active = true;
        // Apply visual offset via transform
        const progress = Math.min(dx / window.innerWidth, 1);
        container.style.transform = `translateX(${dx}px)`;
        container.style.opacity = String(1 - progress * 0.3);

        if (!ref.hapticFired && progress >= COMMIT_THRESHOLD) {
          ref.hapticFired = true;
          haptic.light();
        }
      }
    };

    const onTouchEnd = (e: TouchEvent) => {
      const ref = swipeBackRef.current;
      if (!ref || !ref.active) {
        swipeBackRef.current = null;
        return;
      }

      const touch = e.changedTouches[0];
      const dx = touch.clientX - ref.startX;
      const progress = dx / window.innerWidth;

      if (progress >= COMMIT_THRESHOLD) {
        // Commit: animate out and go back
        container.style.transition = 'transform 0.2s ease-out, opacity 0.2s ease-out';
        container.style.transform = 'translateX(100%)';
        container.style.opacity = '0';
        setTimeout(() => {
          container.style.transition = '';
          container.style.transform = '';
          container.style.opacity = '';
          onBack();
        }, 200);
      } else {
        // Snap back
        container.style.transition = 'transform 0.25s ease-out, opacity 0.25s ease-out';
        container.style.transform = '';
        container.style.opacity = '';
        setTimeout(() => { container.style.transition = ''; }, 250);
      }
      swipeBackRef.current = null;
    };

    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    container.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
      container.removeEventListener('touchend', onTouchEnd);
    };
  }, [isMobile, onBack, replyMode]);

  // Mark thread and any linked notifications as read when opened.
  useEffect(() => {
    if (!selectedThreadId || !data?.data) return;
    const thread = data.data;
    if (!thread.isRead) {
      updateThread.mutate({ id: selectedThreadId, isRead: true });
    }
    markThreadNotificationsRead(selectedThreadId).catch(console.error);
  }, [selectedThreadId, data?.data?.isRead, markThreadNotificationsRead]);

  // Open reply/forward from context menu
  useEffect(() => {
    if (pendingReplyMode && selectedThreadId && data?.data) {
      setReplyMode(pendingReplyMode);
      setPendingReplyMode(null);
    }
  }, [pendingReplyMode, selectedThreadId, data?.data]);

  // Track user scroll to avoid fighting with programmatic scrolling
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    userScrolledRef.current = false;
    const onScroll = () => { userScrolledRef.current = true; };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [selectedThreadId]);

  // Scroll to bottom for multi-email threads, top for single emails.
  // Email bodies resize after iframe/image load, so retry bottom positioning a
  // few times on open unless the user has already started scrolling.
  useLayoutEffect(() => {
    if (!selectedThreadId || !data?.data) return;
    if (data.data.id !== selectedThreadId) return;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const emailCount = data.data.emails?.length ?? 0;
    if (emailCount <= 1) {
      viewport.scrollTo({ top: 0, behavior: 'instant' });
      return;
    }

    let cancelled = false;
    const delays = [0, 80, 220, 500, 1000];
    const scrollBottom = () => {
      if (cancelled || userScrolledRef.current) return;
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' });
    };
    scrollBottom();
    const timers = delays.slice(1).map((delay) => setTimeout(scrollBottom, delay));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [selectedThreadId, data?.data?.id, data?.data?.emails?.length]);

  // Auto-scroll to highlighted text and clear after 5s
  useEffect(() => {
    if (!highlightText || !selectedThreadId) return;

    // Retry scrolling a few times — thread data may still be rendering
    let attempts = 0;
    const tryScroll = () => {
      if (userScrolledRef.current) return; // Don't fight user scroll
      const mark = scrollViewportRef.current?.querySelector('mark[data-highlight]');
      if (mark) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (attempts < 2) {
        attempts++;
        setTimeout(tryScroll, 300);
      }
    };
    const raf = requestAnimationFrame(tryScroll);

    const timer = setTimeout(() => setHighlightText(null), 6000);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [highlightText, selectedThreadId, setHighlightText]);

  // Scroll to bottom when navigating from Scheduled folder
  useEffect(() => {
    if (!scrollToScheduled || !selectedThreadId) return;
    let attempts = 0;
    const tryScroll = () => {
      const viewport = scrollViewportRef.current;
      if (viewport && viewport.scrollHeight > viewport.clientHeight) {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
        setScrollToScheduled(false);
      } else if (attempts < 10) {
        attempts++;
        setTimeout(tryScroll, 150);
      }
    };
    requestAnimationFrame(tryScroll);
  }, [scrollToScheduled, selectedThreadId, setScrollToScheduled]);

  // Auto-open compose when a pending draft arrives for this thread
  useEffect(() => {
    if (pendingDraft && selectedThreadId && pendingDraft.threadId === selectedThreadId) {
      setReplyMode('reply');
    }
  }, [pendingDraft, selectedThreadId]);

  // Auto-open compose when thread has a saved draft email
  const savedDraftEmail = data?.data?.emails?.find((e: any) => e.isDraft);
  useEffect(() => {
    if (savedDraftEmail && selectedThreadId && !replyMode && !pendingDraft) {
      setReplyMode(savedDraftEmail.inReplyTo ? 'reply' : 'compose');
    }
  }, [savedDraftEmail?.id, selectedThreadId]);

  // Listen for keyboard shortcut reply event
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.threadId === selectedThreadId) {
        setReplyMode('reply');
      }
    };
    window.addEventListener('orbi:reply', handler);
    return () => window.removeEventListener('orbi:reply', handler);
  }, [selectedThreadId]);

  // Merge emails + comments + scheduled emails into a single sorted timeline
  const timeline = useMemo(() => {
    if (!data?.data) return [];
    const items: TimelineItem[] = [];
    const emails = Array.isArray(data.data.emails) ? data.data.emails : [];
    const comments = Array.isArray(data.data.comments) ? data.data.comments : [];
    const scheduled = Array.isArray(scheduledEmails) ? scheduledEmails : [];
    for (const email of emails) {
      items.push({ type: 'email', timestamp: email.receivedAt, data: email });
    }
    for (const comment of comments) {
      items.push({ type: 'comment', timestamp: comment.createdAt, data: comment });
    }
    for (const se of scheduled) {
      items.push({ type: 'scheduled', timestamp: se.sendAt, data: se });
    }
    items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return items;
  }, [data, scheduledEmails]);

  const filteredMembers = TEAM_MEMBERS.filter(
    (m) =>
      !taggedMembers.find((t) => t.id === m.id) &&
      (m.name.toLowerCase().includes(tagSearch.toLowerCase()) ||
        m.email.toLowerCase().includes(tagSearch.toLowerCase())),
  );

  const handleCommentSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim() || !selectedThreadId) return;
    const mentions = taggedMembers.map((m) => `@${m.name}`).join(' ');
    const fullText = mentions ? `${mentions} ${newComment}` : newComment;
    const escapedText = fullText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    await addComment.mutateAsync({
      threadId: selectedThreadId,
      bodyHtml: `<p>${escapedText}</p>`,
      bodyText: fullText,
    });
    setNewComment('');
    setTaggedMembers([]);
  };

  const handleCommentKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleCommentSubmit(e);
    }
  };

  const addTag = (member: (typeof TEAM_MEMBERS)[0]) => {
    setTaggedMembers([...taggedMembers, member]);
    setShowTagMenu(false);
    setTagSearch('');
  };

  const removeTag = (id: string) => {
    setTaggedMembers(taggedMembers.filter((m) => m.id !== id));
  };

  if (!selectedThreadId) {
    if (composingNew) {
      // Use the user's default account, fall back to first synced account
      const accounts = accountsData?.data ?? [];
      const defaultAccId = useUiStore.getState().defaultAccountId;
      const defaultAccount = defaultAccId ? accounts.find((a: any) => a.id === defaultAccId) : null;
      const synced = accounts.find((a: any) => a.lastSyncAt);
      const firstAccountId = defaultAccount?.id ?? synced?.id ?? accounts[0]?.id;
      return (
        <div className="flex h-full flex-col bg-surface">
          <div className="flex h-[78px] items-center border-b border-border px-5 pt-[32px]">
            <h2 className="flex h-7 items-center text-sm font-semibold text-text-primary">New Message</h2>
          </div>
          <div className="flex-1" />
          <Suspense fallback={<div className="flex-1" />}>
            <ComposeInline
              mode="compose"
              accountId={firstAccountId}
              onClose={() => setComposingNew(false)}
            />
          </Suspense>
        </div>
      );
    }
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <div className="text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-lg bg-white shadow-sm ring-1 ring-border">
            <Mail className="h-6 w-6 text-text-tertiary" />
          </div>
          <p className="mt-4 text-[13px] font-medium text-text-primary">
            Select a thread to get started
          </p>
          <div className="mt-3 flex items-center justify-center gap-4 text-[11px] text-text-tertiary">
            <span>
              <kbd className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-border">
                J
              </kbd>{' '}
              /{' '}
              <kbd className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-border">
                K
              </kbd>{' '}
              to navigate
            </span>
            <span>
              <kbd className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-border">
                Enter
              </kbd>{' '}
              to open
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (effectiveLoading) {
    return (
      <div className="flex h-full flex-col bg-surface">
        {/* Skeleton: thread header toolbar */}
        <div className="flex h-[78px] items-center justify-between border-b border-border px-5 pt-[32px]">
          <div className="flex h-7 items-center"><div className="h-4 w-48 animate-pulse rounded bg-border/50" /></div>
          <div className="flex gap-1">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-7 w-7 animate-pulse rounded-lg bg-border/30" />
            ))}
          </div>
        </div>
        {/* Skeleton: email blocks */}
        {[1, 2].map((i) => (
          <div key={i} className="border-b border-border/60 px-5 py-4">
            <div className="mb-3 flex items-center gap-2.5">
              <div className="h-7 w-7 animate-pulse rounded-full bg-border/40" />
              <div>
                <div className="h-3.5 w-28 animate-pulse rounded bg-border/50" />
                <div className="mt-1 h-2.5 w-40 animate-pulse rounded bg-border/30" />
              </div>
            </div>
            <div className="space-y-2 pl-[38px]">
              <div className="h-3 w-full animate-pulse rounded bg-border/30" />
              <div className="h-3 w-5/6 animate-pulse rounded bg-border/30" />
              <div className="h-3 w-4/6 animate-pulse rounded bg-border/30" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const thread = data?.data;
  if (isError || !thread) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-surface">
        <AlertTriangle className="h-8 w-8 text-red-400" />
        <p className="mt-3 text-[13px] font-medium text-text-primary">
          {isError ? 'Failed to load thread' : 'Thread not found'}
        </p>
        {error instanceof Error && (
          <p className="mt-1 text-[11px] text-text-tertiary">{error.message}</p>
        )}
        <button
          onClick={() => window.location.reload()}
          className="mt-4 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-primary/90"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div ref={viewerContainerRef} className="flex h-full flex-col bg-surface">
      {/* Thread header toolbar */}
      <div className="flex h-[78px] items-center justify-between border-b border-border px-5 pt-[32px]">
        <div className="flex h-7 min-w-0 items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="rounded-lg p-1 text-text-secondary transition-colors hover:bg-surface"
              aria-label="Go back"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">
            {thread.subject}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <TriageCategoryPill
            threadId={thread.id}
            latestEmailId={thread.emails?.[thread.emails.length - 1]?.id}
          />
          <Tooltip content="Add team member">
            <button
              onClick={() => setShowTagMenu(!showTagMenu)}
              className={cn(
                'rounded-lg p-1.5 transition-colors',
                showTagMenu ? 'bg-primary/10 text-primary' : 'text-text-tertiary hover:bg-surface hover:text-text-primary',
              )}
              aria-label="Add team member"
            >
              <UserPlus className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Star">
            <button
              onClick={() =>
                updateThread.mutate({ id: thread.id, isStarred: !thread.isStarred })
              }
              className={cn(
                'rounded-lg p-1.5 transition-colors hover:bg-surface',
                thread.isStarred ? 'text-yellow-400' : 'text-text-tertiary',
              )}
              aria-label={thread.isStarred ? 'Unstar' : 'Star'}
            >
              <Star
                className="h-3.5 w-3.5"
                fill={thread.isStarred ? 'currentColor' : 'none'}
              />
            </button>
          </Tooltip>
          <Tooltip content="Mark as unread">
            <button
              onClick={() => {
                updateThread.mutate({ id: thread.id, isRead: false });
                onBack?.();
              }}
              className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
              aria-label="Mark as unread"
            >
              <MailOpen className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Archive">
            <button
              onClick={() => updateThread.mutate({ id: thread.id, isArchived: true })}
              className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
              aria-label="Archive"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Delete">
            <button
              onClick={() => updateThread.mutate({ id: thread.id, isTrashed: true })}
              className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface hover:text-unread"
              aria-label="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          {/* Share — mobile only */}
          {isMobile && (
            <Tooltip content="Share">
              <button
                onClick={async () => {
                  const { shareContent } = await import('../../lib/share');
                  const snippet = thread.emails?.[thread.emails.length - 1]?.snippet || '';
                  shareContent({
                    title: thread.subject || 'Email',
                    text: snippet.slice(0, 200),
                  });
                }}
                className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
                aria-label="Share"
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
          {/* Block sender */}
          {thread.emails?.length > 0 && (() => {
            const senderEmail = thread.emails[thread.emails.length - 1]?.fromAddress;
            if (!senderEmail) return null;
            const senderDomain = senderEmail.split('@')[1];
            return (
              <div className="relative group">
                <Tooltip content="Block sender">
                  <button
                    onClick={() => {
                      if (window.confirm(`Block all emails from ${senderEmail}?`)) {
                        blockSender.mutate(
                          { emailAddress: senderEmail, reason: `Blocked from thread: ${thread.subject}` },
                          {
                            onSuccess: () => {
                              toast.success(`Blocked ${senderEmail}`);
                              updateThread.mutate({ id: thread.id, isTrashed: true });
                            },
                          },
                        );
                      }
                    }}
                    className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-red-50 hover:text-red-500"
                    aria-label="Block sender"
                  >
                    <ShieldBan className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
              </div>
            );
          })()}
          {/* Close — right corner */}
          <Tooltip content="Close (Esc)">
            <button
              onClick={(e) => {
                (e.currentTarget as HTMLButtonElement).blur();
                setSelectedThread(null);
              }}
              className="ml-1 flex items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:border-text-tertiary hover:bg-surface-hover hover:text-text-primary focus:outline-none focus-visible:outline-none"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
              <span>Close</span>
              <kbd className="ml-1 hidden rounded border border-border bg-bg px-1 text-[10px] text-text-tertiary sm:inline">Esc</kbd>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Team member dropdown — appears below header when icon clicked */}
      {showTagMenu && (
        <div className="border-b border-border bg-surface/50 px-5 py-2.5">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={tagSearch}
              onChange={(e) => setTagSearch(e.target.value)}
              placeholder="Add team member..."
              aria-label="Search team members"
              className="min-w-0 flex-1 rounded-lg border border-border bg-white px-3 py-1.5 text-[12px] text-text-primary placeholder:text-text-tertiary focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40"
              autoFocus
            />
            <button
              onClick={() => { setShowTagMenu(false); setTagSearch(''); }}
              className="rounded-lg p-1 text-text-tertiary hover:bg-surface hover:text-text-primary"
              aria-label="Close team member menu"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* Tagged members */}
          {taggedMembers.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {taggedMembers.map((m) => (
                <span
                  key={m.id}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary"
                >
                  @{m.name}
                  <button onClick={() => removeTag(m.id)} className="hover:text-primary/70" aria-label={`Remove ${m.name}`}>
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* Member list */}
          <div className="mt-2 max-h-36 overflow-y-auto">
            {filteredMembers.map((m) => {
              const mc = getAvatarColor(m.name);
              return (
                <button
                  key={m.id}
                  onClick={() => addTag(m)}
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface"
                >
                  <div
                    className={cn(
                      'flex h-5 w-5 items-center justify-center rounded-full text-[8px] font-bold',
                      mc.bg,
                      mc.text,
                    )}
                  >
                    {getInitials(m.name)}
                  </div>
                  <div>
                    <span className="text-[12px] font-medium text-text-primary">{m.name}</span>
                    <span className="ml-1.5 text-[11px] text-text-tertiary">{m.email}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Triage suggestion banner */}
      <TriageBanner
        threadId={thread.id}
        latestEmailId={thread.emails?.[thread.emails.length - 1]?.id}
      />

      {/* Timeline: emails + comments merged */}
      <ScrollArea.Root className="min-h-0 flex-1">
        <ScrollArea.Viewport ref={scrollViewportRef} className="h-full w-full">
          <div className="bg-surface p-3">
            {timeline.map((item) => {
              if (item.type === 'email') {
                const email = item.data;
                const senderName = resolveName(email.fromAddress, email.fromName);
                const color = getAvatarColor(senderName);
                const accentColor = getSenderAccent(email.fromAddress, user?.email);

                return (
                  <div
                    key={email.id}
                    className="relative mb-2 min-w-0 overflow-hidden rounded-xl bg-white px-5 py-4 shadow-sm"
                    style={accentColor ? { borderLeftWidth: '2px', borderLeftColor: accentColor + '60' } : undefined}
                  >

                    {/* Email header */}
                    <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar.Root className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full">
                          <Avatar.Fallback
                            className={cn(
                              'flex h-full w-full items-center justify-center rounded-full text-[10px] font-bold',
                              color.bg,
                              color.text,
                            )}
                          >
                            {getInitials(senderName)}
                          </Avatar.Fallback>
                        </Avatar.Root>
                        <div className="min-w-0">
                          <button
                            className="max-w-full truncate text-[13px] font-semibold text-text-primary transition-colors hover:text-primary cursor-pointer"
                            onClick={(e) => {
                              setContactCardEmail(email.fromAddress);
                              setContactCardAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
                            }}
                          >
                            {senderName}
                          </button>
                          <EmailRecipientSummary
                            to={email.toAddresses}
                            cc={email.ccAddresses}
                            bcc={email.bccAddresses}
                          />
                        </div>
                      </div>
                      <span className="shrink-0 text-[11px] text-text-tertiary">
                        {formatExactTime(email.receivedAt)}
                      </span>
                    </div>

                    {/* Email body — with quoted content collapsed.
                        bodyHtmlClean / bodyHtmlTrimmed are server-side
                        pre-processed strings (sanitize + strip-quotes). When
                        present we skip the client's per-render DOMPurify pass. */}
                    <CollapsedEmailBody
                      bodyHtml={email.bodyHtml}
                      bodyText={email.bodyText}
                      subject={email.subject ?? thread.subject ?? null}
                      preBodyHtmlClean={email.bodyHtmlClean ?? null}
                      preBodyHtmlTrimmed={email.bodyHtmlTrimmed ?? null}
                      preHasQuotedHistory={email.hasQuotedHistory ?? null}
                      preIsForwarded={email.isForwarded ?? null}
                      highlightText={highlightText}
                      emailId={email.id}
                      attachments={email.attachments ?? []}
                      authToken={authToken}
                      onImageClick={(src, alt) => setLightboxImage({ src, alt })}
                      onImageDownload={downloadInlineImage}
                    />

                    {/* Attachments — hide inline/embedded images (CID or signature-like) */}
                    {email.attachments?.filter((att: any) => {
                      if (att.contentId) return false;
                      // Hide small images with generic names (likely signature images)
                      if (/^image\d{3}\.(jpg|jpeg|png|gif)$/i.test(att.filename) && att.size < 30000) return false;
                      return true;
                    }).length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {email.attachments
                          .filter((att: any) => {
                            if (att.contentId) return false;
                            if (/^image\d{3}\.(jpg|jpeg|png|gif)$/i.test(att.filename) && att.size < 30000) return false;
                            return true;
                          })
                          .map((att: any) => {
                            const { icon: Icon, color, bgColor } = getFileTypeInfo(att.filename, att.mimeType);
                            const canPreview = isPreviewable(att.mimeType, att.filename);
                            return (
                              <div
                                key={att.id}
                                className="group/att relative flex items-center gap-2.5 rounded-lg border border-border px-3 py-2 text-left transition-all hover:bg-surface hover:border-text-tertiary hover:shadow-sm cursor-pointer"
                                onClick={() => downloadAttachment(email.id, att.id, att.filename)}
                              >
                                <div className={cn('relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', bgColor)}>
                                  <Icon className={cn('h-4 w-4 transition-opacity group-hover/att:opacity-0', color)} />
                                  <svg
                                    className="absolute inset-0 m-auto h-4 w-4 opacity-0 transition-opacity group-hover/att:opacity-100"
                                    viewBox="0 0 256 256"
                                    fill="currentColor"
                                  >
                                    <path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z" />
                                  </svg>
                                </div>
                                <div className="min-w-0">
                                  <div className="max-w-[180px] truncate text-[12px] font-medium text-text-primary">
                                    {att.filename}
                                  </div>
                                  <div className="text-[11px] text-text-tertiary">
                                    {formatFileSize(att.size)}
                                  </div>
                                </div>
                                {canPreview && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setPreviewAttachment({ emailId: email.id, attachment: att });
                                    }}
                                    className="absolute bottom-1.5 right-1.5 rounded-md p-1 text-text-tertiary opacity-0 transition-all hover:bg-white hover:text-text-primary hover:shadow-sm group-hover/att:opacity-100"
                                    title="Quick preview"
                                  >
                                    <Eye className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                      </div>
                    )}

                    {/* Send status indicators */}
                    {email.sendStatus === 'FAILED' && (
                      <SendFailedBanner
                        emailId={email.id}
                        error={email.sendError}
                        attempts={email.sendAttempts}
                      />
                    )}
                    {email.sendStatus === 'SENDING' && (
                      <div className="mt-3 flex items-center gap-2 rounded-lg bg-blue-50 px-3 py-2 text-[12px] text-blue-700">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Sending...</span>
                      </div>
                    )}
                    {email.sendStatus === 'DELIVERED' && (
                      <DeliveryStatus emailId={email.id} />
                    )}
                    {email.sendStatus === 'PENDING_SEND' && (
                      <div className="mt-3 flex items-center gap-2 text-[11px] text-amber-600">
                        <Clock className="h-3 w-3" />
                        <span>Sending shortly...</span>
                      </div>
                    )}
                  </div>
                );
              }

              if (item.type === 'scheduled') {
                const se = item.data;
                const sendTime = new Date(se.sendAt);
                const recipients = addressListLabel(se.toAddresses);

                return (
                  <div
                    key={`scheduled-${se.id}`}
                    className="relative mb-2 rounded-xl border border-dashed border-amber-300 bg-amber-50/50 px-5 py-4"
                  >
                    {/* Header */}
                    <div className="mb-2 flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <CalendarClock className="h-4 w-4 text-amber-500" />
                        <div>
                          <span className="text-[13px] font-semibold text-text-secondary">
                            Scheduled
                          </span>
                          {recipients && (
                            <span className="ml-2 text-[11px] text-text-tertiary">
                              to {recipients}
                            </span>
                          )}
                        </div>
                      </div>
                      <span className="flex items-center gap-1 text-[11px] text-amber-600">
                        <CalendarClock className="h-3 w-3" />
                        {sendTime.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}{' '}
                        at {sendTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      </span>
                    </div>

                    {/* Body preview */}
                    <div className="max-w-none text-[13px] leading-relaxed text-text-secondary">
                      {se.bodyText ? (
                        <p className="line-clamp-3 whitespace-pre-wrap">{se.bodyText}</p>
                      ) : (
                        <div
                          className="line-clamp-3"
                          dangerouslySetInnerHTML={{
                            __html: DOMPurify.sanitize(se.bodyHtml || '', {
                              FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
                            }),
                          }}
                        />
                      )}
                    </div>

                    {/* Actions */}
                    <div className="mt-2.5 flex items-center gap-2">
                      <button
                        onClick={() => {
                          // Open compose with the scheduled email data for editing
                          setPendingDraft({
                            body: se.bodyText || '',
                            to: addressListEmails(se.toAddresses),
                            subject: se.subject,
                            threadId: selectedThreadId || undefined,
                          });
                          setEditingScheduledId(se.id);
                          setReplyMode('reply');
                        }}
                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-text-secondary transition-colors hover:bg-amber-100 hover:text-amber-700"
                      >
                        <Pencil className="h-3 w-3" />
                        Edit
                      </button>
                      <button
                        onClick={() => sendNowMutation.mutate(
                          { id: se.id, undoWindowSeconds: UNDO_WINDOW_SECONDS },
                          {
                            onSuccess: (res) => {
                              if (res.data?.undoDeadlineAt) {
                                addPendingEmail({
                                  id: res.data.id,
                                  threadId: res.data.threadId,
                                  body: se.bodyText || '',
                                  to: addressListEmails(se.toAddresses),
                                  subject: se.subject,
                                  undoDeadlineAt: res.data.undoDeadlineAt,
                                });
                              }
                            },
                          },
                        )}
                        disabled={sendNowMutation.isPending}
                        className="flex items-center gap-1 rounded-lg bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
                      >
                        {sendNowMutation.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Play className="h-3 w-3" />
                        )}
                        Send Now
                      </button>
                      <button
                        onClick={() => cancelScheduledMutation.mutate(se.id)}
                        disabled={cancelScheduledMutation.isPending}
                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-text-tertiary transition-colors hover:bg-red-50 hover:text-red-500"
                      >
                        <X className="h-3 w-3" />
                        Cancel
                      </button>
                    </div>
                  </div>
                );
              }

              // Comment item — inline in the timeline
              const comment = item.data;
              const isOwn = comment.author?.id === user?.id;
              const authorName = comment.author?.name || 'Unknown';
              const commentColor = getAvatarColor(authorName);

              return (
                <div key={comment.id} className="mb-2 rounded-xl bg-comments-bg px-5 py-3">
                  <div className={cn('flex gap-2', isOwn && 'flex-row-reverse')}>
                    {!isOwn && (
                      <Avatar.Root className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full">
                        <Avatar.Fallback
                          className={cn(
                            'flex h-full w-full items-center justify-center rounded-full text-[9px] font-bold',
                            commentColor.bg,
                            commentColor.text,
                          )}
                        >
                          {getInitials(authorName)}
                        </Avatar.Fallback>
                      </Avatar.Root>
                    )}
                    <div className={cn('max-w-[75%]', isOwn && 'items-end')}>
                      <div className={cn('mb-0.5 flex items-center gap-1.5', isOwn && 'flex-row-reverse')}>
                        {!isOwn && (
                          <span className="text-[11px] font-semibold text-text-primary">
                            {authorName}
                          </span>
                        )}
                        <span className="text-[10px] text-text-tertiary">
                          {formatExactTime(comment.createdAt)}
                        </span>
                        <span className="text-[9px] font-medium uppercase tracking-wider text-amber-500">
                          Internal
                        </span>
                      </div>
                      <div
                        className={cn(
                          'rounded-lg px-3 py-2 text-[13px] leading-relaxed',
                          isOwn
                            ? 'rounded-br-lg bg-surface-warm text-text-primary'
                            : 'rounded-bl-lg bg-surface text-text-primary ring-1 ring-border/40',
                        )}
                      >
                        <div
                          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(comment.bodyHtml) }}
                          className="[&_p]:m-0"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar
          orientation="vertical"
          className="flex w-2 touch-none select-none p-0.5"
        >
          <ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>

      {/* Reply bar + inline comment input */}
      <div className="border-t border-border bg-white">
        {replyMode ? (
          <Suspense fallback={<div className="h-16 animate-pulse bg-surface" />}>
            <ComposeInline
            key={`${pendingDraft?.draftId ?? pendingDraft?.threadId ?? savedDraftEmail?.id ?? 'compose'}-${pendingDraft?.to ?? ''}-${replyMode}`}
            threadId={thread.id}
            lastEmailId={thread.emails?.[thread.emails.length - 1]?.id}
            accountId={(() => {
              // Smart reply-from: find which of the user's accounts was in the To/CC of the last email
              const lastEmail = thread.emails?.[thread.emails.length - 1];
              if (!lastEmail) return thread.accountId;
              const allAccounts = accountsData?.data ?? [];
              const recipientEmails = [
                ...asAddressArray(lastEmail.toAddresses),
                ...asAddressArray(lastEmail.ccAddresses),
              ].map((a) => a?.email?.toLowerCase()).filter(Boolean);
              const matchedAccount = allAccounts.find((a: any) =>
                recipientEmails.includes(a.email?.toLowerCase()),
              );
              return matchedAccount?.id ?? thread.accountId;
            })()}
            mode={replyMode}
            onClose={() => {
              setReplyMode(null);
              if (pendingDraft) setPendingDraft(null);
              if (editingScheduledId) setEditingScheduledId(null);
            }}
            existingDraftId={
              savedDraftEmail && !pendingDraft
                ? savedDraftEmail.id
                : pendingDraft?.draftId
                  ? pendingDraft.draftId
                  : undefined
            }
            initialDraft={
              savedDraftEmail && !pendingDraft
                ? {
                    body: savedDraftEmail.bodyText || '',
                    bodyHtml: savedDraftEmail.bodyHtml || undefined,
                    to: addressListEmails(savedDraftEmail.toAddresses),
                    subject: savedDraftEmail.subject || '',
                  }
                : pendingDraft && pendingDraft.threadId === thread.id
                  ? { body: pendingDraft.body, bodyHtml: pendingDraft.bodyHtml, to: pendingDraft.to, subject: pendingDraft.subject }
                  : undefined
            }
            aiOriginal={
              pendingDraft && pendingDraft.threadId === thread.id
                ? pendingDraft.aiOriginal
                : undefined
            }
            replyRecipients={(() => {
              // AI-created drafts carry an explicit To value. In reply mode the
              // composer renders recipient chips from `replyRecipients`, not
              // `initialDraft.to`, so honor the AI draft recipient here instead
              // of recomputing recipients from the latest email in the thread.
              if (pendingDraft?.to) return parseAddressString(pendingDraft.to);

              const lastEmail = thread.emails?.[thread.emails.length - 1];
              if (!lastEmail) return [];
              const myEmails = (accountsData?.data ?? []).map((a: any) => a.email?.toLowerCase());
              const all: { email: string; name?: string }[] = [];
              // Add sender
              if (lastEmail.fromAddress && !myEmails.includes(lastEmail.fromAddress.toLowerCase())) {
                all.push({ email: lastEmail.fromAddress, name: lastEmail.fromName || undefined });
              }
              // Add to/cc (excluding self)
              for (const addr of [...asAddressArray(lastEmail.toAddresses), ...asAddressArray(lastEmail.ccAddresses)]) {
                if (addr?.email && !myEmails.includes(addr.email.toLowerCase()) && !all.some((a) => a.email === addr.email)) {
                  all.push({ email: addr.email, name: addr.name || undefined });
                }
              }
              return all;
            })()}
            fromEmail={(() => {
              // Match fromEmail to the smart reply-from account
              const lastEmail = thread.emails?.[thread.emails.length - 1];
              const allAccounts = accountsData?.data ?? [];
              if (lastEmail) {
                const recipientEmails = [
                  ...asAddressArray(lastEmail.toAddresses),
                  ...asAddressArray(lastEmail.ccAddresses),
                ].map((a) => a?.email?.toLowerCase()).filter(Boolean);
                const matched = allAccounts.find((a: any) =>
                  recipientEmails.includes(a.email?.toLowerCase()),
                );
                if (matched) return matched.email;
              }
              return allAccounts.find((a: any) => a.id === thread.accountId)?.email;
            })()}
          />
          </Suspense>
        ) : (
          <div className="space-y-0">
            {/* Reply bar — avatar + input on left, icons on right */}
            {!showNoteInput ? (
              <div className="flex items-center gap-3 px-5 py-2.5">
                {/* Avatar */}
                <Avatar.Root className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full">
                  <Avatar.Fallback
                    className={cn(
                      'flex h-full w-full items-center justify-center rounded-full text-[11px] font-bold',
                      user ? getAvatarColor(user.name || user.email).bg : 'bg-surface',
                      user ? getAvatarColor(user.name || user.email).text : 'text-text-tertiary',
                    )}
                  >
                    {getInitials(user?.name || user?.email || '?')}
                  </Avatar.Fallback>
                </Avatar.Root>

                {/* Clickable reply field */}
                <button
                  onClick={() => setReplyMode('reply')}
                  className="min-w-0 flex-1 rounded-lg border border-border bg-surface/50 px-4 py-2 text-left text-[13px] text-text-tertiary transition-colors hover:border-border hover:bg-white"
                >
                  Reply all
                </button>

                {/* Right-side icons */}
                <div className="flex items-center gap-0.5">
                  <Tooltip content="Forward">
                    <button
                      onClick={() => setReplyMode('forward')}
                      className="rounded-lg p-2 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
                    >
                      <Forward className="h-4 w-4" />
                    </button>
                  </Tooltip>
                  <Tooltip content="Internal note">
                    <button
                      onClick={() => setShowNoteInput(true)}
                      className="rounded-lg p-2 text-text-tertiary transition-colors hover:bg-amber-50 hover:text-amber-500"
                    >
                      <MessageSquare className="h-4 w-4" />
                    </button>
                  </Tooltip>
                </div>
              </div>
            ) : (
              /* Internal note input */
              <div className="bg-amber-50/40 px-5 py-2.5">
                {/* Tagged members */}
                {taggedMembers.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1">
                    {taggedMembers.map((m) => (
                      <span
                        key={m.id}
                        className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-700"
                      >
                        @{m.name}
                        <button onClick={() => removeTag(m.id)} className="hover:text-amber-900">
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Tag dropdown */}
                {showTagMenu && (
                  <div className="mb-2 rounded-lg border border-amber-200/60 bg-white p-2">
                    <input
                      type="text"
                      value={tagSearch}
                      onChange={(e) => setTagSearch(e.target.value)}
                      placeholder="Search team members..."
                      className="mb-2 w-full rounded-lg border border-border px-2.5 py-1.5 text-[12px] outline-none placeholder:text-text-tertiary focus:border-amber-400"
                      autoFocus
                    />
                    <div className="max-h-32 overflow-y-auto">
                      {filteredMembers.map((m) => {
                        const mc = getAvatarColor(m.name);
                        return (
                          <button
                            key={m.id}
                            onClick={() => addTag(m)}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface"
                          >
                            <div
                              className={cn(
                                'flex h-5 w-5 items-center justify-center rounded-full text-[8px] font-bold',
                                mc.bg,
                                mc.text,
                              )}
                            >
                              {getInitials(m.name)}
                            </div>
                            <div>
                              <span className="text-[12px] font-medium text-text-primary">{m.name}</span>
                              <span className="ml-1.5 text-[11px] text-text-tertiary">{m.email}</span>
                            </div>
                          </button>
                        );
                      })}
                      {filteredMembers.length === 0 && (
                        <p className="py-2 text-center text-[11px] text-text-tertiary">No members found</p>
                      )}
                    </div>
                  </div>
                )}

                <form onSubmit={handleCommentSubmit} className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowTagMenu(!showTagMenu)}
                    className={cn(
                      'rounded-lg p-1.5 transition-colors',
                      showTagMenu ? 'bg-amber-100 text-amber-600' : 'text-text-tertiary hover:bg-amber-100/50 hover:text-amber-600',
                    )}
                    title="Tag team member"
                  >
                    <UserPlus className="h-3.5 w-3.5" />
                  </button>
                  <input
                    type="text"
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    onKeyDown={handleCommentKeyDown}
                    placeholder="Internal note..."
                    className="min-w-0 flex-1 rounded-lg border border-amber-200/80 bg-white px-3 py-1.5 text-[13px] text-text-primary placeholder:text-text-tertiary focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400/50"
                    autoFocus
                  />
                  <button
                    type="submit"
                    disabled={!newComment.trim() || addComment.isPending}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500 text-white transition-colors hover:bg-amber-600 disabled:opacity-40"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowNoteInput(false); setShowTagMenu(false); }}
                    className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
                    title="Close"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </form>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Contact card popover */}
      {contactCardEmail && contactCardData && (
        <ContactCard
          contact={contactCardData}
          anchorRect={contactCardAnchor}
          onClose={() => setContactCardEmail(null)}
        />
      )}

      {/* Attachment preview overlay */}
      {previewAttachment && (
        <AttachmentPreview
          emailId={previewAttachment.emailId}
          attachment={previewAttachment.attachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}

      {/* Image lightbox with pinch-to-zoom */}
      <ImageLightbox
        src={lightboxImage?.src ?? null}
        alt={lightboxImage?.alt}
        onClose={() => setLightboxImage(null)}
        onDownload={downloadInlineImage}
      />
    </div>
  );
}
