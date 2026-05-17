import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from 'react';
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
  ChevronDown,
  Ban,
} from 'lucide-react';
import * as Avatar from '@radix-ui/react-avatar';
import * as Dialog from '@radix-ui/react-dialog';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import { useThread, useUpdateThread } from '../../hooks/useThreads';
import { TriageBanner, SenderRuleDialog } from './TriageBanner';
import { useTriageFeedback } from '../../hooks/useTriage';
import { DeliveryStatus } from './DeliveryStatus';
import { TriageCategoryPill } from './TriageCategoryPill';
import { useAddComment } from '../../hooks/useComments';
import { useAccounts } from '../../hooks/useAccounts';
import { useUiStore } from '../../stores/uiStore';
import { useAuthStore } from '../../stores/authStore';
import { formatExactTime, getInitials, cn } from '../../lib/utils';
import { getAvatarColor } from '../../lib/constants';
import { ComposeInline } from '../compose/ComposeInline';
import { Tooltip } from '../ui/Tooltip';
import { ContactCard } from '../contacts/ContactCard';
import { useContactAutocomplete, useContactNameResolver } from '../../hooks/useContacts';
import { useThreadScheduledEmails, useSendScheduledNow, useCancelScheduledEmail } from '../../hooks/useScheduledEmails';
import { useUndoSendStore } from '../../stores/undoSendStore';
import { useBlockSender, useBlockedSenders, useUnblockSender } from '../../hooks/useBlockedSenders';
import { useIsMobile } from '../../hooks/useIsMobile';
import { haptic } from '../../lib/haptics';
import { ImageLightbox } from './ImageLightbox';
import DOMPurify from 'dompurify';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMutation as useConvexMutation, useQuery as useConvexQuery } from 'convex/react';
import { api } from '../../lib/api';
import { convex } from '../../lib/convex';
import { api as convexApi } from '../../../../../convex/_generated/api';
import type { Id } from '../../../../../convex/_generated/dataModel';
import toast from 'react-hot-toast';

// Team domain — emails from this domain get the pastel triangle
const TEAM_DOMAIN = 'orbi.agency';

function SendFailedBanner({ emailId, error, attempts }: { emailId: string; error?: string | null; attempts?: number }) {
  const retrySendMutation = useConvexMutation(convexApi.emails.retrySend);
  const retry = useMutation({
    mutationFn: () => retrySendMutation({ emailId: emailId as Id<'emails'> }),
    onSuccess: () => {
      toast.success('Retry queued — sending again');
      // Convex queries are reactive; no manual cache invalidation needed.
    },
    onError: (err: unknown) =>
      toast.error(err instanceof Error ? err.message : 'Failed to queue retry'),
  });

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
        <button
          onClick={() => retry.mutate()}
          disabled={retry.isPending}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-red-100 px-2.5 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-200 disabled:opacity-50"
        >
          <RotateCcw className={cn('h-3 w-3', retry.isPending && 'animate-spin')} />
          {retry.isPending ? 'Retrying...' : 'Retry Send'}
        </button>
      </div>
    </div>
  );
}

// Strip all on* event handler attributes from sanitized HTML
// and force every <a> to open externally (in Electron, this routes to
// shell.openExternal via setWindowOpenHandler instead of trying to
// navigate the renderer away from the app).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.attributes) {
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith('on')) {
        node.removeAttribute(attr.name);
      }
    }
  }
  if (node.nodeName === 'A') {
    (node as Element).setAttribute('target', '_blank');
    (node as Element).setAttribute('rel', 'noopener noreferrer');
  }
});

// Wrap bare URLs in text nodes with <a> tags so they're clickable.
const URL_RE = /\b(https?:\/\/[^\s<>"']+)/g;
function autoLinkify(html: string): string {
  if (!html) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);
  for (const tn of textNodes) {
    if (tn.parentElement?.closest('a, script, style')) continue;
    const text = tn.nodeValue || '';
    if (!URL_RE.test(text)) continue;
    URL_RE.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(text))) {
      if (m.index > last) frag.appendChild(doc.createTextNode(text.slice(last, m.index)));
      const a = doc.createElement('a');
      a.href = m[1];
      a.textContent = m[1];
      frag.appendChild(a);
      last = m.index + m[1].length;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    tn.parentNode?.replaceChild(frag, tn);
  }
  return doc.body.innerHTML;
}

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
  }

  // ── Phase 3: catch-all blockquotes ──────────────────────────
  doc.querySelectorAll('blockquote').forEach((el) => el.remove());

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
    }
  });

  const cleaned = doc.body.innerHTML;
  const hasQuoted = cleaned.length < html.length - 50;

  return { body: cleaned, hasQuoted };
}

/**
 * Split an email body into separate "cards" at each quoted-reply boundary.
 * For a fresh email with no quoted content, returns [html] (one card).
 * For a reply that contains the previous email inline, returns [reply, previous].
 * Handles nested quotes recursively (chains of replies → 3+ cards).
 */
