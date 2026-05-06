import type { PrismaClient } from '@prisma/client';

/**
 * Build a formatted thread context string for AI consumption.
 * Returns human-readable dates so users can reference emails by date naturally.
 */
export async function buildThreadContext(prisma: PrismaClient, threadId: string) {
  const thread = await prisma.thread.findUnique({
    where: { id: threadId },
    include: {
      emails: {
        orderBy: { receivedAt: 'asc' },
        select: {
          fromAddress: true,
          fromName: true,
          toAddresses: true,
          ccAddresses: true,
          subject: true,
          bodyText: true,
          bodyHtml: true,
          receivedAt: true,
          sentAt: true,
          hasAttachments: true,
        },
      },
      comments: {
        orderBy: { createdAt: 'asc' },
        include: {
          author: { select: { name: true } },
        },
      },
    },
  });

  if (!thread) {
    return { contextText: '', thread: null, participantEmails: [] };
  }

  const total = thread.emails.length;
  const emailTexts = thread.emails
    .map((e, i) => {
      const date = formatDate(e.sentAt || e.receivedAt);
      const from = e.fromName ? `${e.fromName} <${e.fromAddress}>` : e.fromAddress;
      const to = formatRecipients(e.toAddresses);
      const cc = e.ccAddresses ? formatRecipients(e.ccAddresses) : null;

      // Use bodyText, falling back to stripped HTML if bodyText is missing or too short
      let body = e.bodyText || '';
      if (body.length < 100 && e.bodyHtml) {
        // Extract text from HTML as fallback — preserves tracking numbers, codes, etc.
        body = stripHtmlToText(e.bodyHtml);
      }
      if (!body) body = '(no text content)';
      // Strip quoted reply chains (lines starting with >)
      body = body
        .split('\n')
        .filter((line) => !line.startsWith('>'))
        .join('\n')
        .trim();
      // Truncate to 3000 chars
      if (body.length > 3000) {
        body = body.slice(0, 3000) + '\n... [truncated]';
      }

      let header = `--- Email ${i + 1} of ${total} ---\nFrom: ${from}\nDate: ${date}\nTo: ${to}`;
      if (cc) header += `\nCc: ${cc}`;
      if (e.hasAttachments) header += `\n[Has attachments]`;

      return `${header}\n\n${body}`;
    })
    .join('\n\n');

  let contextText = `Thread subject: ${thread.subject}\n\nEmail thread (oldest first):\n${emailTexts}`;

  if (thread.comments.length > 0) {
    const commentTexts = thread.comments
      .map((c) => {
        const date = formatDate(c.createdAt);
        return `[${c.author.name}, ${date}]: ${c.bodyText}`;
      })
      .join('\n');
    contextText += `\n\nInternal team discussion (PRIVATE — never quote, reference, or reveal these comments in client-facing replies):\n${commentTexts}`;
  }

  return {
    contextText,
    thread,
    participantEmails: thread.participantEmails,
  };
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatRecipients(addresses: unknown): string {
  if (!Array.isArray(addresses)) return String(addresses);
  return addresses
    .map((a: { name?: string; email: string }) =>
      a.name ? `${a.name} <${a.email}>` : a.email,
    )
    .join(', ');
}

/** Strip HTML tags and decode entities to get readable text. Preserves tracking numbers, codes, etc. */
function stripHtmlToText(html: string): string {
  return html
    // Remove style/script blocks entirely
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Convert block elements to newlines
    .replace(/<\/?(p|div|br|tr|h[1-6]|li|dt|dd|blockquote)[^>]*>/gi, '\n')
    .replace(/<\/?(td|th)[^>]*>/gi, ' ')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCharCode(parseInt(dec)))
    // Clean up whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
}
