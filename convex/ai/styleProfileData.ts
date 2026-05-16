// styleProfileData.ts — data-layer queries/mutations for the auto-learned
// writing profile. Reads sent emails from every account the user owns,
// strips quoted history, and returns clean plaintext samples for the
// style-profile builder action to summarise.
//
// All reads use indexes and tight `take()` caps so we never trip the
// 16 MiB byte-read limit even if a user has GB-sized sent folders.

import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
} from "../_generated/server";
import { requireUser } from "../lib/auth";

const SAMPLES_PER_ACCOUNT = 25; // 25 × ~5 accounts → 125 samples max
const MAX_BODY_CHARS = 2000;

// ─────────────────────────────────────────────────────────────────────────────
// Discovery: list the user's mail accounts.
// ─────────────────────────────────────────────────────────────────────────────
export const _listUserAccounts = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const rows = await ctx.db
      .query("mailAccounts")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.map((a) => ({ id: a._id, email: a.email }));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Pull the most recent SENT emails for one account.
//
// Sent emails are those where:
//   - the user authored them (fromAddress === account.email), OR
//   - labels include "SENT" (Gmail label, also set on our outbox writes)
//
// We grab metadata in bounded batches and then fetch each body from
// `emailBodies` one at a time (so a single huge body can't blow the limit).
// Bodies that don't exist on the sibling table fall back to the in-row copy.
// ─────────────────────────────────────────────────────────────────────────────
export const _sampleSentMetadata = internalQuery({
  args: {
    accountId: v.id("mailAccounts"),
    accountEmail: v.string(),
  },
  handler: async (ctx, { accountId, accountEmail }) => {
    // by_account_fromAddress is the tightest index for "messages I wrote".
    const fromMine = await ctx.db
      .query("emails")
      .withIndex("by_account_fromAddress", (q) =>
        q.eq("accountId", accountId).eq("fromAddress", accountEmail),
      )
      .order("desc")
      .take(SAMPLES_PER_ACCOUNT * 2); // headroom in case some are drafts
    return fromMine
      .filter((e) => !e.isDraft)
      .slice(0, SAMPLES_PER_ACCOUNT)
      .map((e) => ({
        id: e._id,
        receivedAt: e.receivedAt,
        subject: e.subject,
        toCount: e.toAddresses?.length ?? 0,
        // hasBody flags help the action decide whether to fetch the body row.
        inlineBodyText: typeof e.bodyText === "string" ? e.bodyText.slice(0, MAX_BODY_CHARS) : "",
        inlineBodyHtml: typeof e.bodyHtml === "string" ? e.bodyHtml.slice(0, MAX_BODY_CHARS) : "",
      }));
  },
});

// One-at-a-time body fetch from the sibling table.
export const _getBody = internalQuery({
  args: { emailId: v.id("emails") },
  handler: async (ctx, { emailId }) => {
    const body = await ctx.db
      .query("emailBodies")
      .withIndex("by_email", (q) => q.eq("emailId", emailId))
      .unique();
    if (!body) return null;
    return {
      bodyText: (body.bodyText ?? "").slice(0, MAX_BODY_CHARS),
      bodyHtml: (body.bodyHtml ?? "").slice(0, MAX_BODY_CHARS),
      bodyHtmlTrimmed: (body.bodyHtmlTrimmed ?? "").slice(0, MAX_BODY_CHARS),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Upsert the resulting profile row.
// ─────────────────────────────────────────────────────────────────────────────
export const _upsertProfile = internalMutation({
  args: {
    userId: v.id("users"),
    summary: v.string(),
    bulletRules: v.array(v.string()),
    sampleSize: v.number(),
    accountsAnalysed: v.array(v.string()),
    commonGreetings: v.array(v.string()),
    commonSignOffs: v.array(v.string()),
    avgWords: v.optional(v.number()),
    inferredTone: v.optional(v.number()),
    inferredVerbosity: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("styleProfiles")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    const patch = {
      summary: args.summary,
      bulletRules: args.bulletRules,
      sampleSize: args.sampleSize,
      accountsAnalysed: args.accountsAnalysed,
      commonGreetings: args.commonGreetings,
      commonSignOffs: args.commonSignOffs,
      avgWords: args.avgWords,
      inferredTone: args.inferredTone,
      inferredVerbosity: args.inferredVerbosity,
      lastBuiltAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return existing._id;
    }
    return await ctx.db.insert("styleProfiles", { userId: args.userId, ...patch });
  },
});

// Look up cached profile (used by lib/styleContext.ts).
export const _getProfile = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    return await ctx.db
      .query("styleProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
  },
});

// Public read for the Settings UI.
export const getProfile = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    return await ctx.db
      .query("styleProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
  },
});