function splitIntoCards(html: string): string[] {
  if (!html) return [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Patterns identical to stripQuotedContent — keep the two in sync.
  const quoteStartPatterns = [
    /On\s+.{5,120}\s+wrote:\s*$/,
    /wrote:\s*$/,
    /^-{3,}\s*(Forwarded|Original)\s*(message|Message)/i,
    /^_{5,}/,
    /^Begin forwarded message/i,
  ];
  const headerPattern = /^From:\s+.+/im;
  const sentPattern = /^Sent:\s+.+/im;

  // Try to find a "cut element" — first element that begins a quoted block.
  // Returns null if no quote found.
  function findCutEl(body: HTMLElement): Element | null {
    // Phase 1: well-known wrapper elements (these mark the START of quoted content).
    const wrappers = body.querySelectorAll([
      '.gmail_quote', '.gmail_extra',
      '#appendonsend', '#divRplyFwdMsg', '[name="divRplyFwdMsg"]',
      '.yahoo_quoted',
      'blockquote[type="cite"]', 'blockquote.cite',
    ].join(','));
    if (wrappers.length > 0) return wrappers[0];

    // Phase 2: text-marker scan
    const allEls = Array.from(body.querySelectorAll('*'));
    for (const el of allEls) {
      const fullText = (el.textContent ?? '').trim();
      if (fullText.length < 3) continue;
      if (fullText.length < 500 && headerPattern.test(fullText) && sentPattern.test(fullText)) {
        return el;
      }
      const directText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent?.trim() ?? '')
        .join(' ')
        .trim();
      if (directText.length < 3) continue;
      if (quoteStartPatterns.some((p) => p.test(directText))) return el;
    }
    return null;
  }

  const fragments: string[] = [];
  let currentBody: HTMLElement = doc.body;
  let safety = 8; // never produce more than 8 cards (chains of forwards rarely exceed this)

  while (safety-- > 0) {
    const cutEl = findCutEl(currentBody);
    if (!cutEl) {
      const remaining = currentBody.innerHTML.trim();
      if (remaining.length > 0) fragments.push(remaining);
      break;
    }

    // Walk up from cutEl to find a target ancestor that isn't the body and
    // doesn't engulf 90%+ of the document (heuristic from stripQuotedContent).
    let target: Element = cutEl;
    const bodyLen = currentBody.innerHTML.length;
    while (target.parentElement && target.parentElement !== currentBody) {
      if (target.parentElement.innerHTML.length > bodyLen * 0.85) break;
      target = target.parentElement;
    }

    // Clone the body to a working DOM, remove [target..end] for the "before" fragment.
    const beforeDoc = parser.parseFromString(currentBody.innerHTML, 'text/html');
    // Locate the corresponding target in the cloned doc by index path.
    const findCutInClone = findCutEl(beforeDoc.body);
    if (!findCutInClone) {
      // Shouldn't happen; bail to avoid infinite loop.
      fragments.push(currentBody.innerHTML);
      break;
    }
    let cloneTarget: Element = findCutInClone;
    while (cloneTarget.parentElement && cloneTarget.parentElement !== beforeDoc.body) {
      if (cloneTarget.parentElement.innerHTML.length > beforeDoc.body.innerHTML.length * 0.85) break;
      cloneTarget = cloneTarget.parentElement;
    }
    let next: Element | null = cloneTarget;
    while (next) {
      const toRemove = next;
      next = next.nextElementSibling;
      toRemove.remove();
    }
    const beforeHtml = beforeDoc.body.innerHTML.trim();
    if (beforeHtml.length > 0) fragments.push(beforeHtml);

    // For the "after" fragment, capture target + following siblings.
    // Strip the leading "On ... wrote:" attribution line if it sits as a sibling
    // before the actual quoted body.
    const afterDoc = parser.parseFromString(currentBody.innerHTML, 'text/html');
    const afterCut = findCutEl(afterDoc.body);
    if (!afterCut) break;
    let afterTarget: Element = afterCut;
    while (afterTarget.parentElement && afterTarget.parentElement !== afterDoc.body) {
      if (afterTarget.parentElement.innerHTML.length > afterDoc.body.innerHTML.length * 0.85) break;
      afterTarget = afterTarget.parentElement;
    }
    // Remove everything BEFORE afterTarget from the body so what remains is the quoted block + tail.
    let prev: Element | null = afterTarget.previousElementSibling;
    while (prev) {
      const toRemove = prev;
      prev = prev.previousElementSibling;
      toRemove.remove();
    }
    // If the target is a Gmail .gmail_quote wrapper, unwrap one level so the
    // inner content can be re-split for nested quotes.
    if (afterTarget.classList?.contains('gmail_quote') || afterTarget.tagName.toLowerCase() === 'blockquote') {
      // Use the inner HTML so nested quotes can be detected.
      currentBody = afterDoc.createElement('div');
      currentBody.innerHTML = afterTarget.innerHTML;
    } else {
      currentBody = afterDoc.body;
    }
  }

  return fragments.length > 0 ? fragments : [html];
}

/**
 * Parse the attribution line ("On <date> <person> <email> wrote:" or
 * Outlook-style "From: ... Sent: ...") at the top of a quoted email fragment.
 * Returns attribution metadata + the body with the attribution line stripped.
 */
function extractAttributionAndBody(html: string): {
  senderName?: string;
  senderEmail?: string;
  date?: string;
  body: string;
} {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const text = doc.body.textContent ?? '';

  // Patterns
  const gmailMatch = text.match(
    /On\s+([^<\n]{5,150}?)\s+([^<\n]{1,80}?)\s*<([^>\s]+@[^>\s]+)>\s*wrote:/i,
  );
  const fromMatch = text.match(/From:\s*([^<\n]+?)\s*<([^>\s]+@[^>\s]+)>/);
  const sentMatch = text.match(/Sent:\s*([^\n]+)/);

  let senderName: string | undefined;
  let senderEmail: string | undefined;
  let date: string | undefined;

  if (gmailMatch) {
    date = gmailMatch[1].trim().replace(/\s+/g, ' ').replace(/[,\s]+$/, '');
    senderName = gmailMatch[2].trim();
    senderEmail = gmailMatch[3].trim();
  } else if (fromMatch) {
    senderName = fromMatch[1].trim();
    senderEmail = fromMatch[2].trim();
    date = sentMatch?.[1].trim();
  }

  // Strip the attribution element so the body doesn't duplicate it.
  const attrPattern = /(On\s+[^<\n]{5,150}\s+[^<\n]{1,80}\s*<[^>]+>\s*wrote:|From:\s+[^<\n]+\s*<[^>]+>)/i;
  const allEls = Array.from(doc.body.querySelectorAll('*'));
  for (const el of allEls) {
    const t = (el.textContent ?? '').trim();
    if (t.length > 0 && t.length < 500 && attrPattern.test(t)) {
      // Only remove if this element is "small" — don't accidentally remove the whole body
      if ((el.innerHTML ?? '').length < 1500) {
        el.remove();
        break;
      }
    }
  }

  return { senderName, senderEmail, date, body: doc.body.innerHTML.trim() };
}

/**
 * Try to parse a date string into a millis timestamp. Falls back to null on
 * unparseable input.
 */
