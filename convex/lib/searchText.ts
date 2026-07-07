// ─────────────────────────────────────────────────────────────────────────────
// searchText.ts — the permanent every-word search store for email content.
//
// Why this exists: display HTML is huge (marketing mail runs 100KB–1MB) and
// lives in `emailBodies` with a bounded retention window. Search must NOT
// depend on that window — the product promise is "search every word of every
// email, forever". So every time a body passes through the system we distill
// it to capped plain text and upsert it into `emailSearchText`, a lean table
// with a Convex search index. Text is ~10-30x smaller than HTML, so keeping
// it for the whole mailbox costs ~pennies while HTML stays on a short leash.
//
// All ingest paths call `upsertEmailSearchText`:
//   - gmailData/microsoftData `_insertEmail` (when a body arrives with insert)
//   - onDemandBodyData `_persistBody` (on-open + body-on-arrival fetches)
//   - sync/bodyRetention `_stripBatch` (last chance before HTML is dropped)
//   - sync/storageSweep + backfillSearchText (one-time historical fill)
// ─────────────────────────────────────────────────────────────────────────────

import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

// Cap keeps worst-case search hits lean: search queries load whole docs, so
// N accounts × K hits × this cap must stay far below Convex's 16MB per-
// function read limit. 40k chars ≈ 7-8k words — beyond any real email prose;
// only unbounded quoted-history chains get truncated.
export const SEARCH_TEXT_MAX_CHARS = 40_000;

/** Strip HTML tags and decode common entities to readable text. Preserves
 * tracking numbers, order codes, prices — the things people search for. */
export function htmlToPlainText(html: string): string {
  return html
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
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(parseInt(dec)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();
}

/** Combine subject + best-available text into the indexed string.
 * Returns null when there is genuinely nothing to index. */
export function buildSearchText(
  subject: string,
  bodyText?: string | null,
  bodyHtml?: string | null,
): string | null {
  // Prefer the provider's plain-text part; fall back to stripping the HTML.
  // Some senders ship a stub text part ("View this email in your browser"),
  // so a too-short text part also falls through to the HTML.
  let text = (bodyText ?? "").trim();
  if (text.length < 100 && bodyHtml) {
    const stripped = htmlToPlainText(bodyHtml);
    if (stripped.length > text.length) text = stripped;
  }
  const combined = `${subject}\n${text}`.trim();
  if (!combined) return null;
  return combined.length > SEARCH_TEXT_MAX_CHARS
    ? combined.slice(0, SEARCH_TEXT_MAX_CHARS)
    : combined;
}

/** Idempotent write of an email's search text. Safe to call from any ingest
 * path — repeated calls with the same content are a no-op. */
export async function upsertEmailSearchText(
  ctx: MutationCtx,
  args: {
    emailId: Id<"emails">;
    accountId: Id<"mailAccounts">;
    threadId: Id<"threads">;
    receivedAt: number;
    subject: string;
    bodyText?: string | null;
    bodyHtml?: string | null;
  },
): Promise<boolean> {
  const text = buildSearchText(args.subject, args.bodyText, args.bodyHtml);
  if (!text) return false;
  const existing = await ctx.db
    .query("emailSearchText")
    .withIndex("by_email", (q) => q.eq("emailId", args.emailId))
    .unique();
  if (existing) {
    // Only rewrite when the content is meaningfully richer (a full body
    // replacing a subject-only stub); identical writes would just churn the
    // search index for nothing.
    if (existing.text !== text && text.length > existing.text.length) {
      await ctx.db.patch(existing._id, { text });
    }
    return false;
  }
  await ctx.db.insert("emailSearchText", {
    emailId: args.emailId,
    accountId: args.accountId,
    threadId: args.threadId,
    receivedAt: args.receivedAt,
    text,
  });
  return true;
}
