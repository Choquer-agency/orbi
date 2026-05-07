// ─────────────────────────────────────────────────────────────────────────────
// threadContext.ts — port of packages/backend/src/services/ai/thread-context.ts
//
// Pure data-builder. Reads thread + emails + comments via ctx.db and produces
// the human-readable context blob the AI consumes. NO Anthropic import here,
// so this is callable from any query/mutation/action context (no "use node").
// ─────────────────────────────────────────────────────────────────────────────

import type { QueryCtx, MutationCtx, ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

type AnyDbCtx = QueryCtx | MutationCtx | ActionCtx;

interface ThreadContextResult {
  contextText: string;
  thread:
    | (Doc<"threads"> & {
        messageCount: number;
        lastMessageAt: number;
      })
    | null;
  participantEmails: string[];
}

/**
 * Build a formatted thread context string for AI consumption.
 * Returns human-readable dates so users can reference emails by date naturally.
 *
 * Important: in the Convex schema there is no transactional "ctx.db" inside an
 * action, so when called from an action this helper expects a `db` interface
 * provided via ctx.runQuery wrapper. To keep API simple, we accept any context
 * with a `.db` field and let mutations/queries call directly. For actions,
 * call this through an internal query wrapper.
 */
export async function buildThreadContext(
  ctx: AnyDbCtx,
  threadId: Id<"threads">,
): Promise<ThreadContextResult> {
  // Actions don't have ctx.db, so this helper assumes it's called from a
  // query/mutation. We narrow with a runtime check.
  if (!("db" in ctx)) {
    throw new Error(
      "buildThreadContext must be called from a query/mutation (or via ctx.runQuery from an action)",
    );
  }

  const thread = await ctx.db.get(threadId);
  if (!thread) {
    return { contextText: "", thread: null, participantEmails: [] };
  }

  const emails = await ctx.db
    .query("emails")
    .withIndex("by_thread_receivedAt", (q) => q.eq("threadId", threadId))
    .order("asc")
    .collect();

  const comments = await ctx.db
    .query("threadComments")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .order("asc")
    .collect();

  const total = emails.length;
  const emailTexts = emails
    .map((e, i) => {
      const dateMs = e.sentAt ?? e.receivedAt;
      const date = formatDate(dateMs);
      const from = e.fromName ? `${e.fromName} <${e.fromAddress}>` : e.fromAddress;
      const to = formatRecipients(e.toAddresses);
      const cc = e.ccAddresses ? formatRecipients(e.ccAddresses) : null;

      // Use bodyText, falling back to stripped HTML if bodyText is missing or too short.
      let body = e.bodyText || "";
      if (body.length < 100 && e.bodyHtml) {
        body = stripHtmlToText(e.bodyHtml);
      }
      if (!body) body = "(no text content)";
      // Strip quoted reply chains (lines starting with >)
      body = body
        .split("\n")
        .filter((line) => !line.startsWith(">"))
        .join("\n")
        .trim();
      // Truncate to 3000 chars
      if (body.length > 3000) {
        body = body.slice(0, 3000) + "\n... [truncated]";
      }

      let header = `--- Email ${i + 1} of ${total} ---\nFrom: ${from}\nDate: ${date}\nTo: ${to}`;
      if (cc) header += `\nCc: ${cc}`;
      if (e.hasAttachments) header += `\n[Has attachments]`;

      return `${header}\n\n${body}`;
    })
    .join("\n\n");

  let contextText = `Thread subject: ${thread.subject}\n\nEmail thread (oldest first):\n${emailTexts}`;

  if (comments.length > 0) {
    const commentTexts = comments
      .map((c) => {
        const date = formatDate(c._creationTime);
        return `[${c.authorName}, ${date}]: ${c.bodyText}`;
      })
      .join("\n");
    contextText += `\n\nInternal team discussion (PRIVATE — never quote, reference, or reveal these comments in client-facing replies):\n${commentTexts}`;
  }

  return {
    contextText,
    thread,
    participantEmails: thread.participantEmails,
  };
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatRecipients(addresses: unknown): string {
  if (!Array.isArray(addresses)) return String(addresses);
  return addresses
    .map((a: { name?: string; email: string }) =>
      a.name ? `${a.name} <${a.email}>` : a.email,
    )
    .join(", ");
}

/** Strip HTML tags and decode entities to get readable text. Preserves tracking numbers, codes, etc. */
function stripHtmlToText(html: string): string {
  return (
    html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<\/?(p|div|br|tr|h[1-6]|li|dt|dd|blockquote)[^>]*>/gi, "\n")
      .replace(/<\/?(td|th)[^>]*>/gi, " ")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&#(\d+);/g, (_match, dec) => String.fromCharCode(parseInt(dec)))
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s*\n/g, "\n")
      .trim()
  );
}