function parseDateGuess(s?: string): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  // Try replacing "at" → " "
  const t2 = Date.parse(s.replace(/\s+at\s+/i, ' '));
  if (!Number.isNaN(t2)) return t2;
  return null;
}

/**
 * Expand an email containing quoted history into one synthetic email per
 * historical message, so they render as peer cards in the timeline.
 *
 * Returns [original (with quoted stripped), ...syntheticOlderEmails].
 * Synthetic emails have id like "<originalId>__q1", a `synthetic: true`
 * flag, parsed sender from the attribution line, and the corresponding
 * body fragment.
 */
function expandEmailWithQuotedHistory(email: any): any[] {
  const html = email.bodyHtml as string | null | undefined;
  if (!html) return [email];
  const fragments = splitIntoCards(html);
  if (fragments.length <= 1) return [email];

  // First fragment = the main email's user-visible content.
  const main = { ...email, bodyHtml: fragments[0] };

  const synthetics: any[] = [];
  let parentReceivedAt = email.receivedAt
    ? new Date(email.receivedAt).getTime()
    : Date.now();

  for (let i = 1; i < fragments.length; i++) {
    const { senderName, senderEmail, date, body } = extractAttributionAndBody(
      fragments[i],
    );
    const ts = parseDateGuess(date) ?? parentReceivedAt - 60_000 * i;
    parentReceivedAt = ts;
    synthetics.push({
      ...email,
      id: `${email.id}__q${i}`,
      synthetic: true,
      fromAddress: senderEmail ?? email.fromAddress,
      fromName: senderName ?? email.fromName,
      receivedAt: new Date(ts).toISOString(),
      bodyHtml: body,
      bodyText: null,
      attachments: [],
    });
  }

  return [main, ...synthetics];
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
function markCidImages(html: string, emailId: string, attachments: any[]): string {
  if (!attachments?.length) return html;

  return html.replace(/src=["']cid:([^"']+)["']/gi, (match, cidRef) => {
    const normalized = cidRef.replace(/^<|>$/g, '');
    const att = attachments.find((a: any) => {
      const attCid = (a.contentId || '').replace(/^<|>$/g, '');
      return attCid === normalized;
    });
    if (att) {
      // Keep a placeholder src and mark with data attributes for useEffect resolution
      return `src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" data-cid-email="${emailId}" data-cid-attachment="${att.id}"`;
    }
    return match;
  });
}

/** Scope <style> blocks to a container so they don't leak into the app */
function scopeStyles(html: string, scopeId: string): string {
  return html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (_, attrs, css) => {
    // Prefix every selector with the scope ID
    const scoped = css.replace(
      /([^\r\n,{}]+)(,(?=[^}]*{)|\s*{)/g,
      (sMatch: string, selector: string, sep: string) => {
        const trimmed = selector.trim();
        if (!trimmed || trimmed.startsWith('@') || trimmed.startsWith('from') || trimmed.startsWith('to') || /^\d+%/.test(trimmed)) {
          return sMatch;
        }
        return `#${scopeId} ${trimmed}${sep}`;
      },
    );
    return `<style${attrs}>${scoped}</style>`;
  });
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

/** Download an attachment via Convex (fetches from Gmail/Microsoft on first download). */
async function downloadAttachment(_emailId: string, attachmentId: string, filename: string) {
  try {
    const { url } = await convex.action(convexApi.emails.downloadAttachment, {
      attachmentId: attachmentId as Id<'attachments'>,
    });
    if (!url) throw new Error('No URL');
    const res = await fetch(url);
    if (!res.ok) throw new Error('Fetch failed');
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (err) {
    toast.error('Download failed');
    console.error('downloadAttachment error:', err);
  }
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
async function fetchAttachmentBlob(_emailId: string, attachmentId: string): Promise<string> {
  const { url } = await convex.action(convexApi.emails.downloadAttachment, {
    attachmentId: attachmentId as Id<'attachments'>,
  });
  if (!url) throw new Error('Preview failed');
  const res = await fetch(url);
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

    convex
      .action(convexApi.emails.downloadAttachment, {
        attachmentId: attachment.id as Id<'attachments'>,
      })
      .then(({ url }) => {
        if (!url) throw new Error('Preview failed');
        return fetch(url);
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

/** Renders email body inline (no iframe) with quoted content collapsed */
function CollapsedEmailBody({ bodyHtml, bodyText, highlightText, emailId, attachments, onImageClick }: {
  bodyHtml: string | null;
  bodyText: string | null;
  highlightText: string | null;
  emailId: string;
  attachments: any[];
  onImageClick?: (src: string, alt?: string) => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [showQuoted, setShowQuoted] = useState(false);
  const scopeId = useMemo(() => `email-${emailId.slice(0, 8)}`, [emailId]);

  // Resolve cid: images by asking Convex for a signed URL and assigning it
  // to the <img>. The Convex `downloadAttachment` action also handles the
  // "not yet in Convex storage" case — it pulls the bytes from Gmail/Microsoft
  // on first request and caches them — so we don't need to fetch + blob URL
  // ourselves.
  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;
    const cidImgs = container.querySelectorAll('img[data-cid-attachment]');
    const cidSet = new WeakSet<Element>();
    let cancelled = false;

    cidImgs.forEach((img) => {
      cidSet.add(img);
      const attId = img.getAttribute('data-cid-attachment');
      if (!attId) return;

      convex
        .action(convexApi.emails.downloadAttachment, {
          attachmentId: attId as Id<'attachments'>,
        })
        .then(({ url }) => {
          if (cancelled || !url) return;
          (img as HTMLImageElement).src = url;
        })
        .catch(() => {
          (img as HTMLImageElement).style.opacity = '0';
        });
    });

    // For non-CID images: use opacity instead of display:none to preserve layout
    const allImgs = container.querySelectorAll('img');
    const errorHandlers: Array<[HTMLImageElement, () => void]> = [];
    allImgs.forEach((img) => {
      if (cidSet.has(img)) return;
      const handler = () => { (img as HTMLImageElement).style.opacity = '0'; };
      (img as HTMLImageElement).addEventListener('error', handler);
      errorHandlers.push([img as HTMLImageElement, handler]);
    });

    return () => {
      cancelled = true;
      errorHandlers.forEach(([img, handler]) => img.removeEventListener('error', handler));
    };
  });

  // Intercept link clicks in email body — open external links in system browser on native
  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;

    const handleClick = async (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;

      // mailto: links — could open compose, but for now let native handle
      if (href.startsWith('mailto:') || href.startsWith('tel:')) return;

      // Internal links (anchors, relative) — skip
      if (href.startsWith('#') || href.startsWith('/')) return;

      // External link — open in system browser on native, new tab on web
      e.preventDefault();
      e.stopPropagation();

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
    };

    container.addEventListener('click', handleClick);
    return () => container.removeEventListener('click', handleClick);
  });

  // Image tap to open lightbox on mobile
  useEffect(() => {
    if (!onImageClick) return;
    const container = bodyRef.current;
    if (!container) return;

    const handleImgClick = (e: MouseEvent) => {
      const img = (e.target as HTMLElement).closest('img');
      if (!img) return;
      const src = img.getAttribute('src');
      if (src) {
        e.preventDefault();
        e.stopPropagation();
        onImageClick(src, img.getAttribute('alt') || undefined);
      }
    };

    container.addEventListener('click', handleImgClick);
    return () => container.removeEventListener('click', handleImgClick);
  });

  const { trimmedHtml, trimmedText, hasQuoted } = useMemo(() => {
    if (bodyHtml) {
      const result = stripQuotedContent(bodyHtml);
      return { trimmedHtml: result.body, trimmedText: null, hasQuoted: result.hasQuoted };
    }
    if (bodyText) {
      const result = stripQuotedText(bodyText);
      return { trimmedHtml: null, trimmedText: result.body, hasQuoted: result.hasQuoted };
    }
    return { trimmedHtml: null, trimmedText: null, hasQuoted: false };
  }, [bodyHtml, bodyText]);

  const displayHtml = showQuoted ? bodyHtml : trimmedHtml;
  const displayText = showQuoted ? bodyText : trimmedText;

  const sanitizedHtml = useMemo(() => {
    if (!displayHtml) return null;
    let resolved = markCidImages(displayHtml, emailId, attachments);
    resolved = scopeStyles(resolved, scopeId);
    resolved = autoLinkify(resolved);
    let cleaned = DOMPurify.sanitize(resolved, {
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'button'],
      ADD_TAGS: ['style', 'img'],
      ADD_ATTR: ['src', 'alt', 'width', 'height', 'border', 'align', 'valign', 'bgcolor', 'background', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'data-cid-email', 'data-cid-attachment', 'referrerpolicy', 'target', 'rel'],
      ADD_DATA_URI_TAGS: ['img'],
    });
    cleaned = cleaned.replace(/<img /gi, '<img referrerpolicy="no-referrer" ');
    if (highlightText) {
      cleaned = injectHighlight(cleaned, highlightText);
    }
    return cleaned;
  }, [displayHtml, highlightText, emailId, attachments, scopeId]);

  return (
    <>
      {sanitizedHtml ? (
        <div
          id={scopeId}
          ref={bodyRef}
          className="email-body-inline text-[14px] leading-relaxed text-text-primary break-words [overflow-wrap:anywhere] [&_img]:max-w-full [&_img]:h-auto [&_a]:text-[#1a73e8] [&_a]:underline [&_a]:cursor-pointer [&_table]:max-w-full [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_pre]:whitespace-pre-wrap"
          dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
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
      ) : (
        <div className="rounded-md bg-surface px-3 py-2 text-[12px] italic text-text-tertiary">
          (No body content yet.)
          <button
            onClick={async () => {
              try {
                const result = await convex.action(convexApi.sync.gmail.refreshEmail, {
                  emailId: emailId as Id<'emails'>,
                });
                if (!result.ok) toast.error(result.reason || 'Refresh failed');
                else toast.success('Refreshed');
              } catch (err) {
                toast.error('Refresh failed');
                console.error(err);
              }
            }}
            className="ml-2 rounded-md border border-border bg-white px-2 py-0.5 text-[11px] font-medium not-italic text-text-secondary transition-colors hover:bg-surface"
          >
            Re-fetch from Gmail
          </button>
        </div>
      )}
      {hasQuoted && (
        <button
          onClick={() => setShowQuoted(!showQuoted)}
          className="mt-2 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-text-tertiary transition-colors hover:bg-surface hover:text-text-secondary"
        >
          {showQuoted ? 'Hide quoted text' : '···'}
        </button>
      )}
    </>
  );
}


/**
 * Self-healing component for threads that loaded with no email rows.
 * Automatically calls refreshThread once on mount, shows a loading state.
 * Convex queries are reactive — when refreshThread inserts emails, the
 * parent's `useThread` query re-runs and timeline.length becomes > 0,
 * which unmounts this component.
 */
function BlankThreadAutoFix({ threadId }: { threadId: Id<'threads'> }) {
  const [status, setStatus] = useState<'fetching' | 'failed' | 'noEmails'>('fetching');
  const triggered = useRef(false);

  useEffect(() => {
    if (triggered.current) return;
    triggered.current = true;
    let cancelled = false;
    (async () => {
      try {
        const result = await convex.action(
          convexApi.sync.gmail.refreshThread,
          { threadId },
        );
        if (cancelled) return;
        if (!result.ok) setStatus('failed');
        else setStatus('noEmails'); // success but might still be empty (e.g., truly no body)
      } catch (err) {
        if (!cancelled) setStatus('failed');
        console.error('Auto-refetch failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [threadId]);

  if (status === 'fetching') {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-[12px] text-text-tertiary">Loading messages…</div>
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="rounded-lg border border-dashed border-border bg-white px-5 py-8 text-center">
        <p className="mb-2 text-sm text-text-secondary">Couldn't load messages.</p>
        <button
          onClick={() => { triggered.current = false; setStatus('fetching'); }}
          className="rounded-md border border-border bg-white px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface"
        >
          Try again
        </button>
      </div>
    );
  }
  // noEmails — refetch ran successfully but the thread is genuinely empty
  return (
    <div className="rounded-lg border border-dashed border-border bg-white px-5 py-8 text-center">
      <p className="text-sm text-text-secondary">This thread has no messages.</p>
    </div>
  );
}

type TimelineItem =
  | { type: 'email'; timestamp: string; data: any }
  | { type: 'comment'; timestamp: string; data: any }
  | { type: 'scheduled'; timestamp: string; data: any };

interface EmailViewerProps {
  onBack?: () => void;
}

/** Pill rendering a name + email, copies the email to clipboard on click. */
function AddressChip({
  name,
  email,
  onCopy,
}: {
  name?: string | null;
  email: string;
  onCopy: (email: string, e: React.MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => onCopy(email, e)}
      title={`Copy ${email}`}
      className="group/chip inline-flex items-center gap-1.5 rounded-md border border-transparent bg-white px-2 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
    >
      {name && name !== email && (
        <span className="font-medium text-text-primary group-hover/chip:text-primary">{name}</span>
      )}
      <span className="text-text-tertiary group-hover/chip:text-primary/80">{email}</span>
    </button>
  );
}

// Determine left border accent color: you → brand orange, team → pastel, external → none
function getSenderAccent(fromAddress: string, currentUserEmail: string | undefined): string | null {
  if (!currentUserEmail) return null;
  if (fromAddress === currentUserEmail) return '#FF7E16';
  const senderDomain = fromAddress.split('@')[1];
  if (senderDomain === TEAM_DOMAIN) return '#FFC494';
  return null;
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
  const [blockOpen, setBlockOpen] = useState(false);
  // Per-sender / per-domain "send to spam forever" prompt — fires from the
  // Mark-as-spam button on the email viewer toolbar. Distinct from Block
  // (which trashes future mail) because spam mail is still retrievable.
  const [spamRuleOpen, setSpamRuleOpen] = useState(false);
  const triageFeedback = useTriageFeedback();
  // Needs Response: per-thread open-signal flag drives the Done button in
  // the toolbar; the mutation clears it. Query is skipped until we have a
  // selected thread to avoid an extra request on the dashboard.
  const needsResponseOpen = useConvexQuery(
    convexApi.needsResponse.hasOpenForThread,
    selectedThreadId
      ? { threadId: selectedThreadId as Id<'threads'> }
      : 'skip',
  );
  const dismissNeedsResponse = useConvexMutation(
    convexApi.needsResponse.dismissThread,
  );
  const { user } = useAuthStore();
  const { data: accountsData } = useAccounts();
  const resolveName = useContactNameResolver();
  const { data, isLoading, isPlaceholderData, isError, error } = useThread(selectedThreadId);
  // Treat stale (previous thread) data as loading — avoids flashing wrong content
  const isStale = isPlaceholderData && data?.data?.id !== selectedThreadId;
  const effectiveLoading = isLoading || isStale;
  const updateThread = useUpdateThread();
  const addComment = useAddComment();
  const blockSender = useBlockSender();
  const unblockSender = useUnblockSender();
  const { data: blockedSenders } = useBlockedSenders();
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
  const [expandedHeaderIds, setExpandedHeaderIds] = useState<Set<string>>(new Set());
  const [composeExpanded, setComposeExpanded] = useState(false);
  // Snapshot of emails that were unread when this thread was opened. Stays
  // stable while the user is viewing the thread so the "latest" red dot
  // doesn't disappear the moment Convex marks the row read.
  const newOnOpenSnapshot = useRef<{ threadId: string | null; ids: Set<string> }>({
    threadId: null,
    ids: new Set(),
  });
  const isMobile = useIsMobile();

  const toggleExpandedHeader = useCallback((emailId: string) => {
    setExpandedHeaderIds((prev) => {
      const next = new Set(prev);
      if (next.has(emailId)) next.delete(emailId);
      else next.add(emailId);
      return next;
    });
  }, []);

  const copyAddress = useCallback(async (email: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(email);
      toast.success(`Copied ${email}`);
    } catch {
      toast.error('Failed to copy');
    }
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

  // Mark thread as read when opened
  useEffect(() => {
    if (!selectedThreadId || !data?.data) return;
    const thread = data.data;
    if (!thread.isRead) {
      updateThread.mutate({ id: selectedThreadId, isRead: true });
    }
  }, [selectedThreadId, data?.data?.isRead]);

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

  // Scroll to bottom for multi-email threads, top for single emails
  // useLayoutEffect blocks paint until scroll is positioned — prevents flash of top content
  useLayoutEffect(() => {
    if (!selectedThreadId || !data?.data) return;
    if (data.data.id !== selectedThreadId) return;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const emailCount = data.data.emails?.length ?? 0;
    if (emailCount <= 1) {
      viewport.scrollTo({ top: 0, behavior: 'instant' });
    } else {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'instant' });
    }
  }, [selectedThreadId, data?.data?.id]);

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

  // Merge emails + comments + scheduled emails into a single sorted timeline.
  const timeline = useMemo(() => {
    if (!data?.data) return [];
    const items: TimelineItem[] = [];
    for (const email of data.data.emails ?? []) {
      items.push({ type: 'email', timestamp: email.receivedAt, data: email });
    }
    for (const comment of data.data.comments ?? []) {
      items.push({ type: 'comment', timestamp: comment.createdAt, data: comment });
    }
    for (const se of scheduledEmails) {
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
      const accounts = accountsData ?? [];
      const defaultAccId = useUiStore.getState().defaultAccountId;
      const defaultAccount = defaultAccId ? accounts.find((a: any) => a.id === defaultAccId) : null;
      const synced = accounts.find((a: any) => a.lastSyncAt);
      const firstAccountId = defaultAccount?.id ?? synced?.id ?? accounts[0]?.id;
      // If the AI just dropped a fresh-email draft (no threadId), pre-fill the
      // compose window with its to / subject / body. Without this the AI's
      // payload would be ignored on a brand-new compose.
      const aiDraft = pendingDraft && !pendingDraft.threadId ? pendingDraft : null;
      return (
        <div className="flex h-full flex-col bg-surface">
          <div className="flex items-center border-b border-border px-5 pt-[30px] pb-2">
            <h2 className="flex h-7 items-center text-sm font-semibold text-text-primary">New Message</h2>
          </div>
          <div className="flex-1" />
          <ComposeInline
            mode="compose"
            accountId={firstAccountId}
            initialDraft={
              aiDraft
                ? {
                    body: aiDraft.body,
                    bodyHtml: aiDraft.bodyHtml,
                    to: aiDraft.to,
                    subject: aiDraft.subject,
                  }
                : undefined
            }
            aiOriginal={aiDraft?.aiOriginal}
            onClose={() => {
              setComposingNew(false);
              if (pendingDraft) setPendingDraft(null);
              setComposeExpanded(false);
            }}
            onExpandedChange={setComposeExpanded}
          />
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
        <div className="flex items-center justify-between border-b border-border px-5 pb-2 pt-[30px]">
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
  // Capture the set of unread emails the first time we render this thread,
  // and keep it stable while the user is still on it. Once they navigate to
  // a different thread, the snapshot resets.
  if (thread && newOnOpenSnapshot.current.threadId !== thread.id) {
    newOnOpenSnapshot.current = {
      threadId: thread.id,
      ids: new Set(
        (thread.emails ?? [])
          .filter((e: any) => !e.isRead)
          .map((e: any) => e.id),
      ),
    };
  }
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
      <div className="flex items-center justify-between border-b border-border px-5 pb-2 pt-[30px]">
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
              onClick={() => {
                updateThread.mutate({ id: thread.id, isArchived: true });
                setSelectedThread(null);
              }}
              className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-surface hover:text-text-primary"
              aria-label="Archive"
            >
              <Archive className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip content="Delete">
            <button
              onClick={() => {
                updateThread.mutate({ id: thread.id, isTrashed: true });
                setSelectedThread(null);
              }}
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
          {/* Mark this thread "done" for the Needs Response folder. Visible
              only when an open signal exists, so it disappears the moment
              the user dismisses (or replies / archives, which also dismiss). */}
          {needsResponseOpen?.open && (
            <Tooltip
              content={needsResponseOpen.reason ?? "Mark as done"}
            >
              <button
                onClick={async () => {
                  try {
                    await dismissNeedsResponse({ threadId: thread.id as Id<'threads'> });
                    toast.success('Marked as done');
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : 'Failed to dismiss');
                  }
                }}
                className="rounded-lg p-1.5 text-emerald-500 transition-colors hover:bg-emerald-50"
                aria-label="Mark as done"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )}
          {/* Block sender */}
          {thread.emails?.length > 0 && (() => {
            const senderEmail = thread.emails[thread.emails.length - 1]?.fromAddress;
            if (!senderEmail) return null;
            const senderDomain = senderEmail.split('@')[1];
            const senderEmailLc = senderEmail.toLowerCase();
            const senderDomainLc = senderDomain?.toLowerCase();
            const addressBlock = blockedSenders?.find(
              (b) => b.emailAddress && b.emailAddress.toLowerCase() === senderEmailLc,
            );
            const domainBlock = blockedSenders?.find(
              (b) => b.domain && b.domain.toLowerCase() === senderDomainLc,
            );
            const isBlocked = !!(addressBlock || domainBlock);
            const runBlock = (mode: 'address' | 'domain') => {
              const payload = mode === 'domain'
                ? { domain: senderDomain, reason: `Blocked from thread: ${thread.subject}` }
                : { emailAddress: senderEmail, reason: `Blocked from thread: ${thread.subject}` };
              blockSender.mutate(payload, {
                onSuccess: () => {
                  toast.success(
                    mode === 'domain'
                      ? `Blocked all senders @${senderDomain}`
                      : `Blocked ${senderEmail}`,
                  );
                  updateThread.mutate({ id: thread.id, isTrashed: true });
                  setBlockOpen(false);
                  setSelectedThread(null);
                },
                onError: (err: any) => {
                  toast.error(err?.message ?? 'Failed to block sender');
                },
              });
            };
            const runUnblock = (id: string, label: string) => {
              unblockSender.mutate(id, {
                onSuccess: () => {
                  toast.success(`Unblocked ${label}`);
                  setBlockOpen(false);
                },
                onError: (err: any) => {
                  toast.error(err?.message ?? 'Failed to unblock');
                },
              });
            };
            return (
              <>
                <Tooltip content={isBlocked ? 'Sender is blocked' : 'Block sender'}>
                  <button
                    onClick={() => setBlockOpen(true)}
                    className={cn(
                      'rounded-lg p-1.5 transition-colors',
                      isBlocked
                        ? 'bg-red-50 text-red-500 hover:bg-red-100'
                        : 'text-text-tertiary hover:bg-red-50 hover:text-red-500',
                    )}
                    aria-label={isBlocked ? 'Sender is blocked' : 'Block sender'}
                    aria-pressed={isBlocked}
                  >
                    <ShieldBan className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                <Dialog.Root open={blockOpen} onOpenChange={setBlockOpen}>
                  <Dialog.Portal>
                    <Dialog.Overlay className="fixed inset-0 z-50 bg-black/30 animate-in fade-in" />
                    <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-xl animate-in fade-in slide-in-from-bottom-4">
                      <div className="flex items-center gap-2">
                        <ShieldBan className="h-5 w-5 text-red-500" />
                        <Dialog.Title className="text-base font-semibold text-text-primary">
                          {isBlocked ? 'Sender is blocked' : 'Block sender'}
                        </Dialog.Title>
                      </div>
                      <Dialog.Description className="mt-2 text-sm text-text-secondary">
                        {isBlocked
                          ? 'This sender is currently blocked. Future emails are auto-trashed on sync.'
                          : 'Future emails from this sender will be auto-trashed on sync.'}
                      </Dialog.Description>

                      <div className="mt-4 space-y-2">
                        {addressBlock ? (
                          <button
                            onClick={() => runUnblock(addressBlock.id, senderEmail)}
                            disabled={unblockSender.isPending}
                            className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-red-200 bg-red-50/60 px-3 py-2.5 text-left transition-colors hover:border-red-300 disabled:opacity-50"
                          >
                            <span className="text-[12px] font-medium text-red-600">
                              Unblock this address
                            </span>
                            <span className="text-[11px] text-text-tertiary">
                              {senderEmail}
                            </span>
                          </button>
                        ) : (
                          <button
                            onClick={() => runBlock('address')}
                            disabled={blockSender.isPending}
                            className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-red-300 hover:bg-red-50/40 disabled:opacity-50"
                          >
                            <span className="text-[12px] font-medium text-text-primary">
                              Block this address only
                            </span>
                            <span className="text-[11px] text-text-tertiary">
                              {senderEmail}
                            </span>
                          </button>
                        )}
                        {senderDomain && (
                          domainBlock ? (
                            <button
                              onClick={() => runUnblock(domainBlock.id, `@${senderDomain}`)}
                              disabled={unblockSender.isPending}
                              className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-red-200 bg-red-50/60 px-3 py-2.5 text-left transition-colors hover:border-red-300 disabled:opacity-50"
                            >
                              <span className="text-[12px] font-medium text-red-600">
                                Unblock this domain
                              </span>
                              <span className="text-[11px] text-text-tertiary">
                                @{senderDomain}
                              </span>
                            </button>
                          ) : (
                            <button
                              onClick={() => runBlock('domain')}
                              disabled={blockSender.isPending}
                              className="flex w-full flex-col items-start gap-0.5 rounded-lg border border-border px-3 py-2.5 text-left transition-colors hover:border-red-300 hover:bg-red-50/40 disabled:opacity-50"
                            >
                              <span className="text-[12px] font-medium text-text-primary">
                                Block everyone at this domain
                              </span>
                              <span className="text-[11px] text-text-tertiary">
                                @{senderDomain}
                              </span>
                            </button>
                          )
                        )}
                      </div>

                      <div className="mt-5 flex justify-end gap-2">
                        <Dialog.Close asChild>
                          <button className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface">
                            Close
                          </button>
                        </Dialog.Close>
                      </div>
                    </Dialog.Content>
                  </Dialog.Portal>
                </Dialog.Root>

                {/* Mark as spam — opens the sender-rule dialog in spam mode.
                    Distinct from Block (which auto-trashes future mail);
                    this routes future mail to the Spam folder so it's
                    still recoverable. */}
                <Tooltip content="Send to spam">
                  <button
                    onClick={() => setSpamRuleOpen(true)}
                    className="rounded-lg p-1.5 text-text-tertiary transition-colors hover:bg-amber-50 hover:text-amber-600"
                    aria-label="Send to spam"
                  >
                    <Ban className="h-3.5 w-3.5" />
                  </button>
                </Tooltip>
                {spamRuleOpen && senderEmail && (
                  <SenderRuleDialog
                    mode="spam"
                    targetCategoryLabel="Spam"
                    senderAddress={senderEmail}
                    onChoose={(kind) => {
                      const lastEmail = thread.emails?.[thread.emails.length - 1];
                      if (!lastEmail) return;
                      const domain = senderEmail.split('@')[1] ?? '';
                      const pattern = kind === 'email' ? senderEmail : `@${domain}`;
                      triageFeedback.mutate({
                        emailId: lastEmail.id,
                        threadId: thread.id,
                        suggestedCategory: 'primary',
                        finalCategory: 'spam',
                        wasConfirmed: false,
                        allowPattern: pattern,
                        allowKind: kind,
                      });
                      setSpamRuleOpen(false);
                      setSelectedThread(null);
                    }}
                    onSkip={() => {
                      const lastEmail = thread.emails?.[thread.emails.length - 1];
                      if (!lastEmail) return;
                      triageFeedback.mutate({
                        emailId: lastEmail.id,
                        threadId: thread.id,
                        suggestedCategory: 'primary',
                        finalCategory: 'spam',
                        wasConfirmed: false,
                      });
                      setSpamRuleOpen(false);
                      setSelectedThread(null);
                    }}
                    onCancel={() => setSpamRuleOpen(false)}
                  />
                )}
              </>
            );
          })()}
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
        senderAddress={thread.emails?.[thread.emails.length - 1]?.fromAddress}
      />

      {/* Timeline: emails + comments merged */}
      <ScrollArea.Root className="min-h-0 flex-1">
        <ScrollArea.Viewport ref={scrollViewportRef} className="h-full w-full">
          <div className="bg-surface p-3">
            {timeline.length === 0 && data?.data && (
              <BlankThreadAutoFix threadId={selectedThreadId as Id<'threads'>} />
            )}
            {timeline.map((item) => {
              if (item.type === 'email') {
                const email = item.data;
                const senderName = resolveName(email.fromAddress, email.fromName);
                const color = getAvatarColor(senderName);
                const accentColor = getSenderAccent(email.fromAddress, user?.email);

                return (
                  <div
                    key={email.id}
                    className="relative mb-2 rounded-xl bg-white px-5 py-4 shadow-sm"
                    style={accentColor ? { borderLeftWidth: '2px', borderLeftColor: accentColor + '60' } : undefined}
                  >

                    {/* Email header */}
                    {(() => {
                      const isExpanded = expandedHeaderIds.has(email.id);
                      const toList = (email.toAddresses as any[]) ?? [];
                      const ccList = (email.ccAddresses as any[]) ?? [];
                      return (
                        <div className="mb-3">
                          <div
                            role="button"
                            tabIndex={0}
                            onClick={() => toggleExpandedHeader(email.id)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                toggleExpandedHeader(email.id);
                              }
                            }}
                            className="-mx-2 flex cursor-pointer items-start justify-between rounded-lg px-2 py-1 transition-colors hover:bg-surface/60"
                          >
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
                                  className="text-[13px] font-semibold text-text-primary transition-colors hover:text-primary"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setContactCardEmail(email.fromAddress);
                                    setContactCardAnchor((e.currentTarget as HTMLElement).getBoundingClientRect());
                                  }}
                                >
                                  {senderName}
                                </button>
                                <span className="ml-2 text-[11px] text-text-tertiary">
                                  to{' '}
                                  {toList.map((a: any) => a.name || a.email).join(', ') || '—'}
                                </span>
                                <ChevronDown
                                  className={cn(
                                    'ml-1 inline-block h-3 w-3 align-middle text-text-tertiary transition-transform',
                                    isExpanded && 'rotate-180',
                                  )}
                                />
                              </div>
                            </div>
                            <div className="ml-3 flex shrink-0 items-center gap-1.5">
                              <span className="text-[11px] text-text-tertiary">
                                {formatExactTime(email.receivedAt)}
                              </span>
                              {newOnOpenSnapshot.current.ids.has(email.id) && (
                                <span
                                  className="h-1.5 w-1.5 rounded-full bg-red-500"
                                  title="New in this thread"
                                />
                              )}
                            </div>
                          </div>

                          {isExpanded && (
                            <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
                              <span className="font-medium text-text-tertiary">From</span>
                              <div className="flex flex-wrap gap-1.5">
                                <AddressChip
                                  name={email.fromName || senderName}
                                  email={email.fromAddress}
                                  onCopy={copyAddress}
                                />
                              </div>

                              <span className="font-medium text-text-tertiary">To</span>
                              <div className="flex flex-wrap gap-1.5">
                                {toList.length > 0 ? (
                                  toList.map((a: any, i: number) => (
                                    <AddressChip
                                      key={`${a.email}-${i}`}
                                      name={a.name}
                                      email={a.email}
                                      onCopy={copyAddress}
                                    />
                                  ))
                                ) : (
                                  <span className="text-text-tertiary">—</span>
                                )}
                              </div>

                              {ccList.length > 0 && (
                                <>
                                  <span className="font-medium text-text-tertiary">Cc</span>
                                  <div className="flex flex-wrap gap-1.5">
                                    {ccList.map((a: any, i: number) => (
                                      <AddressChip
                                        key={`${a.email}-${i}`}
                                        name={a.name}
                                        email={a.email}
                                        onCopy={copyAddress}
                                      />
                                    ))}
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    {/* Email body — with quoted content collapsed */}
                    <CollapsedEmailBody
                      bodyHtml={email.bodyHtml}
                      bodyText={email.bodyText}
                      highlightText={highlightText}
                      emailId={email.id}
                      attachments={email.attachments ?? []}
                      onImageClick={isMobile ? (src, alt) => setLightboxImage({ src, alt }) : undefined}
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
                const recipients = (se.toAddresses as any[])
                  ?.map((a: any) => a.name || a.email)
                  .join(', ');

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
                            to: (se.toAddresses as any[])?.map((a: any) => a.email).join(', '),
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
                                  to: (se.toAddresses as any[])?.map((a: any) => a.email).join(', '),
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
      <div
        className={cn(
          'flex flex-col border-t border-border bg-white',
          replyMode && composeExpanded && 'min-h-0',
        )}
        style={replyMode && composeExpanded ? { flex: '999 1 0%' } : undefined}
      >
        {replyMode ? (
          <ComposeInline
            threadId={thread.id}
            lastEmailId={thread.emails?.[thread.emails.length - 1]?.id}
            accountId={(() => {
              // Smart reply-from: find which of the user's accounts was in the To/CC of the last email
              const lastEmail = thread.emails?.[thread.emails.length - 1];
              if (!lastEmail) return thread.accountId;
              const allAccounts = accountsData ?? [];
              const recipientEmails = [
                ...(lastEmail.toAddresses as any[] ?? []),
                ...(lastEmail.ccAddresses as any[] ?? []),
              ].map((a: any) => a?.email?.toLowerCase()).filter(Boolean);
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
              setComposeExpanded(false);
            }}
            onExpandedChange={setComposeExpanded}
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
                    to: (savedDraftEmail.toAddresses as any[])?.map((a: any) => a.email).join(', ') || '',
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
              const lastEmail = thread.emails?.[thread.emails.length - 1];
              if (!lastEmail) return [];
              // Only exclude the address this email was delivered to — i.e. the
              // mailAccount tied to the thread. Other connected accounts
              // (shared team inboxes, alt personal accounts) stay in the
              // reply-all list since the user is replying *as* this specific
              // account and the others may genuinely belong on the thread.
              const excluded = new Set<string>();
              const receivingAccount = (accountsData ?? []).find(
                (a: any) => a.id === thread.accountId,
              );
              if (receivingAccount?.email) {
                excluded.add(receivingAccount.email.toLowerCase());
              }
              // Also exclude every send-as alias on the receiving account —
              // these are inbox forwards the user owns (e.g.
              // bryce@choquercreative.com forwarded to bryce@choquer.agency).
              // Without this they'd end up in their own reply-all To row.
              for (const alias of (receivingAccount?.aliases ?? []) as string[]) {
                if (alias) excluded.add(alias.toLowerCase());
              }
              const all: { email: string; name?: string }[] = [];
              if (lastEmail.fromAddress && !excluded.has(lastEmail.fromAddress.toLowerCase())) {
                all.push({ email: lastEmail.fromAddress, name: lastEmail.fromName || undefined });
              }
              for (const addr of [...(lastEmail.toAddresses as any[] ?? []), ...(lastEmail.ccAddresses as any[] ?? [])]) {
                if (addr?.email && !excluded.has(addr.email.toLowerCase()) && !all.some((a) => a.email === addr.email)) {
                  all.push({ email: addr.email, name: addr.name || undefined });
                }
              }
              return all;
            })()}
            fromEmail={(() => {
              // Match fromEmail to the smart reply-from account
              const lastEmail = thread.emails?.[thread.emails.length - 1];
              const allAccounts = accountsData ?? [];
              if (lastEmail) {
                const recipientEmails = [
                  ...(lastEmail.toAddresses as any[] ?? []),
                  ...(lastEmail.ccAddresses as any[] ?? []),
                ].map((a: any) => a?.email?.toLowerCase()).filter(Boolean);
                const matched = allAccounts.find((a: any) =>
                  recipientEmails.includes(a.email?.toLowerCase()),
                );
                if (matched) return matched.email;
              }
              return allAccounts.find((a: any) => a.id === thread.accountId)?.email;
            })()}
          />
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
      />
    </div>
  );
}
