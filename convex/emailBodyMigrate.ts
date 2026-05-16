"use node";

// ─────────────────────────────────────────────────────────────────────────────
// emailBodyMigrate.ts
//
// One-shot migration that moves legacy in-row email bodies into the
// `emailBodies` sibling table and applies the server-side preprocessor.
//
// Safety:
// - Iterates `emails` in tiny pages (default 5) so even rows with very large
//   bodyHtmls stay well under Convex's 16 MiB byte-read limit.
// - Per-email writes go through a single mutation so they're atomic and
//   short-lived (no batched mutations).
// - `runAll` self-terminates after 200 batches (~1k emails) per invocation;
//   re-run if it returns `done: false`.
//
// Usage:
//   npx convex run emailBodyMigrate:runAll
//   npx convex run emailBodyMigrate:runAll '{"batchSize":5}'
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { preprocessEmailBody } from "./lib/emailPreprocess";

export const run = internalAction({
  args: {
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { cursor }) => {
    const page = (await ctx.runQuery(
      internal.emailBodyMigrateData._pageEmails,
      { cursor },
    )) as {
      rows: Array<{ id: Id<"emails">; needsMigration: boolean }>;
      cursor: string;
      isDone: boolean;
    };

    let processed = 0;
    let skipped = 0;
    for (const row of page.rows) {
      if (!row.needsMigration) continue;
      try {
        // Fetch the legacy in-row body for this single email only.
        const body = (await ctx.runQuery(
          internal.emailBodyMigrateData._getInRowBody,
          { emailId: row.id },
        )) as {
          bodyHtml?: string;
          bodyText?: string;
          subject?: string;
        } | null;
        if (!body) {
          skipped++;
          continue;
        }
        const pre = preprocessEmailBody(
          body.bodyHtml,
          body.bodyText,
          body.subject,
        );
        await ctx.runMutation(
          internal.emailBodyMigrateData._migrateOne,
          {
            emailId: row.id,
            bodyText: body.bodyText,
            bodyHtml: body.bodyHtml,
            bodyHtmlClean: pre.bodyHtmlClean,
            bodyHtmlTrimmed: pre.bodyHtmlTrimmed,
            hasQuotedHistory: pre.hasQuotedHistory,
            isForwarded: pre.isForwarded,
          },
        );
        processed++;
      } catch (e) {
        skipped++;
        console.warn("emailBodyMigrate: failed for", row.id, e);
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
    // Each iteration reads + migrates exactly one email. Hard cap so we
    // stay inside the action runtime ceiling; re-run with the returned
    // cursor if !done.
    for (let i = 0; i < 1500; i++) {
      const r = (await ctx.runAction(internal.emailBodyMigrate.run, {
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
      if (!r.remaining)
        return { total, skipped: totalSkipped, done: true, cursor };
    }
    return { total, skipped: totalSkipped, done: false, cursor };
  },
});
