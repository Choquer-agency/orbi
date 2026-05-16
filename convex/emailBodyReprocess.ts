"use node";

// ─────────────────────────────────────────────────────────────────────────────
// emailBodyReprocess.ts
//
// Re-runs `preprocessEmailBody` against every email in `emailBodies` so that
// bodyHtmlClean / bodyHtmlTrimmed / hasQuotedHistory / isForwarded reflect
// the *current* preprocessor implementation.
//
// Use this after changing trim rules, quoted-history detection, forwarded
// detection, or sanitize rules so existing data renders the same way new
// inbound mail does.
//
// Safety: paginates 1 row at a time (bodies can be MBs). Self-terminates
// after ~1500 emails per `runAll`; re-run with returned cursor if !done.
//
// Usage:
//   npx convex run emailBodyReprocess:runAll
//   npx convex run emailBodyReprocess:runAll '{"cursor":"..."}'
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { preprocessEmailBody } from "./lib/emailPreprocess";
// Query/mutation defs live in the V8 sibling (./emailBodyReprocessData.ts)
// because Convex disallows queries inside "use node" files. Reference them
// via the generated internal API.


export const run = internalAction({
  args: { cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    { cursor },
  ): Promise<{
    processed: number;
    skipped: number;
    cursor: string;
    remaining: boolean;
  }> => {
    const page = (await ctx.runQuery(
      internal.emailBodyReprocessData._page,
      { cursor },
    )) as {
      rows: Array<{ bodyId: Id<"emailBodies">; emailId: Id<"emails"> }>;
      cursor: string;
      isDone: boolean;
    };

    let processed = 0;
    let skipped = 0;
    for (const row of page.rows) {
      try {
        const src = (await ctx.runQuery(
          internal.emailBodyReprocessData._getSource,
          { bodyId: row.bodyId, emailId: row.emailId },
        )) as {
          bodyHtml?: string;
          bodyText?: string;
          subject?: string;
        } | null;
        if (!src || !src.bodyHtml) {
          skipped++;
          continue;
        }
        const pre = preprocessEmailBody(src.bodyHtml, src.bodyText, src.subject);
        await ctx.runMutation(internal.emailBodyReprocessData._writeBack, {
          bodyId: row.bodyId,
          emailId: row.emailId,
          bodyHtmlClean: pre.bodyHtmlClean,
          bodyHtmlTrimmed: pre.bodyHtmlTrimmed,
          hasQuotedHistory: pre.hasQuotedHistory,
          isForwarded: pre.isForwarded,
        });
        processed++;
      } catch (e) {
        skipped++;
        console.warn("emailBodyReprocess: failed for", row.bodyId, e);
      }
    }
    return {
      processed,
      skipped,
      cursor: page.cursor,
      remaining: !page.isDone,
    };
  },
});

export const runAll = internalAction({
  args: { cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    { cursor: initialCursor },
  ): Promise<{
    total: number;
    skipped: number;
    done: boolean;
    cursor: string | undefined;
  }> => {
    let total = 0;
    let totalSkipped = 0;
    let cursor: string | undefined = initialCursor;
    // Keep each invocation small so it returns within Convex's action time
    // ceiling. 60 batches × 4 rows/batch = ~240 emails per call.
    for (let i = 0; i < 60; i++) {
      const r = (await ctx.runAction(internal.emailBodyReprocess.run, {
        cursor,
      })) as {
        processed: number;
        skipped: number;
        cursor: string;
        remaining: boolean;
      };
      total += r.processed;
      totalSkipped += r.skipped;
      cursor = r.cursor;
      if (!r.remaining) return { total, skipped: totalSkipped, done: true, cursor };
    }
    return { total, skipped: totalSkipped, done: false, cursor };
  },
});


