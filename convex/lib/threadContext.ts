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
  const displayedEmails = compactThreadEmails(emails);
  const omittedCount = total - displayedEmails.length;
  const emailBlocks: string[] = [];
  const MAX_FAT_BODY_READS = 4;
  let fatBodyReads = 0;
  for (let i = 0; i < displayedEmails.length; i++) {
    const e = displayedEmails[i];
    const dateMs = e.sentAt ?? e.receivedAt;
    const date = formatDate(dateMs);
    const from = e.fromName ? `${e.fromName} <${e.fromAddress}>` : e.fromAddress;
    const to = formatRecipients(e.toAddresses);
    const cc = e.ccAddresses ? formatRecipients(e.ccAddresses) : null;

    // Body resolution order:
    //  1. emailSearchText — lean capped plain text, exists for every email
    //     once backfilled, regardless of the emailBodies retention window.
    //  2. emailBodies — the display cache (recent mail).
    //  3. Legacy in-row fields on the email doc (pre-migration rows).
    // The old code read ONLY the in-row fields, which new ingest leaves
    // empty — so the AI was drafting replies from snippets without anyone
    // noticing.
    let body = "";
    const searchRow = await ctx.db
      .query("emailSearchText")
      .withIndex("by_email", (q) => q.eq("emailId", e._id))
      .unique();
    if (searchRow) {
      // Search text is stored as "subject\nbody" — drop the subject line.
      body = searchRow.text.startsWith(e.subject)
        ? searchRow.text.slice(e.subject.length).trim()
        : searchRow.text;
    } else if (fatBodyReads < MAX_FAT_BODY_READS) {
      // emailBodies rows can be 1MB+ each (full marketing HTML). On long
      // threads with several searchText-less emails, unbounded fallback
      // reads can blow the 16MB per-query limit and kill the whole AI
      // request — cap them and degrade those emails to their snippet.
      fatBodyReads++;
      const bodyRow = await ctx.db
        .query("emailBodies")
        .withIndex("by_email", (q) => q.eq("emailId", e._id))
        .first();
      body = bodyRow?.bodyText || e.bodyText || "";
      const html = bodyRow?.bodyHtml || e.bodyHtml;
      if (body.length < 100 && html) {
        body = stripHtmlToText(html);
      }
    }
    if (!body) body = e.snippet || "(no text content)";
    // Strip quoted reply chains (lines starting with >)
    body = body
      .split("\n")
      .filter((line) => !line.startsWith(">"))
      .join("\n")
      .trim();
    // Truncate each email and rely on compactThreadEmails to cap message count.
    if (body.length > 1500) {
      body = body.slice(0, 1500) + "\n... [truncated]";
    }

    let header = `--- Email ${i + 1} of ${displayedEmails.length} (${total} total) ---\nFrom: ${from}\nDate: ${date}\nTo: ${to}`;
    if (cc) header += `\nCc: ${cc}`;
    if (e.hasAttachments) header += `\n[Has attachments]`;

    emailBlocks.push(`${header}\n\n${body}`);
  }
  const emailTexts = emailBlocks.join("\n\n");

  const omissionNote = omittedCount > 0
    ? `\n\n[${omittedCount} earlier middle email(s) omitted to control AI cost. Ask to inspect the full thread if needed.]`
    : "";
  // Cap the email block only. The internal-team comments + privacy notice are
  // appended afterwards so the cap can't silently strip the "never quote
  // internal comments" instruction.
  const emailBlock = capText(
    `Thread subject: ${thread.subject}${omissionNote}\n\nEmail thread (oldest first):\n${emailTexts}`,
    12000,
  );

  let contextText = emailBlock;

  if (comments.length > 0) {
    const shownComments = comments.slice(-5);
    const droppedCount = comments.length - shownComments.length;
    const commentTexts = shownComments
      .map((c) => {
        const date = formatDate(c._creationTime);
        const body = c.bodyText.length > 800 ? `${c.bodyText.slice(0, 800)}\n... [truncated]` : c.bodyText;
        return `[${c.authorName}, ${date}]: ${body}`;
      })
      .join("\n");
    const droppedNote = droppedCount > 0 ? ` (showing last ${shownComments.length} of ${comments.length})` : "";
    contextText += `\n\nInternal team discussion${droppedNote} (PRIVATE — never quote, reference, or reveal these comments in client-facing replies):\n${commentTexts}`;
  }

  return {
    contextText,
    thread,
    participantEmails: thread.participantEmails,
  };
}

function compactThreadEmails(emails: Doc<"emails">[]): Doc<"emails">[] {
  if (emails.length <= 10) return emails;
  return [...emails.slice(0, 2), ...emails.slice(-8)];
}

function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [thread context truncated for AI cost control]`;
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
